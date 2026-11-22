'use strict';

const fs = require('fs');
const path = require('path');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  dialog,
  nativeImage,
  screen,
  Notification,
  safeStorage,
} = require('electron');

const { ConfigStore } = require('./config-store');
const { createTrayIconPng, createTrayIconIco, computeTrayVisualKey } = require('./tray-icon');
const { fetchAllUsage, fetchSingleUsage } = require('./providers');
const { detectCliStatus, launchProviderCliLogin } = require('./cli-launcher');

const WINDOW_WIDTH = 286;
const DEFAULT_WINDOW_HEIGHT = 180;
const MIN_WINDOW_HEIGHT = 136;
const MAX_WINDOW_HEIGHT = 480;
const TRAY_GUID = '7c4e9b2a-8f31-4d62-b5a1-9e2f4c8d1a07';

let tray = null;
let currentTrayIcon = null;
let trayIconSlot = 0;
let lastTrayVisualKey = null;
let lastShownAt = 0;
let currentWindowHeight = DEFAULT_WINDOW_HEIGHT;
let mainWindow = null;
let configStore = null;
let refreshTimer = null;
let isPinned = false;
let isRefreshing = false;

let usageState = {
  gpt: null,
  agy: null,
  claude: null,
};
let cliStatus = null;
const notifiedKeys = new Set();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0);
}

app.setAppUserModelId('com.usagetracker.cli');

function buildTooltipText(providers) {
  const lines = ['CLI Usage Tracker (잔여)'];
  for (const id of ['gpt', 'agy', 'claude']) {
    const p = providers[id];
    if (!p) continue;
    if (p.status === 'connected' && p.windows?.length) {
      const summary = p.windows
        .slice(0, 2)
        .map((w) => {
          const rem = Math.round(Number(w.remainingPercent ?? (100 - (Number(w.usedPercent) || 0))));
          const shortLbl = w.label.includes('5시간') ? '5h' : (w.label.includes('주간') ? '7d' : w.label.replace(' 한도', ''));
          return `${shortLbl} ${rem}%`;
        })
        .join(' · ');
      lines.push(`• ${p.name}: ${summary}`);
    } else if (p.status === 'error') {
      lines.push(`• ${p.name}: 조회 오류`);
    } else if (p.status === 'expired') {
      lines.push(`• ${p.name}: 세션 만료`);
    } else {
      lines.push(`• ${p.name}: 미로그인`);
    }
  }
  // Windows tray tooltips are capped at 127 characters
  return lines.join('\n').slice(0, 126);
}

function writeAndLoadTrayIcon(providers) {
  const userDataDir = app.getPath('userData');
  fs.mkdirSync(userDataDir, { recursive: true });
  trayIconSlot = (trayIconSlot + 1) % 2;
  const icoPath = path.join(userDataDir, `tray-icon-${trayIconSlot}.ico`);
  const icoBuf = createTrayIconIco(providers);
  fs.writeFileSync(icoPath, icoBuf);
  let img = nativeImage.createFromPath(icoPath);
  if (img.isEmpty()) {
    img = nativeImage.createFromBuffer(createTrayIconPng(providers));
  }
  return { img, icoPath };
}

function updateTrayVisuals() {
  if (!tray) return;
  try {
    const visualKey = computeTrayVisualKey(usageState);
    if (visualKey !== lastTrayVisualKey) {
      const { img } = writeAndLoadTrayIcon(usageState);
      currentTrayIcon = img;
      lastTrayVisualKey = visualKey;
      tray.setImage(currentTrayIcon);
    }
    tray.setToolTip(buildTooltipText(usageState));
  } catch {
    // Keep previous tray icon on transient failure
  }
}

function maybeSendThresholdNotifications() {
  const settings = configStore.getAll();
  if (!settings.notifyEnabled || settings.previewMode || !Notification.isSupported()) return;

  const threshold = settings.notifyThreshold || 85;
  for (const id of ['gpt', 'agy', 'claude']) {
    const p = usageState[id];
    if (!p || p.status !== 'connected') continue;
    for (const w of p.windows || []) {
      const key = `${id}:${w.id}:${w.resetsAt || 'none'}`;
      if (w.usedPercent >= threshold) {
        if (!notifiedKeys.has(key)) {
          notifiedKeys.add(key);
          const n = new Notification({
            title: `${p.name} 한도 경고 (${Math.round(w.usedPercent)}% 사용)`,
            body: `${w.label}의 잔여량이 ${Math.round(w.remainingPercent)}% 남았습니다.`,
          });
          n.on('click', () => showFlyoutWindow());
          n.show();
        }
      } else if (w.usedPercent < threshold - 10) {
        notifiedKeys.delete(key);
      }
    }
  }
}

function broadcastState() {
  updateTrayVisuals();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', getFullRendererState());
  }
}

function getFullRendererState() {
  return {
    providers: usageState,
    settings: configStore.getPublicSettings(),
    cliStatus,
    isPinned,
    isRefreshing,
    lastUpdatedAt: new Date().toISOString(),
  };
}

