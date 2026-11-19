'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

function getDefaultAuthPaths() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return [
    path.join(home, '.claude', '.credentials.json'),
    path.join(appData, 'claude', 'credentials.json'),
    path.join(home, '.claude', 'credentials.json'),
  ];
}

function parseClaudeAuthJson(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const oauth = raw.claudeAiOauth && typeof raw.claudeAiOauth === 'object' ? raw.claudeAiOauth : raw;
  const accessToken = oauth.accessToken || oauth.access_token || null;
  const refreshToken = oauth.refreshToken || oauth.refresh_token || null;
  const expiresAt = oauth.expiresAt || oauth.expires_at || null;
  const subscriptionType = oauth.subscriptionType || oauth.subscription_type || null;
  const rateLimitTier = oauth.rateLimitTier || oauth.rate_limit_tier || null;

  return {
    accessToken,
    refreshToken,
    expiresAt: typeof expiresAt === 'number' ? expiresAt : null,
    subscriptionType,
    rateLimitTier,
  };
}

function formatPlanName(subType, tier) {
  const src = String(subType || tier || '').toLowerCase();
  if (!src) return null;
  if (src.includes('max_20x') || src.includes('20x')) return 'Max 20x';
  if (src.includes('max_5x') || src.includes('5x')) return 'Max 5x';
  if (src.includes('max')) return 'Max';
  if (src.includes('pro')) return 'Pro';
  if (src.includes('team')) return 'Team';
  if (src.includes('enterprise')) return 'Enterprise';
  return subType || tier;
}

function parseClaudeUsageResponse(data, meta = {}) {
  const windows = [];

  const pushWindow = (id, label, obj) => {
    if (!obj || obj.utilization === null || obj.utilization === undefined) return;
    const used = Math.max(0, Math.min(100, Number(obj.utilization)));
    windows.push({
      id,
      label,
      usedPercent: Number(used.toFixed(1)),
      remainingPercent: Number((100 - used).toFixed(1)),
      resetsAt: obj.resets_at || null,
    });
  };

  pushWindow('five_hour', '5시간 세션 한도', data?.five_hour);
  pushWindow('seven_day', '7일 주간 한도', data?.seven_day);
  pushWindow('seven_day_sonnet', '7일 Sonnet 한도', data?.seven_day_sonnet);
  pushWindow('seven_day_opus', '7일 Opus 한도', data?.seven_day_opus);

  let extraText = null;
  if (data?.extra_usage?.is_enabled) {
    const used = data.extra_usage.used_credits ?? 0;
    const limit = data.extra_usage.monthly_limit;
    extraText = limit != null
      ? `추가 사용량: $${(used / 100).toFixed(2)} / $${(limit / 100).toFixed(2)}`
      : `추가 사용량 활성화됨`;
  }

  return {
    plan: formatPlanName(meta.subscriptionType, meta.rateLimitTier),
    account: meta.account || null,
    windows,
    extra: extraText,
  };
}

async function refreshClaudeToken(refreshToken, fetchImpl = fetch) {
  if (!refreshToken) return null;
  try {
    const res = await fetchImpl(CLAUDE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.access_token || null;
  } catch {
    return null;
  }
}

function resolveClaudeCredentials(configStore) {
  const cfg = configStore.getProviderConfig('claude');
  if (cfg.mode === 'disconnected') {
    return { status: 'logged_out' };
  }

  if (cfg.mode === 'token') {
    const token = configStore.getProviderToken('claude');
    if (!token) return { status: 'logged_out' };
    return {
      status: 'ready',
      authSource: '앱 저장 토큰',
      creds: {
        accessToken: token,
        refreshToken: null,
        expiresAt: null,
        subscriptionType: null,
        rateLimitTier: null,
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
        const creds = parseClaudeAuthJson(raw);
        if (creds?.accessToken) {
          return {
            status: 'ready',
            authSource: filePath,
            creds,
          };
        }
      }
    } catch {
      // Try next file
    }
  }

  return { status: 'logged_out' };
}

async function fetchClaudeUsage(configStore, fetchImpl = fetch) {
  const base = {
    id: 'claude',
    name: 'Claude CLI',
    subtitle: 'Claude Code CLI',
    updatedAt: new Date().toISOString(),
  };

  const resolved = resolveClaudeCredentials(configStore);
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

  let { accessToken, refreshToken, expiresAt, subscriptionType, rateLimitTier } = resolved.creds;
  if (expiresAt && expiresAt < Date.now() + 60_000 && refreshToken) {
    const refreshed = await refreshClaudeToken(refreshToken, fetchImpl);
    if (refreshed) accessToken = refreshed;
  }

  const callApi = async (token) => fetchImpl(CLAUDE_USAGE_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.1.0',
      Accept: 'application/json',
    },
  });

  try {
    let res = await callApi(accessToken);
    if ((res.status === 401 || res.status === 403) && refreshToken) {
      const refreshed = await refreshClaudeToken(refreshToken, fetchImpl);
      if (refreshed) {
        res = await callApi(refreshed);
      }
    }

    if (res.status === 401 || res.status === 403) {
      return {
        ...base,
        status: 'expired',
        authSource: resolved.authSource,
        plan: formatPlanName(subscriptionType, rateLimitTier),
        account: null,
        windows: [],
        extra: null,
        error: '로그인 세션이 만료되었습니다. Claude CLI에서 다시 로그인해 주세요.',
      };
    }

    if (res.status === 429) {
      return {
        ...base,
        status: 'error',
        authSource: resolved.authSource,
        plan: formatPlanName(subscriptionType, rateLimitTier),
        account: null,
        windows: [],
        extra: null,
        error: '요청이 많아 잠시 제한되었습니다(HTTP 429). 잠시 후 새로고침됩니다.',
      };
    }

    if (!res.ok) {
      return {
        ...base,
        status: 'error',
        authSource: resolved.authSource,
        plan: formatPlanName(subscriptionType, rateLimitTier),
        account: null,
        windows: [],
        extra: null,
        error: `한도 조회 실패 (HTTP ${res.status})`,
      };
    }

    const data = await res.json();
    const parsed = parseClaudeUsageResponse(data, { subscriptionType, rateLimitTier });
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
      plan: formatPlanName(subscriptionType, rateLimitTier),
      account: null,
      windows: [],
      extra: null,
      error: `네트워크 오류: ${err.message}`,
    };
  }
}

module.exports = {
  getDefaultAuthPaths,
  parseClaudeAuthJson,
  parseClaudeUsageResponse,
  fetchClaudeUsage,
};
