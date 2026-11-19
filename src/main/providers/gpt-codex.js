'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

function getDefaultAuthPaths() {
  const paths = [];
  if (process.env.CODEX_HOME) {
    paths.push(path.join(process.env.CODEX_HOME, 'auth.json'));
  }
  paths.push(path.join(os.homedir(), '.codex', 'auth.json'));
  return paths;
}

function decodeJwtPayload(jwt) {
  if (!jwt || typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function parseCodexAuthJson(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tokens = raw.tokens && typeof raw.tokens === 'object' ? raw.tokens : raw;
  const accessToken = tokens.access_token || tokens.accessToken || null;
  const refreshToken = tokens.refresh_token || tokens.refreshToken || null;
  const accountId = tokens.account_id || tokens.accountId || raw.account_id || null;
  const idToken = tokens.id_token || tokens.idToken || null;
  const apiKey = raw.OPENAI_API_KEY || raw.api_key || null;

  const claims = decodeJwtPayload(idToken) || decodeJwtPayload(accessToken);
  const email = claims?.email || claims?.['https://api.openai.com/profile']?.email || null;
  const expMs = claims?.exp ? claims.exp * 1000 : null;

  return {
    accessToken,
    refreshToken,
    accountId,
    apiKey,
    email,
    expMs,
  };
}

function formatWindowLabel(seconds, fallback) {
  if (!seconds || typeof seconds !== 'number') return fallback;
  if (seconds <= 3600) return `${Math.round(seconds / 60)}분 한도`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}시간 한도`;
  const days = Math.round(seconds / 86400);
  if (days === 7) return '주간 한도 (7일)';
  return `${days}일 한도`;
}

function normalizeResetIso(win) {
  if (!win) return null;
  if (typeof win.reset_at === 'number') {
    const ms = win.reset_at > 1e12 ? win.reset_at : win.reset_at * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof win.reset_at === 'string') {
    return win.reset_at;
  }
  if (typeof win.reset_after_seconds === 'number') {
    return new Date(Date.now() + win.reset_after_seconds * 1000).toISOString();
  }
  return null;
}

function parseCodexUsageResponse(data, fallbackEmail = null) {
  const windows = [];
  const rl = data?.rate_limit || {};

  if (rl.primary_window) {
    const used = Math.max(0, Math.min(100, Number(rl.primary_window.used_percent ?? 0)));
    windows.push({
      id: 'primary',
      label: formatWindowLabel(rl.primary_window.limit_window_seconds, '5시간 한도'),
      usedPercent: Number(used.toFixed(1)),
      remainingPercent: Number((100 - used).toFixed(1)),
      resetsAt: normalizeResetIso(rl.primary_window),
    });
  }

  if (rl.secondary_window) {
    const used = Math.max(0, Math.min(100, Number(rl.secondary_window.used_percent ?? 0)));
    windows.push({
      id: 'secondary',
      label: formatWindowLabel(rl.secondary_window.limit_window_seconds, '주간 한도'),
      usedPercent: Number(used.toFixed(1)),
      remainingPercent: Number((100 - used).toFixed(1)),
      resetsAt: normalizeResetIso(rl.secondary_window),
    });
  }

  if (Array.isArray(data?.additional_rate_limits)) {
    for (const extra of data.additional_rate_limits) {
      const pw = extra?.rate_limit?.primary_window;
      if (pw) {
        const used = Math.max(0, Math.min(100, Number(pw.used_percent ?? 0)));
        windows.push({
          id: `extra_${extra.limit_name || windows.length}`,
          label: extra.limit_name || '추가 한도',
          usedPercent: Number(used.toFixed(1)),
          remainingPercent: Number((100 - used).toFixed(1)),
          resetsAt: normalizeResetIso(pw),
        });
      }
    }
  }

  let extraText = null;
  if (data?.credits?.has_credits) {
    extraText = data.credits.unlimited
      ? '크레딧: 무제한'
      : `추가 크레딧 잔액: ${data.credits.balance ?? '사용 가능'}`;
  }

  const planRaw = data?.plan_type || null;
  const plan = planRaw ? planRaw.charAt(0).toUpperCase() + planRaw.slice(1) : null;

  return {
    plan,
    account: data?.email || fallbackEmail || null,
    windows,
    extra: extraText,
  };
}

async function refreshCodexToken(refreshToken, fetchImpl = fetch) {
  if (!refreshToken) return null;
  try {
    const res = await fetchImpl(OPENAI_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID,
      }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.access_token || null;
  } catch {
    return null;
  }
}

function resolveCodexCredentials(configStore) {
  const cfg = configStore.getProviderConfig('gpt');
  if (cfg.mode === 'disconnected') {
    return { status: 'logged_out' };
  }

  if (cfg.mode === 'token') {
    const token = configStore.getProviderToken('gpt');
    if (!token) return { status: 'logged_out' };
    const claims = decodeJwtPayload(token);
    return {
      status: 'ready',
      authSource: '앱 저장 토큰',
      creds: {
        accessToken: token,
        refreshToken: null,
        accountId: cfg.accountId || null,
        email: claims?.email || null,
        expMs: claims?.exp ? claims.exp * 1000 : null,
      },
    };
  }

  const candidates = cfg.mode === 'file' && cfg.customFilePath
    ? [cfg.customFilePath]
    : getDefaultAuthPaths();

  for (const filePath of candidates) {
    try {
      if (filePath && fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const creds = parseCodexAuthJson(raw);
        if (creds?.accessToken) {
          return {
            status: 'ready',
            authSource: filePath,
            creds,
          };
        }
        if (creds?.apiKey) {
          return {
            status: 'api_key_only',
            authSource: filePath,
          };
        }
      }
    } catch {
      // Try next candidate
    }
  }

  return { status: 'logged_out' };
}

async function fetchGptCodexUsage(configStore, fetchImpl = fetch) {
  const base = {
    id: 'gpt',
    name: 'GPT CLI',
    subtitle: 'OpenAI Codex CLI',
    updatedAt: new Date().toISOString(),
  };

  const resolved = resolveCodexCredentials(configStore);
  if (resolved.status === 'logged_out') {
    return {
      ...base,
      status: 'logged_out',
      authSource: null,
      plan: null,
      account: null,
      windows: [],
      extra: null,
      error: null,
    };
  }

  if (resolved.status === 'api_key_only') {
    return {
      ...base,
      status: 'error',
      authSource: resolved.authSource,
      plan: 'API Key',
      account: null,
      windows: [],
      extra: null,
      error: 'API 키 모드입니다. 구독 한도를 조회하려면 Codex CLI에서 ChatGPT 계정으로 로그인하세요.',
    };
  }

  let { accessToken, refreshToken, accountId, email, expMs } = resolved.creds;
  if (expMs && expMs < Date.now() + 60_000 && refreshToken) {
    const refreshed = await refreshCodexToken(refreshToken, fetchImpl);
    if (refreshed) accessToken = refreshed;
  }

  const callApi = async (token) => {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'codex-cli/1.0',
    };
    if (accountId) headers['ChatGPT-Account-Id'] = accountId;
    return fetchImpl(CODEX_USAGE_URL, { method: 'GET', headers });
  };

  try {
    let res = await callApi(accessToken);
    if ((res.status === 401 || res.status === 403) && refreshToken) {
      const refreshed = await refreshCodexToken(refreshToken, fetchImpl);
      if (refreshed) {
        res = await callApi(refreshed);
      }
    }

    if (res.status === 401 || res.status === 403) {
      return {
        ...base,
        status: 'expired',
        authSource: resolved.authSource,
        plan: null,
        account: email,
        windows: [],
        extra: null,
        error: '로그인 세션이 만료되었습니다. 다시 로그인해 주세요.',
      };
    }

    if (!res.ok) {
      return {
        ...base,
        status: 'error',
        authSource: resolved.authSource,
        plan: null,
        account: email,
        windows: [],
        extra: null,
        error: `한도 조회 실패 (HTTP ${res.status})`,
      };
    }

    const data = await res.json();
    const parsed = parseCodexUsageResponse(data, email);
    return {
      ...base,
      status: 'connected',
      authSource: resolved.authSource,
      ...parsed,
      error: null,
    };
  } catch (err) {
    return {
      ...base,
      status: 'error',
      authSource: resolved.authSource,
      plan: null,
      account: email,
      windows: [],
      extra: null,
      error: `네트워크 오류: ${err.message}`,
    };
  }
}

module.exports = {
  getDefaultAuthPaths,
  parseCodexAuthJson,
  parseCodexUsageResponse,
  fetchGptCodexUsage,
};