async function refreshAllProviders() {
  if (isRefreshing) return getFullRendererState();
  isRefreshing = true;
  broadcastState();

  try {
    const [nextUsage, nextCli] = await Promise.all([
      fetchAllUsage(configStore),
      detectCliStatus(),
    ]);
    usageState = nextUsage;
    cliStatus = nextCli;
    maybeSendThresholdNotifications();
  } finally {
    isRefreshing = false;
    broadcastState();
  }
  return getFullRendererState();
}

async function refreshSingleProvider(providerId) {
  try {
    const result = await fetchSingleUsage(providerId, configStore);
    usageState[providerId] = result;
    maybeSendThresholdNotifications();
    broadcastState();
  } catch {
    // ignore
  }
  return getFullRendererState();
}

function scheduleAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  const minutes = configStore.getAll().refreshIntervalMinutes;
  if (minutes > 0) {
    refreshTimer = setInterval(() => {
      refreshAllProviders();
    }, minutes * 60 * 1000);
  }
}

function applyAutoStartSetting(enabled) {
  if (process.platform !== 'win32') return;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath,
      args: [path.resolve(__dirname, '../..')],
    });
  } catch {
    // Ignore if OS policy disallows startup registration
  }
}

function positionFlyoutNearTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const workArea = display.workArea;
  const trayBounds = tray ? tray.getBounds() : null;
  const winHeight = currentWindowHeight;

  let x;
  let y;

  if (trayBounds && trayBounds.width > 0 && trayBounds.height > 0) {
    x = Math.round(trayBounds.x + trayBounds.width / 2 - WINDOW_WIDTH / 2);
    if (trayBounds.y >= workArea.y + workArea.height - 80) {
      y = workArea.y + workArea.height - winHeight - 10;
    } else {
      y = workArea.y + 10;
    }
  } else {
    x = workArea.x + workArea.width - WINDOW_WIDTH - 10;
    y = workArea.y + workArea.height - winHeight - 10;
  }

  x = Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - WINDOW_WIDTH - 8));
  y = Math.max(workArea.y + 8, Math.min(y, workArea.y + workArea.height - winHeight - 8));

  mainWindow.setBounds({ x, y, width: WINDOW_WIDTH, height: winHeight }, false);
}

function resizeFlyoutHeight(requestedHeight) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const nextHeight = Math.max(MIN_WINDOW_HEIGHT, Math.min(MAX_WINDOW_HEIGHT, Math.ceil(Number(requestedHeight) || DEFAULT_WINDOW_HEIGHT)));
  if (nextHeight === currentWindowHeight) return;
  currentWindowHeight = nextHeight;
  positionFlyoutNearTray();
}

function showFlyoutWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createFlyoutWindow();
  }
  positionFlyoutNearTray();
  lastShownAt = Date.now();
  mainWindow.show();
  mainWindow.focus();
}

function toggleFlyoutWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    showFlyoutWindow();
    return;
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    showFlyoutWindow();
  }
}

