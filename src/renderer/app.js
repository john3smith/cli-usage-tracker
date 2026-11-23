'use strict';

let currentState = null;
let activeLoginProviderId = null;

const PROVIDER_ORDER = ['gpt', 'agy', 'claude'];
const $ = (id) => document.getElementById(id);

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortWindowLabel(label) {
  if (!label) return '한도';
  const s = String(label);
  if (s.includes('5시간')) return '5시간';
  if (s.includes('주간') || s.includes('7일 주간')) return '주간';
  if (s.includes('Sonnet')) return 'Sonnet';
  if (s.includes('Opus')) return 'Opus';
  if (s.includes('Gemini Pro')) return 'Pro';
  if (s.includes('Gemini Flash')) return 'Flash';
  return s.replace(' 한도', '');
}

function formatCompactReset(isoStr) {
  if (!isoStr) return '';
  const target = new Date(isoStr).getTime();
  if (Number.isNaN(target)) return '';
  const diffMs = target - Date.now();
  if (diffMs <= 0) return '곧 리셋';

  const totalMin = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${Math.max(1, mins)}m`;
}

function formatFullResetTitle(w) {
  const used = Number(w.usedPercent || 0);
  const rem = Number(w.remainingPercent ?? (100 - used));
  const detailPart = w.detail ? ` [${w.detail}]` : '';
  let resetPart = '';
  if (w.resetsAt) {
    const d = new Date(w.resetsAt);
    if (!Number.isNaN(d.getTime())) {
      resetPart = ` · 리셋 ${d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    }
  }
  return `${w.label}: 잔여 ${rem.toFixed(1)}% (사용 ${used.toFixed(1)}%)${detailPart}${resetPart}`;
}

