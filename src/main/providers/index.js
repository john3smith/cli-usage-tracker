'use strict';

const { fetchGptCodexUsage } = require('./gpt-codex');
const { fetchAgyUsage } = require('./agy');
const { fetchClaudeUsage } = require('./claude');

function getPreviewSnapshot() {
  const now = Date.now();
  return {
    gpt: {
      id: 'gpt',
      name: 'GPT CLI',
      subtitle: 'OpenAI Codex CLI',
      status: 'connected',
      authSource: '미리보기 샘플',
      plan: 'Plus',
      account: 'demo@openai.example',
      windows: [
        {
          id: 'primary',
          label: '5시간 한도',
          usedPercent: 32.0,
          remainingPercent: 68.0,
          resetsAt: new Date(now + 2.6 * 3600 * 1000).toISOString(),
        },
        {
          id: 'secondary',
          label: '주간 한도 (7일)',
          usedPercent: 54.0,
          remainingPercent: 46.0,
          resetsAt: new Date(now + 4.2 * 86400 * 1000).toISOString(),
        },
      ],
      extra: null,
      error: null,
      updatedAt: new Date(now).toISOString(),
    },
    agy: {
      id: 'agy',
      name: 'AGY CLI',
      subtitle: 'Antigravity CLI (agy)',
      status: 'connected',
      authSource: '미리보기 샘플',
      plan: 'AI Pro',
      account: 'demo@google.example',
      windows: [
        {
          id: 'five_hour',
          label: '5시간 한도',
          usedPercent: 18.5,
          remainingPercent: 81.5,
          resetsAt: new Date(now + 3.8 * 3600 * 1000).toISOString(),
        },
        {
          id: 'weekly',
          label: '주간 한도 (7일)',
          usedPercent: 6.0,
          remainingPercent: 94.0,
          resetsAt: new Date(now + 6.2 * 86400 * 1000).toISOString(),
        },
      ],
      extra: '프로젝트: demo-antigravity-project',
      error: null,
      updatedAt: new Date(now).toISOString(),
    },
    claude: {
      id: 'claude',
      name: 'Claude CLI',
      subtitle: 'Claude Code CLI',
      status: 'connected',
      authSource: '미리보기 샘플',
      plan: 'Max 5x',
      account: 'demo@anthropic.example',
      windows: [
        {
          id: 'five_hour',
          label: '5시간 세션 한도',
          usedPercent: 76.0,
          remainingPercent: 24.0,
          resetsAt: new Date(now + 1.4 * 3600 * 1000).toISOString(),
        },
        {
          id: 'seven_day',
          label: '7일 주간 한도',
          usedPercent: 41.5,
          remainingPercent: 58.5,
          resetsAt: new Date(now + 3.1 * 86400 * 1000).toISOString(),
        },
      ],
      extra: null,
      error: null,
      updatedAt: new Date(now).toISOString(),
    },
  };
}

async function fetchAllUsage(configStore, fetchImpl = fetch) {
  const settings = configStore.getAll();
  if (settings.previewMode) {
    return getPreviewSnapshot();
  }

  const [gpt, agy, claude] = await Promise.all([
    fetchGptCodexUsage(configStore, fetchImpl),
    fetchAgyUsage(configStore, fetchImpl),
    fetchClaudeUsage(configStore, fetchImpl),
  ]);

  return { gpt, agy, claude };
}

async function fetchSingleUsage(providerId, configStore, fetchImpl = fetch) {
  const settings = configStore.getAll();
  if (settings.previewMode) {
    return getPreviewSnapshot()[providerId];
  }
  if (providerId === 'gpt') return fetchGptCodexUsage(configStore, fetchImpl);
  if (providerId === 'agy') return fetchAgyUsage(configStore, fetchImpl);
  if (providerId === 'claude') return fetchClaudeUsage(configStore, fetchImpl);
  throw new Error(`Unknown provider: ${providerId}`);
}

module.exports = {
  fetchAllUsage,
  fetchSingleUsage,
  getPreviewSnapshot,
};