function createFlyoutWindow() {
  const { img: winIcon } = writeAndLoadTrayIcon(usageState);
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: false,
    backgroundColor: '#11161f',
    roundedCorners: true,
    icon: winIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('blur', () => {
    // Avoid immediate hide if blur fires right as the flyout is opened
    if (Date.now() - lastShownAt < 600) return;
    if (!isPinned && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createSystemTray() {
  const { img, icoPath } = writeAndLoadTrayIcon(usageState);
  currentTrayIcon = img;
  lastTrayVisualKey = computeTrayVisualKey(usageState);

  tray = process.platform === 'win32'
    ? new Tray(currentTrayIcon, TRAY_GUID)
    : new Tray(currentTrayIcon);

  tray.setToolTip('CLI Usage Tracker — 클릭하여 한도 확인');

  try {
    const logPath = path.join(app.getPath('userData'), 'startup.log');
    const info = {
      time: new Date().toISOString(),
      icoPath,
      iconEmpty: currentTrayIcon.isEmpty(),
      iconSize: currentTrayIcon.getSize(),
      trayBounds: tray.getBounds(),
      guid: TRAY_GUID,
    };
    fs.writeFileSync(logPath, JSON.stringify(info, null, 2), 'utf8');
  } catch {
    // ignore log write failure
  }

  const rebuildContextMenu = () => {
    const autoStart = configStore.getAll().autoStart;
    return Menu.buildFromTemplate([
      { label: '한도 창 열기', click: () => showFlyoutWindow() },
      { label: '지금 새로고침', click: () => refreshAllProviders() },
      { type: 'separator' },
      {
        label: '윈도우 시작 시 자동 실행',
        type: 'checkbox',
        checked: autoStart,
        click: (menuItem) => {
          configStore.updateSettings({ autoStart: menuItem.checked });
          applyAutoStartSetting(menuItem.checked);
          broadcastState();
        },
      },
      { type: 'separator' },
      {
        label: '앱 재시작',
        click: () => {
          app.isQuitting = true;
          if (tray && !tray.isDestroyed()) tray.destroy();
          app.releaseSingleInstanceLock();
          app.relaunch();
          app.exit(0);
        },
      },
      {
        label: '종료',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]);
  };

  tray.on('click', () => {
    toggleFlyoutWindow();
  });

  tray.on('right-click', () => {
    tray.popUpContextMenu(rebuildContextMenu());
  });
}

function registerIpcHandlers() {
  ipcMain.handle('app:get-state', async () => {
    if (!cliStatus) {
      cliStatus = await detectCliStatus();
    }
    return getFullRendererState();
  });

  ipcMain.handle('usage:refresh-all', async () => {
    return refreshAllProviders();
  });

  ipcMain.handle('usage:refresh-one', async (_e, providerId) => {
    return refreshSingleProvider(providerId);
  });

  ipcMain.handle('cli:detect', async () => {
    cliStatus = await detectCliStatus();
    broadcastState();
    return cliStatus;
  });

  const usesRelayLogin = (id) => id === 'claude' && Boolean(configStore.getProviderConfig(id).relayRoot);
  const relayLoginMessage = { ok: false, message: 'Claude 로그인은 bukang에서 관리합니다.' };

  ipcMain.handle('auth:launch-cli', async (_e, { providerId, mode }) => {
    if (usesRelayLogin(providerId)) return relayLoginMessage;
    configStore.setProviderAuto(providerId);
    const res = await launchProviderCliLogin(providerId, mode, async (detectedId) => {
      await refreshSingleProvider(detectedId);
      if (Notification.isSupported()) {
        new Notification({
          title: 'CLI 로그인 감지됨',
          body: `${detectedId.toUpperCase()} CLI 인증이 업데이트되어 한도를 새로고침했습니다.`,
        }).show();
      }
    });
    return res;
  });

  ipcMain.handle('auth:pick-file', async (_e, providerId) => {
    if (usesRelayLogin(providerId)) return relayLoginMessage;
    const wasPinned = isPinned;
    isPinned = true;
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: `${providerId.toUpperCase()} CLI 자격 증명 파일 선택`,
        properties: ['openFile'],
        filters: [
          { name: 'JSON Credentials', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePaths?.length) {
        return { ok: false, canceled: true };
      }
      configStore.setProviderFile(providerId, result.filePaths[0]);
      await refreshSingleProvider(providerId);
      return { ok: true, filePath: result.filePaths[0], state: getFullRendererState() };
    } finally {
      isPinned = wasPinned;
      showFlyoutWindow();
    }
  });

  ipcMain.handle('auth:save-token', async (_e, { providerId, token, accountId, projectId }) => {
    if (usesRelayLogin(providerId)) return relayLoginMessage;
    if (!token || !token.trim()) {
      return { ok: false, message: '토큰을 입력해 주세요.' };
    }
    const extra = {};
    if (providerId === 'gpt' && accountId !== undefined) extra.accountId = accountId.trim();
    if (providerId === 'agy' && projectId !== undefined) extra.projectId = projectId.trim();
    configStore.setProviderToken(providerId, token, extra);
    await refreshSingleProvider(providerId);
    return { ok: true, state: getFullRendererState() };
  });

  ipcMain.handle('auth:reconnect-auto', async (_e, providerId) => {
    configStore.setProviderAuto(providerId);
    await refreshSingleProvider(providerId);
    return { ok: true, state: getFullRendererState() };
  });

  ipcMain.handle('auth:logout', async (_e, providerId) => {
    configStore.disconnectProvider(providerId);
    await refreshSingleProvider(providerId);
    return { ok: true, state: getFullRendererState() };
  });

  ipcMain.handle('settings:update', async (_e, patch) => {
    configStore.updateSettings(patch);
    if (patch.autoStart !== undefined) {
      applyAutoStartSetting(patch.autoStart);
    }
    if (patch.refreshIntervalMinutes !== undefined) {
      scheduleAutoRefresh();
    }
    if (patch.previewMode !== undefined) {
      await refreshAllProviders();
    } else {
      broadcastState();
    }
    return getFullRendererState();
  });

  ipcMain.handle('window:set-pinned', (_e, pinned) => {
    isPinned = Boolean(pinned);
    broadcastState();
    return isPinned;
  });

  ipcMain.handle('window:set-height', (_e, height) => {
    resizeFlyoutHeight(height);
    return currentWindowHeight;
  });

  ipcMain.handle('window:hide', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  });

  ipcMain.handle('app:quit', () => {
    app.isQuitting = true;
    app.quit();
  });
}

if (gotLock) {
  app.on('second-instance', () => {
    if (!tray || tray.isDestroyed()) {
      createSystemTray();
    }
    showFlyoutWindow();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    if (tray && !tray.isDestroyed()) {
      tray.destroy();
      tray = null;
    }
  });

  app.whenReady().then(async () => {
    configStore = new ConfigStore(app.getPath('userData'), safeStorage);
    createFlyoutWindow();
    createSystemTray();
    registerIpcHandlers();
    scheduleAutoRefresh();

    // Show flyout immediately on launch so user sees the app right away
    showFlyoutWindow();

    await refreshAllProviders();
  });

  app.on('window-all-closed', (e) => {
    // Keep running in system tray
    e.preventDefault();
  });
}