function formatUpdatedShort(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function meterColorClass(providerId, remainingPercent) {
  if (remainingPercent <= 15) return 'danger';
  if (remainingPercent <= 35) return 'warn';
  return providerId;
}

function syncWindowHeight() {
  const loginOpen = !$('loginModal').classList.contains('hidden');
  const settingsOpen = !$('settingsModal').classList.contains('hidden');

  if (loginOpen) {
    window.usageApi.setHeight(435);
    return;
  }
  if (settingsOpen) {
    window.usageApi.setHeight(290);
    return;
  }

  requestAnimationFrame(() => {
    // Measure natural block height of #mainContent (never flex-stretched) + 2px outer border
    const mainEl = $('mainContent');
    if (!mainEl) return;
    const exactHeight = Math.ceil(mainEl.getBoundingClientRect().height) + 2;
    window.usageApi.setHeight(exactHeight);
  });
}

function renderProviderCard(p) {
  if (!p) return '';
  const isConnected = p.status === 'connected';
  const isWaiting = p.status === 'waiting';
  const isExpired = p.status === 'expired';
  const isError = p.status === 'error';

  const accountTitle = p.account || p.authSource || p.subtitle;

  let actionHtml = isConnected
    ? `
      <button class="mini-btn" data-action="login" data-id="${p.id}">계정</button>
      <button class="mini-btn logout-x" data-action="logout" data-id="${p.id}" title="로그아웃">✕</button>
    `
    : `<button class="mini-btn login-primary" data-action="login" data-id="${p.id}">로그인</button>`;

  if (p.id === 'claude' && currentState?.settings?.providers?.claude?.relayRoot) {
    actionHtml = p.status === 'logged_out'
      ? '<button class="mini-btn" data-action="relay-connect" data-id="claude">bukang 연결</button>'
      : '<button class="mini-btn" data-action="refresh" data-id="claude" title="bukang 사용량 새로고침">bukang ↻</button>' +
        '<button class="mini-btn logout-x" data-action="logout" data-id="claude" title="모니터 조회 끄기">✕</button>';
  }

  let bodyHtml = '';
  if (isConnected && Array.isArray(p.windows) && p.windows.length > 0) {
    const rows = p.windows.map((w) => {
      const used = Math.max(0, Math.min(100, Number(w.usedPercent) || 0));
      const rem = Math.max(0, Math.min(100, Number(w.remainingPercent ?? (100 - used))));
      const barClass = meterColorClass(p.id, rem);
      const pctClass = rem <= 15 ? 'danger' : (rem <= 35 ? 'warn' : '');
      const resetShort = formatCompactReset(w.resetsAt);
      const tooltip = formatFullResetTitle(w);

      return `
        <div class="meter-row" title="${escapeHtml(tooltip)}">
          <span class="meter-label">${escapeHtml(shortWindowLabel(w.label))}</span>
          <div class="meter-track">
            <div class="meter-fill ${barClass}" style="width: ${rem}%"></div>
          </div>
          <span class="meter-pct ${pctClass}">${Math.round(rem)}%</span>
          <span class="meter-reset">${escapeHtml(resetShort)}</span>
        </div>
      `;
    }).join('');
    bodyHtml = `<div class="meters">${rows}</div>`;
  } else if (isWaiting) {
    const waitingText = p.notice || '대기 중 (다음 작업 시 자동 갱신)';
    bodyHtml = `
      <div class="card-status waiting" title="${escapeHtml(waitingText)}">
        <span>${escapeHtml(waitingText)}</span>
      </div>
    `;
  } else if (isExpired) {
    bodyHtml = `<div class="card-status expired"><span>세션 만료 · 재로그인 필요</span></div>`;
  } else if (isError) {
    bodyHtml = `
      <div class="card-status error" title="${escapeHtml(p.error || '')}">
        <span>${escapeHtml(p.error || '조회 오류')}</span>
        <button class="mini-btn" data-action="refresh" data-id="${p.id}">재시도</button>
      </div>
    `;
  }
  // When not logged in (logged_out), intentionally render no usage area at all (only compact header + login button)

  return `
    <article class="provider-card" data-provider="${p.id}">
      <div class="card-top">
        <div class="provider-ident" title="${escapeHtml(accountTitle)}">
          <span class="provider-dot ${p.id} ${isConnected ? '' : 'dim'}"></span>
          <span class="provider-name">${escapeHtml(p.name)}</span>
          ${p.plan ? `<span class="plan-pill">${escapeHtml(p.plan)}</span>` : ''}
        </div>
        <div class="card-actions">${actionHtml}</div>
      </div>
      ${bodyHtml}
    </article>
  `;
}

function renderState(state) {
  currentState = state;
  if (!state) return;

  $('lastUpdatedText').textContent = state.isRefreshing
    ? '갱신 중...'
    : formatUpdatedShort(state.lastUpdatedAt);
  $('refreshBtn').classList.toggle('spinning', Boolean(state.isRefreshing));
  $('pinBtn').classList.toggle('active', Boolean(state.isPinned));

  const preview = Boolean(state.settings?.previewMode);
  $('previewBanner').classList.toggle('hidden', !preview);

  const html = PROVIDER_ORDER
    .map((id) => renderProviderCard(state.providers?.[id]))
    .join('');
  $('cardsContainer').innerHTML = html;

  if (state.settings) {
    $('refreshIntervalSelect').value = String(state.settings.refreshIntervalMinutes ?? 5);
    $('autoStartToggle').checked = Boolean(state.settings.autoStart);
    $('notifyToggle').checked = Boolean(state.settings.notifyEnabled);
    $('thresholdRange').value = String(state.settings.notifyThreshold ?? 85);
    $('thresholdVal').textContent = `${state.settings.notifyThreshold ?? 85}%`;
    $('previewToggle').checked = Boolean(state.settings.previewMode);
  }

  if (activeLoginProviderId) {
    populateLoginModal(activeLoginProviderId);
  }

  syncWindowHeight();
}

function showFeedback(message, isError = false) {
  const el = $('loginFeedback');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
}

function clearFeedback() {
  const el = $('loginFeedback');
  el.textContent = '';
  el.classList.add('hidden');
}

function populateLoginModal(providerId) {
  const p = currentState?.providers?.[providerId];
  const cli = currentState?.cliStatus?.[providerId];

  const titles = {
    gpt: 'GPT CLI (Codex) 로그인',
    agy: 'AGY CLI (Antigravity) 로그인',
    claude: 'Claude CLI (Claude Code) 로그인',
  };

  $('loginModalTitle').textContent = titles[providerId] || 'CLI 로그인';
  $('loginModalSub').textContent = p?.status === 'connected'
    ? `연결됨 (${p.account || p.authSource || '활성'})`
    : '공식 CLI 로그인 또는 자격 증명 연결';

  const badge = $('cliDetectBadge');
  if (cli?.installed) {
    badge.textContent = 'CLI 설치됨';
    badge.className = 'status-pill ok';
  } else {
    badge.textContent = 'CLI 미설치';
    badge.className = 'status-pill missing';
  }

  const actionsEl = $('cliActionButtons');
  actionsEl.innerHTML = '';

  const addActionBtn = (label, mode, cls = 'primary') => {
    const btn = document.createElement('button');
    btn.className = `btn ${cls}`;
    btn.textContent = label;
    btn.addEventListener('click', async () => {
      showFeedback('터미널 로그인 창을 실행했습니다. 로그인 완료 후 창을 닫으면 자동 반영됩니다.');
      await window.usageApi.launchCliLogin(providerId, mode);
    });
    actionsEl.appendChild(btn);
  };

  if (providerId === 'gpt') {
    $('cliHelpText').textContent = cli?.installed
      ? `경로: ${cli.binaryPath}`
      : 'Codex CLI가 감지되지 않았습니다.';
    if (cli?.installed) {
      addActionBtn('PowerShell에서 codex login 실행', 'login', 'primary');
    } else {
      addActionBtn('Codex CLI 설치 후 로그인 (npm)', 'install', 'primary');
      addActionBtn('codex login 바로 실행 시도', 'login', 'secondary');
    }
    $('fileHintText').textContent = '기본: %USERPROFILE%\\.codex\\auth.json';
    $('tokenInput').placeholder = 'ChatGPT OAuth Access Token';
    $('extraFieldInput').placeholder = 'ChatGPT Account ID (선택, org-...)';
    $('extraFieldInput').classList.remove('hidden');
  } else if (providerId === 'agy') {
    $('cliHelpText').textContent = cli?.installed
      ? `Antigravity CLI 경로: ${cli.binaryPath}`
      : 'Antigravity CLI(agy)가 감지되지 않았습니다.';
    if (cli?.hasAgy) {
      addActionBtn('PowerShell에서 agy 로그인 실행', 'login', 'primary');
    } else {
      addActionBtn('Antigravity CLI (agy) 설치 후 로그인', 'install', 'primary');
      addActionBtn('agy 바로 실행 시도', 'login', 'secondary');
    }
    if (cli?.hasGcloud) {
      addActionBtn('Google ADC 로그인 (AGY 헤드리스용)', 'adc', 'ghost');
    }
    $('fileHintText').textContent = 'Windows 자격 증명 관리자(agy) 자동 감지 또는 인증 JSON 파일 선택';
    $('tokenInput').placeholder = 'Google OAuth Access Token (ya29....)';
    $('extraFieldInput').placeholder = 'GCP Project ID (선택 사항)';
    $('extraFieldInput').classList.remove('hidden');
  } else if (providerId === 'claude') {
    $('cliHelpText').textContent = cli?.installed
      ? `경로: ${cli.binaryPath}`
      : 'Claude Code CLI가 감지되지 않았습니다.';
    if (cli?.installed) {
      addActionBtn('PowerShell에서 claude auth login 실행', 'login', 'primary');
    } else {
      addActionBtn('Claude CLI 설치 후 로그인 (npm)', 'install', 'primary');
      addActionBtn('claude auth login 바로 실행 시도', 'login', 'secondary');
    }
    $('fileHintText').textContent = '기본: %USERPROFILE%\\.claude\\.credentials.json';
    $('tokenInput').placeholder = 'Claude OAuth Access Token (sk-ant-oat01-...)';
    $('extraFieldInput').classList.add('hidden');
  }
}

function openLoginModal(providerId) {
  activeLoginProviderId = providerId;
  $('tokenInput').value = '';
  $('extraFieldInput').value = '';
  clearFeedback();
  populateLoginModal(providerId);
  $('loginModal').classList.remove('hidden');
  syncWindowHeight();
}

function closeLoginModal() {
  activeLoginProviderId = null;
  $('loginModal').classList.add('hidden');
  syncWindowHeight();
}

function openSettingsModal() {
  $('settingsModal').classList.remove('hidden');
  syncWindowHeight();
}

function closeSettingsModal() {
  $('settingsModal').classList.add('hidden');
  syncWindowHeight();
}

function wireEvents() {
  $('refreshBtn').addEventListener('click', () => {
    window.usageApi.refreshAll();
  });

  $('pinBtn').addEventListener('click', () => {
    window.usageApi.setPinned(!currentState?.isPinned);
  });

  $('settingsBtn').addEventListener('click', openSettingsModal);
  $('closeSettingsBtn').addEventListener('click', closeSettingsModal);
  $('closeLoginModalBtn').addEventListener('click', closeLoginModal);

  $('exitPreviewBtn').addEventListener('click', () => {
    window.usageApi.updateSettings({ previewMode: false });
  });

  $('quitBtn').addEventListener('click', () => {
    window.usageApi.quitApp();
  });

  $('cardsContainer').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;

    if (action === 'login') {
      await window.usageApi.detectClis();
      openLoginModal(id);
    } else if (action === 'relay-connect') {
      await window.usageApi.reconnectAuto(id);
    } else if (action === 'logout') {
      await window.usageApi.logoutProvider(id);
    } else if (action === 'refresh') {
      await window.usageApi.refreshOne(id);
    }
  });

  $('pickFileBtn').addEventListener('click', async () => {
    if (!activeLoginProviderId) return;
    const res = await window.usageApi.pickAuthFile(activeLoginProviderId);
    if (res?.ok) {
      showFeedback(`파일 연결 완료: ${res.filePath}`);
      setTimeout(closeLoginModal, 600);
    }
  });

  $('autoDetectBtn').addEventListener('click', async () => {
    if (!activeLoginProviderId) return;
    await window.usageApi.reconnectAuto(activeLoginProviderId);
    showFeedback('기본 인증 경로/자격 증명에서 다시 확인했습니다.');
  });

  $('saveTokenBtn').addEventListener('click', async () => {
    if (!activeLoginProviderId) return;
    const token = $('tokenInput').value.trim();
    if (!token) {
      showFeedback('토큰을 입력해 주세요.', true);
      return;
    }
    const extraVal = $('extraFieldInput').value.trim();
    const payload = {
      providerId: activeLoginProviderId,
      token,
      accountId: activeLoginProviderId === 'gpt' ? extraVal : undefined,
      projectId: activeLoginProviderId === 'agy' ? extraVal : undefined,
    };
    const res = await window.usageApi.saveManualToken(payload);
    if (res?.ok) {
      showFeedback('DPAPI 암호화 저장 완료');
      setTimeout(closeLoginModal, 600);
    } else {
      showFeedback(res?.message || '토큰 저장에 실패했습니다.', true);
    }
  });

  $('refreshIntervalSelect').addEventListener('change', (e) => {
    window.usageApi.updateSettings({ refreshIntervalMinutes: Number(e.target.value) });
  });

  $('autoStartToggle').addEventListener('change', (e) => {
    window.usageApi.updateSettings({ autoStart: e.target.checked });
  });

  $('notifyToggle').addEventListener('change', (e) => {
    window.usageApi.updateSettings({ notifyEnabled: e.target.checked });
  });

  $('thresholdRange').addEventListener('input', (e) => {
    $('thresholdVal').textContent = `${e.target.value}%`;
  });

  $('thresholdRange').addEventListener('change', (e) => {
    window.usageApi.updateSettings({ notifyThreshold: Number(e.target.value) });
  });

  $('previewToggle').addEventListener('change', (e) => {
    window.usageApi.updateSettings({ previewMode: e.target.checked });
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('loginModal').classList.contains('hidden')) {
        closeLoginModal();
      } else if (!$('settingsModal').classList.contains('hidden')) {
        closeSettingsModal();
      } else {
        window.usageApi.hideWindow();
      }
    }
  });
}

async function init() {
  wireEvents();
  window.usageApi.onStateUpdated((nextState) => {
    renderState(nextState);
  });

  const initial = await window.usageApi.getState();
  renderState(initial);

  setInterval(() => {
    if (currentState) renderState(currentState);
  }, 30000);
}

init();
