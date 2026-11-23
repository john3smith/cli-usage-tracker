'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTrayIconPng, createTrayIconIco } = require('../src/main/tray-icon');
const { ConfigStore } = require('../src/main/config-store');
const { parseCodexAuthJson, parseCodexUsageResponse, fetchGptCodexUsage } = require('../src/main/providers/gpt-codex');
const { parseClaudeAuthJson, parseClaudeUsageResponse, fetchClaudeUsage } = require('../src/main/providers/claude');
const { parseGoogleCredsJson, parseAgyCombinedQuota, fetchAgyUsage } = require('../src/main/providers/agy');

function makeTempConfigStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-tracker-test-'));
  return { dir, store: new ConfigStore(dir, null) };
}

test('Flyout close button hides window to tray instead of quitting app', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  assert.match(html, /id="closeBtn"[^>]*title="트레이로 최소화"/);
  assert.doesNotMatch(html, /id="quitBtn"/);
  assert.match(js, /\$\('closeBtn'\)\.addEventListener\('click',\s*\(\)\s*=>\s*\{\s*window\.usageApi\.hideWindow\(\);/);
  assert.doesNotMatch(js, /quitApp\(/);
});

test('createTrayIconPng and createTrayIconIco generate valid image buffers', () => {

  const sample = {
    gpt: { id: 'gpt', status: 'connected', windows: [{ usedPercent: 30, remainingPercent: 70 }] },
    agy: { id: 'agy', status: 'connected', windows: [{ usedPercent: 90, remainingPercent: 10 }] },
    claude: { id: 'claude', status: 'logged_out', windows: [] },
  };
  const png = createTrayIconPng(sample);

  assert.ok(Buffer.isBuffer(png));
  // PNG signature
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  // Width and height in IHDR
  assert.equal(png.readUInt32BE(16), 32);
  assert.equal(png.readUInt32BE(20), 32);

  const ico = createTrayIconIco(sample);
  assert.ok(Buffer.isBuffer(ico));
  assert.equal(ico.readUInt16LE(0), 0); // reserved
  assert.equal(ico.readUInt16LE(2), 1); // ICO type
  assert.equal(ico.readUInt16LE(4), 3); // 3 resolutions: 16, 32, 48
});

test('ConfigStore saves tokens, redacts public settings, and supports disconnect', () => {
  const { dir, store } = makeTempConfigStore();
  try {
    store.setProviderToken('claude', 'sk-ant-oat01-secret-test');
    assert.equal(store.getProviderToken('claude'), 'sk-ant-oat01-secret-test');

    const pub = store.getPublicSettings();
    assert.equal(pub.providers.claude.hasSavedToken, true);
    assert.equal(pub.providers.claude.encryptedToken, undefined);

    store.disconnectProvider('claude');
    assert.equal(store.getProviderConfig('claude').mode, 'disconnected');
    assert.equal(store.getProviderToken('claude'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GPT Codex parser & fetcher handle wham/usage response', async () => {
  const parsedAuth = parseCodexAuthJson({
    tokens: {
      access_token: 'tok-abc',
      refresh_token: 'ref-xyz',
      account_id: 'org-123',
    },
  });
  assert.equal(parsedAuth.accessToken, 'tok-abc');
  assert.equal(parsedAuth.accountId, 'org-123');

  const parsedUsage = parseCodexUsageResponse({
    email: 'dev@example.com',
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1800000000 },
      secondary_window: { used_percent: 60, limit_window_seconds: 604800, reset_at: 1800500000 },
    },
  });
  assert.equal(parsedUsage.plan, 'Plus');
  assert.equal(parsedUsage.windows.length, 2);
  assert.equal(parsedUsage.windows[0].label, '5시간 한도');
  assert.equal(parsedUsage.windows[0].usedPercent, 25);
  assert.equal(parsedUsage.windows[1].label, '주간 한도 (7일)');

  const { dir, store } = makeTempConfigStore();
  try {
    store.setProviderToken('gpt', 'tok-abc', { accountId: 'org-123' });
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        email: 'dev@example.com',
        plan_type: 'pro',
        rate_limit: {
          primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 3600 },
        },
      }),
    });
    const res = await fetchGptCodexUsage(store, mockFetch);
    assert.equal(res.status, 'connected');
    assert.equal(res.plan, 'Pro');
    assert.equal(res.windows[0].usedPercent, 12);
    assert.equal(res.windows[0].remainingPercent, 88);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude parser & fetcher handle /api/oauth/usage response', async () => {
  const creds = parseClaudeAuthJson({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-xyz',
      refreshToken: 'sk-ant-oarr01-xyz',
      subscriptionType: 'max_5x',
    },
  });
  assert.equal(creds.accessToken, 'sk-ant-oat01-xyz');

  const usage = parseClaudeUsageResponse(
    {
      five_hour: { utilization: 42.5, resets_at: '2026-11-19T16:00:00.000Z' },
      seven_day: { utilization: 18.0, resets_at: '2026-11-24T00:00:00.000Z' },
    },
    { subscriptionType: 'max_5x' }
  );
  assert.equal(usage.plan, 'Max 5x');
  assert.equal(usage.windows.length, 2);
  assert.equal(usage.windows[0].usedPercent, 42.5);
  assert.equal(usage.windows[0].remainingPercent, 57.5);

  const { dir, store } = makeTempConfigStore();
  try {
    store.setProviderToken('claude', 'sk-ant-oat01-xyz');
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        five_hour: { utilization: 55, resets_at: '2026-11-19T18:00:00.000Z' },
      }),
    });
    const res = await fetchClaudeUsage(store, mockFetch);
    assert.equal(res.status, 'connected');
    assert.equal(res.windows[0].usedPercent, 55);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude relay mode uses only the relay for old token/file configurations', async () => {
  const { dir, store } = makeTempConfigStore();
  const noDirectApi = () => assert.fail('Unexpected direct API request');
  try {
    store.setProviderToken('claude', 'test-token');
    store.updateProviderConfig('claude', { relayRoot: dir });
    for (const mode of ['auto', 'file', 'token']) {
      store.updateProviderConfig('claude', { mode });
      const connected = await fetchClaudeUsage(store, noDirectApi, async (root) => {
        assert.equal(root, dir);
        return { usage: { five_hour: { utilization: 0 }, seven_day: { utilization: 100 } } };
      });
      assert.equal(connected.status, 'connected');
      assert.deepEqual(connected.windows.map(w => w.remainingPercent), [100, 0]);
    }
    const waiting = await fetchClaudeUsage(store, noDirectApi, async () => ({ reason: 'expired' }));
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.error, null);
    assert.match(waiting.notice, /자동 갱신/);
    assert.deepEqual(waiting.windows, []);

    for (const reason of ['auth', 'rate_limited', 'network']) {
      const state = await fetchClaudeUsage(store, noDirectApi, async () => ({ reason }));
      assert.equal(state.status, 'error');
      assert.deepEqual(state.windows, []);
    }
    store.disconnectProvider('claude');
    const off = await fetchClaudeUsage(store, noDirectApi, () => assert.fail('Relay is disconnected'));
    assert.equal(off.status, 'logged_out');
    store.setProviderAuto('claude');
    assert.equal(store.getProviderConfig('claude').relayRoot, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude file lookup never rotates an expired or rejected credential', async () => {
  const { dir, store } = makeTempConfigStore();
  try {
    const file = path.join(dir, 'claude.json');
    const original = JSON.stringify({ claudeAiOauth: {
      accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: 1,
    } });
    fs.writeFileSync(file, original);
    store.setProviderFile('claude', file);
    for (const status of [401, 403]) {
      const calls = [];
      const result = await fetchClaudeUsage(store, async (url, opts) => {
        calls.push([opts.method, url]);
        return { status, ok: false };
      });
      assert.equal(result.status, 'expired');
      assert.deepEqual(calls, [['GET', 'https://api.anthropic.com/api/oauth/usage']]);
      assert.equal(fs.readFileSync(file, 'utf8'), original);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AGY parser & fetcher return 5-hour and weekly windows', async () => {
  const nestedCreds = parseGoogleCredsJson({
    token: {
      access_token: 'ya29.agy-nested',
      refresh_token: '1//ref',
      expiry: '2026-11-19T23:09:56+09:00',
    },
    id_token_email: 'agy@example.com',
  });
  assert.equal(nestedCreds.accessToken, 'ya29.agy-nested');
  assert.equal(nestedCreds.email, 'agy@example.com');
  assert.ok(typeof nestedCreds.expiryDate === 'number');

  const combined = parseAgyCombinedQuota(
    {
      groups: [
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: '2026-11-26T14:00:00Z' },
            { bucketId: '3p-5h', window: '5h', remainingFraction: 0.95, resetTime: '2026-11-19T19:00:00Z' },
          ],
        },
      ],
    },
    {
      models: {
        'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro', quotaInfo: { remainingFraction: 0.78, resetTime: '2026-11-19T18:00:00Z' } },
      },
    },
    null,
    { tierName: 'Google AI Pro', projectId: 'demo-project', email: 'demo@example.com' }
  );
  assert.equal(combined.plan, 'AI Pro');
  assert.equal(combined.windows.length, 2);
  assert.equal(combined.windows[0].label, '5시간 한도');
  assert.equal(combined.windows[0].usedPercent, 22);
  assert.equal(combined.windows[1].label, '주간 한도 (7일)');
  assert.equal(combined.windows[1].usedPercent, 10);

  const { dir, store } = makeTempConfigStore();
  try {
    store.setProviderToken('agy', 'ya29.test');
    const mockFetch = async (url) => {
      if (url.includes('loadCodeAssist')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ cloudaicompanionProject: 'proj-auto', paidTier: { name: 'Google AI Ultra' } }),
        };
      }
      if (url.includes('retrieveUserQuotaSummary')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            groups: [
              {
                displayName: 'Claude and GPT models',
                buckets: [
                  { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.85, resetTime: '2026-11-26T14:00:00Z' },
                  { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-19T21:00:00Z' },
                ],
              },
            ],
          }),
        };
      }
      if (url.includes('fetchAvailableModels')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: {
              'gemini-3-pro': { displayName: 'Gemini 3 Pro', quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-19T21:00:00Z' } },
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ email: 'agy@example.com' }),
      };
    };
    const res = await fetchAgyUsage(store, mockFetch);
    assert.equal(res.status, 'connected');
    assert.equal(res.plan, 'AI Ultra');
    assert.equal(res.account, 'agy@example.com');
    assert.equal(res.windows[0].label, '5시간 한도');
    assert.equal(res.windows[0].usedPercent, 20);
    assert.equal(res.windows[1].label, '주간 한도 (7일)');
    assert.equal(res.windows[1].usedPercent, 15);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
