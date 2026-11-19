'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CLOUDCODE_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
];
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

function getDefaultAuthPaths() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return [
    path.join(home, '.gemini', 'antigravity-cli', 'oauth_creds.json'),
    path.join(appData, 'gcloud', 'application_default_credentials.json'),
  ];
}

function parseExpiryMs(val) {
  if (typeof val === 'number') return val > 1e12 ? val : val * 1000;
  if (typeof val === 'string') {
    const ms = Date.parse(val);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function parseGoogleCredsJson(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tok = raw.token && typeof raw.token === 'object' ? raw.token : raw;
  return {
    accessToken: tok.access_token || tok.accessToken || null,
    refreshToken: tok.refresh_token || tok.refreshToken || null,
    clientId: raw.client_id || raw.clientId || tok.client_id || null,
    clientSecret: raw.client_secret || raw.clientSecret || tok.client_secret || null,
    expiryDate: parseExpiryMs(tok.expiry_date ?? tok.expiry ?? raw.expiry_date ?? raw.expiry),
    projectId: raw.quota_project_id || raw.project_id || null,
    email: raw.id_token_email || raw.email || null,
  };
}

function classifyModelGroup(modelId, displayName = '') {
  const text = `${modelId || ''} ${displayName || ''}`.toLowerCase();
  if (text.includes('claude') || text.includes('gpt')) return 'Claude/GPT';
  if (text.includes('gemini') && text.includes('pro')) return 'Gemini Pro';
  if (text.includes('gemini') && text.includes('flash')) return 'Gemini Flash';
  if (text.includes('gemini')) return 'Gemini';
  return null;
}

function normalizePlanName(tierName) {
  if (!tierName) return null;
  const low = String(tierName).toLowerCase();
  if (low.includes('ultra')) return 'AI Ultra';
  if (low.includes('pro') || low.includes('standard')) return 'AI Pro';
  if (low.includes('free') || low.includes('legacy')) return 'Free';
  return tierName;
}

function parseAgyCombinedQuota(summaryData, modelsData, bucketsData, meta = {}) {
  const fiveHourCandidates = [];
  const weeklyCandidates = [];

  // 1. Parse retrieveUserQuotaSummary groups (explicit 5h and weekly windows)
  const groups = Array.isArray(summaryData?.groups) ? summaryData.groups : [];
  for (const g of groups) {
    const groupLabel = (g.displayName || '').toLowerCase().includes('gemini') ? 'Gemini' : '3P';
    for (const b of g.buckets || []) {
      if (b.remainingFraction === undefined || b.remainingFraction === null) continue;
      const rem = Math.max(0, Math.min(100, Number(b.remainingFraction) * 100));
      const used = Number((100 - rem).toFixed(1));
      const entry = {
        source: groupLabel,
        usedPercent: used,
        remainingPercent: Number(rem.toFixed(1)),
        resetsAt: b.resetTime || null,
      };
      const win = String(b.window || b.bucketId || '').toLowerCase();
      if (win.includes('week')) {
        weeklyCandidates.push(entry);
      } else {
        fiveHourCandidates.push(entry);
      }
    }
  }

  // 2. Merge live Gemini 5h rolling quota from fetchAvailableModels (when summary omits Gemini group)
  const models = modelsData?.models && typeof modelsData.models === 'object' ? modelsData.models : {};
  let worstGeminiModel = null;
  for (const [modelId, info] of Object.entries(models)) {
    const qi = info?.quotaInfo;
    if (!qi || qi.remainingFraction === undefined || qi.remainingFraction === null) continue;
    if (!info.displayName && !qi.resetTime) continue;
    const text = `${modelId} ${info.displayName || ''}`.toLowerCase();
    if (!text.includes('gemini')) continue;
    const rem = Math.max(0, Math.min(100, Number(qi.remainingFraction) * 100));
    const used = Number((100 - rem).toFixed(1));
    if (!worstGeminiModel || used > worstGeminiModel.usedPercent) {
      worstGeminiModel = {
        source: 'Gemini',
        usedPercent: used,
        remainingPercent: Number(rem.toFixed(1)),
        resetsAt: qi.resetTime || null,
      };
    }
  }
  if (worstGeminiModel && !fiveHourCandidates.some((c) => c.source === 'Gemini')) {
    fiveHourCandidates.push(worstGeminiModel);
  }

  // 3. Fallback to retrieveUserQuota buckets if still empty
  if (fiveHourCandidates.length === 0 && Array.isArray(bucketsData?.buckets)) {
    for (const b of bucketsData.buckets) {
      if (b.remainingFraction === undefined || b.remainingFraction === null) continue;
      const rem = Math.max(0, Math.min(100, Number(b.remainingFraction) * 100));
      const used = Number((100 - rem).toFixed(1));
      fiveHourCandidates.push({
        source: classifyModelGroup(b.modelId || b.tokenType) || 'AGY',
        usedPercent: used,
        remainingPercent: Number(rem.toFixed(1)),
        resetsAt: b.resetTime || null,
      });
    }
  }

  const pickWorst = (list) => {
    if (!list.length) return null;
    return list.reduce((best, cur) => (cur.usedPercent > best.usedPercent ? cur : best), list[0]);
  };

  const windows = [];
  const fiveHour = pickWorst(fiveHourCandidates);
  if (fiveHour) {
    const detail = fiveHourCandidates.length > 1
      ? fiveHourCandidates.map((c) => `${c.source} ${c.usedPercent}%`).join(' / ')
      : null;
    windows.push({
      id: 'five_hour',
      label: '5시간 한도',
      usedPercent: fiveHour.usedPercent,
      remainingPercent: fiveHour.remainingPercent,
      resetsAt: fiveHour.resetsAt,
      detail,
    });
  }

  const weekly = pickWorst(weeklyCandidates);
  if (weekly) {
    const detail = weeklyCandidates.length > 1
      ? weeklyCandidates.map((c) => `${c.source} ${c.usedPercent}%`).join(' / ')
      : null;
    windows.push({
      id: 'weekly',
      label: '주간 한도 (7일)',
      usedPercent: weekly.usedPercent,
      remainingPercent: weekly.remainingPercent,
      resetsAt: weekly.resetsAt,
      detail,
    });
  }

  return {
    plan: normalizePlanName(meta.tierName),
    account: meta.email || null,
    windows,
    extra: meta.projectId ? `프로젝트: ${meta.projectId}` : null,
  };
}

async function refreshGoogleToken(creds, fetchImpl = fetch) {
  if (!creds?.refreshToken || !creds?.clientId) return null;
  try {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: creds.clientId,
    });
    if (creds.clientSecret) {
      params.set('client_secret', creds.clientSecret);
    }
    const res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.access_token || null;
  } catch {
    return null;
  }
}

function getGcloudAdcToken() {
  return new Promise((resolve) => {
    try {
      const isWin = process.platform === 'win32';
      const exe = isWin ? 'cmd.exe' : 'gcloud';
      const args = isWin
        ? ['/d', '/s', '/c', 'gcloud auth application-default print-access-token']
        : ['auth', 'application-default', 'print-access-token'];
      execFile(exe, args, { timeout: 6000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const token = stdout.trim();
        resolve(token || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function readWindowsAgyKeyring() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    const ps = [
      `Add-Type -TypeDefinition @"`,
      `using System;`,
      `using System.Runtime.InteropServices;`,
      `using System.Text;`,
      `public class AgyCredReader {`,
      `  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]`,
      `  public struct CREDENTIAL {`,
      `    public int Flags; public int Type; public string TargetName; public string Comment;`,
      `    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;`,
      `    public int CredentialBlobSize; public IntPtr CredentialBlob;`,
      `    public int Persist; public int AttributeCount; public IntPtr Attributes;`,
      `    public string TargetAlias; public string UserName;`,
      `  }`,
      `  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]`,
      `  public static extern bool CredReadW(string target, int type, int reservedFlag, out IntPtr credentialPtr);`,
      `  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]`,
      `  public static extern bool CredEnumerateW(string filter, int flag, out int count, out IntPtr pCredentials);`,
      `  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buffer);`,
      `  private static string DecodeBlob(CREDENTIAL c) {`,
      `    if (c.CredentialBlobSize <= 0 || c.CredentialBlob == IntPtr.Zero) return "";`,
      `    byte[] bytes = new byte[c.CredentialBlobSize];`,
      `    Marshal.Copy(c.CredentialBlob, bytes, 0, c.CredentialBlobSize);`,
      `    string utf8 = Encoding.UTF8.GetString(bytes).Trim();`,
      `    if (utf8.StartsWith("{") || utf8.Contains("access_token") || utf8.Contains("ya29.")) return utf8;`,
      `    string utf16 = Encoding.Unicode.GetString(bytes).Trim();`,
      `    if (utf16.StartsWith("{") || utf16.Contains("access_token") || utf16.Contains("ya29.")) return utf16;`,
      `    return "";`,
      `  }`,
      `  public static string FindAgySecret() {`,
      `    IntPtr directPtr;`,
      `    if (CredReadW("gemini:antigravity", 1, 0, out directPtr)) {`,
      `      try {`,
      `        string s = DecodeBlob(Marshal.PtrToStructure<CREDENTIAL>(directPtr));`,
      `        if (!string.IsNullOrEmpty(s)) return s;`,
      `      } finally { CredFree(directPtr); }`,
      `    }`,
      `    int count; IntPtr ptr;`,
      `    if (!CredEnumerateW(null, 0, out count, out ptr)) return "";`,
      `    try {`,
      `      for (int i = 0; i < count; i++) {`,
      `        IntPtr itemPtr = Marshal.ReadIntPtr(ptr, i * IntPtr.Size);`,
      `        CREDENTIAL c = Marshal.PtrToStructure<CREDENTIAL>(itemPtr);`,
      `        string t = (c.TargetName ?? "").ToLowerInvariant();`,
      `        if (t.Contains("antigravity")) {`,
      `          string s = DecodeBlob(c);`,
      `          if (!string.IsNullOrEmpty(s)) return s;`,
      `        }`,
      `      }`,
      `    } finally { CredFree(ptr); }`,
      `    return "";`,
      `  }`,
      `}`,
      `"@`,
      `[AgyCredReader]::FindAgySecret()`,
    ].join('\n');

    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        timeout: 6000,
        windowsHide: true,
      }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const text = stdout.trim();
        if (!text) return resolve(null);
        try {
          const parsed = JSON.parse(text);
          const creds = parseGoogleCredsJson(parsed);
          if (creds?.accessToken || creds?.refreshToken) return resolve(creds);
        } catch {
          const match = text.match(/ya29\.[A-Za-z0-9._-]+/);
          if (match) {
            return resolve({
              accessToken: match[0],
              refreshToken: null,
              clientId: null,
              clientSecret: null,
              expiryDate: null,
              projectId: null,
              email: null,
            });
          }
        }
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function resolveAgyCredentials(configStore, fetchImpl = fetch) {
  const cfg = configStore.getProviderConfig('agy');
  if (cfg.mode === 'disconnected') {
    return { status: 'logged_out' };
  }

  if (cfg.mode === 'token') {
    const token = configStore.getProviderToken('agy');
    if (!token) return { status: 'logged_out' };
    return {
      status: 'ready',
      authSource: '앱 저장 토큰',
      creds: {
        accessToken: token,
        refreshToken: null,
        clientId: null,
        clientSecret: null,
        expiryDate: null,
        projectId: cfg.projectId || null,
        email: null,
      },
    };
  }

  if (cfg.mode === 'file' && cfg.customFilePath) {
    try {
      if (fs.existsSync(cfg.customFilePath)) {
        const raw = JSON.parse(fs.readFileSync(cfg.customFilePath, 'utf8'));
        const creds = parseGoogleCredsJson(raw);
        if (creds?.accessToken || creds?.refreshToken) {
          if (!creds.accessToken && creds.refreshToken) {
            creds.accessToken = await refreshGoogleToken(creds, fetchImpl);
          }
          return {
            status: 'ready',
            authSource: cfg.customFilePath,
            creds: { ...creds, projectId: cfg.projectId || creds.projectId || null },
          };
        }
      }
    } catch {
      // fall through
    }
    return { status: 'logged_out' };
  }

  // Priority 1: Windows Credential Manager (`gemini:antigravity` written by `agy`)
  const keyringCreds = await readWindowsAgyKeyring();
  if (keyringCreds) {
    if (!keyringCreds.accessToken && keyringCreds.refreshToken) {
      keyringCreds.accessToken = await refreshGoogleToken(keyringCreds, fetchImpl);
    }
    if (keyringCreds.accessToken || keyringCreds.refreshToken) {
      return {
        status: 'ready',
        authSource: 'Antigravity CLI (Windows 자격 증명)',
        creds: {
          ...keyringCreds,
          projectId: cfg.projectId || keyringCreds.projectId || null,
        },
      };
    }
  }

  // Priority 2: Antigravity CLI / ADC files
  for (const filePath of getDefaultAuthPaths()) {
    try {
      if (filePath && fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const creds = parseGoogleCredsJson(raw);
        if (creds?.accessToken || creds?.refreshToken) {
          if (!creds.accessToken && creds.refreshToken) {
            creds.accessToken = await refreshGoogleToken(creds, fetchImpl);
          }
          if (creds.accessToken || creds.refreshToken) {
            return {
              status: 'ready',
              authSource: filePath,
              creds: {
                ...creds,
                projectId: cfg.projectId || creds.projectId || null,
              },
            };
          }
        }
      }
    } catch {
      // Try next file
    }
  }

  // Priority 3: gcloud ADC CLI
  const adcToken = await getGcloudAdcToken();
  if (adcToken) {
    return {
      status: 'ready',
      authSource: 'Google ADC (gcloud)',
      creds: {
        accessToken: adcToken,
        refreshToken: null,
        clientId: null,
        clientSecret: null,
        expiryDate: null,
        projectId: cfg.projectId || null,
        email: null,
      },
    };
  }

  return { status: 'logged_out' };
}

async function fetchEmailOptional(accessToken, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.email || null;
  } catch {
    return null;
  }
}

async function queryCloudCodeQuota(accessToken, preferredProjectId, fetchImpl = fetch) {
  let lastStatus = null;
  let lastError = null;

  for (const baseUrl of CLOUDCODE_ENDPOINTS) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'antigravity/1.5.12',
    };
    if (preferredProjectId) {
      headers['x-goog-user-project'] = preferredProjectId;
    }

    let projectId = preferredProjectId || null;
    let tierName = null;

    const loadRes = await fetchImpl(`${baseUrl}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        cloudaicompanionProject: projectId || undefined,
        metadata: { ideType: 'ANTIGRAVITY' },
      }),
    });

    if (loadRes.status === 401 || loadRes.status === 403) {
      lastStatus = loadRes.status;
      continue;
    }

    if (loadRes.ok) {
      const loadData = await loadRes.json();
      projectId = loadData?.cloudaicompanionProject || projectId;
      tierName = loadData?.paidTier?.name || loadData?.currentTier?.name || null;
    }

    const payload = JSON.stringify(projectId ? { project: projectId } : {});
    const [summaryRes, modelsRes] = await Promise.all([
      fetchImpl(`${baseUrl}/v1internal:retrieveUserQuotaSummary`, { method: 'POST', headers, body: payload }).catch(() => null),
      fetchImpl(`${baseUrl}/v1internal:fetchAvailableModels`, { method: 'POST', headers, body: payload }).catch(() => null),
    ]);

    const summaryData = summaryRes?.ok ? await summaryRes.json().catch(() => null) : null;
    const modelsData = modelsRes?.ok ? await modelsRes.json().catch(() => null) : null;

    if ((summaryData?.groups?.length > 0) || (modelsData?.models && Object.keys(modelsData.models).length > 0)) {
      return { ok: true, summaryData, modelsData, bucketsData: null, projectId, tierName };
    }

    // Fallback to retrieveUserQuota
    const quotaRes = await fetchImpl(`${baseUrl}/v1internal:retrieveUserQuota`, {
      method: 'POST',
      headers,
      body: payload,
    });

    lastStatus = quotaRes.status;
    if (quotaRes.ok) {
      const bucketsData = await quotaRes.json();
      if (Array.isArray(bucketsData?.buckets) && bucketsData.buckets.length > 0) {
        return { ok: true, summaryData: null, modelsData: null, bucketsData, projectId, tierName };
      }
      lastError = '반환된 한도 버킷이 없습니다.';
    }
  }

  return { ok: false, status: lastStatus, error: lastError };
}

async function fetchAgyUsage(configStore, fetchImpl = fetch) {
  const base = {
    id: 'agy',
    name: 'AGY CLI',
    subtitle: 'Antigravity CLI (agy)',
    updatedAt: new Date().toISOString(),
  };

  const resolved = await resolveAgyCredentials(configStore, fetchImpl);
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

  let { accessToken, expiryDate, projectId, email } = resolved.creds;
  if ((!accessToken || (expiryDate && expiryDate < Date.now() + 60_000)) && resolved.creds.refreshToken) {
    const refreshed = await refreshGoogleToken(resolved.creds, fetchImpl);
    if (refreshed) accessToken = refreshed;
  }

  if (!accessToken) {
    return {
      ...base,
      status: 'expired',
      authSource: resolved.authSource,
      plan: null,
      account: email || null,
      windows: [],
      extra: null,
      error: '토큰이 만료되었습니다. AGY CLI에서 다시 로그인해 주세요.',
    };
  }

  try {
    let result = await queryCloudCodeQuota(accessToken, projectId, fetchImpl);
    if (!result.ok && (result.status === 401 || result.status === 403) && resolved.creds.refreshToken) {
      const refreshed = await refreshGoogleToken(resolved.creds, fetchImpl);
      if (refreshed) {
        accessToken = refreshed;
        result = await queryCloudCodeQuota(accessToken, projectId, fetchImpl);
      }
    }

    if (!result.ok) {
      if (result.status === 401) {
        return {
          ...base,
          status: 'expired',
          authSource: resolved.authSource,
          plan: null,
          account: email || null,
          windows: [],
          extra: null,
          error: '로그인 세션이 만료되었습니다. AGY CLI를 한 번 실행해 갱신해 주세요.',
        };
      }
      return {
        ...base,
        status: 'error',
        authSource: resolved.authSource,
        plan: null,
        account: email || null,
        windows: [],
        extra: null,
        error: result.status
          ? `한도 조회 실패 (HTTP ${result.status}) — AGY CLI 계정을 확인해 주세요.`
          : (result.error || 'AGY 한도 정보를 불러올 수 없습니다.'),
      };
    }

    const resolvedEmail = email || await fetchEmailOptional(accessToken, fetchImpl);
    const meta = {
      tierName: result.tierName,
      projectId: result.projectId,
      email: resolvedEmail,
    };
    const parsed = parseAgyCombinedQuota(result.summaryData, result.modelsData, result.bucketsData, meta);

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
      account: email || null,
      windows: [],
      extra: null,
      error: `네트워크 오류: ${err.message}`,
    };
  }
}

module.exports = {
  getDefaultAuthPaths,
  parseGoogleCredsJson,
  parseAgyCombinedQuota,
  fetchAgyUsage,
};
