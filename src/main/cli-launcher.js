'use strict';

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gptProvider = require('./providers/gpt-codex');
const agyProvider = require('./providers/agy');
const claudeProvider = require('./providers/claude');

const CLI_META = {
  gpt: {
    commands: ['codex'],
    loginCommand: 'codex login',
    installAndLoginCommand: 'npm install -g @openai/codex; codex login',
    defaultFileHint: '%USERPROFILE%\\.codex\\auth.json',
    tokenHint: 'ChatGPT OAuth Access Token (auth.json의 tokens.access_token)',
  },
  agy: {
    commands: ['agy'],
    loginCommand: 'agy',
    altLoginCommand: 'gcloud auth application-default login',
    installAndLoginCommand: 'irm https://antigravity.google/cli/install.ps1 | iex; $env:Path = "$env:LOCALAPPDATA\\agy\\bin;$env:Path"; agy',
    defaultFileHint: 'Windows 자격 증명 관리자(agy) 또는 %USERPROFILE%\\.gemini\\antigravity-cli\\oauth_creds.json',
    tokenHint: 'Google OAuth Access Token (ya29....)',
  },
  claude: {
    commands: ['claude'],
    loginCommand: 'claude auth login',
    fallbackLoginCommand: 'claude',
    installAndLoginCommand: 'npm install -g @anthropic-ai/claude-code; claude auth login',
    defaultFileHint: '%USERPROFILE%\\.claude\\.credentials.json',
    tokenHint: 'Claude OAuth Access Token (sk-ant-oat01-...)',
  },
};

function whichCommand(cmdName) {
  return new Promise((resolve) => {
    const tool = process.platform === 'win32' ? 'where.exe' : 'which';
    execFile(tool, [cmdName], { timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const firstLine = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      resolve(firstLine || null);
    });
  });
}

function findFallbackBinary(candidates) {
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

function findAgyFallbackBinary() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return findFallbackBinary([
    path.join(localAppData, 'agy', 'bin', 'agy.exe'),
    path.join(localAppData, 'Programs', 'agy', 'agy.exe'),
    path.join(os.homedir(), '.local', 'bin', 'agy.exe'),
  ]);
}

function findClaudeFallbackBinary() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return findFallbackBinary([
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    path.join(appData, 'npm', 'claude.cmd'),
  ]);
}

function findCodexFallbackBinary() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return findFallbackBinary([
    path.join(appData, 'npm', 'codex.cmd'),
    path.join(os.homedir(), '.local', 'bin', 'codex.exe'),
  ]);
}

async function detectCliStatus() {
  const [codexPath, agyPath, gcloud, claudePath] = await Promise.all([
    whichCommand('codex'),
    whichCommand('agy'),
    whichCommand('gcloud'),
    whichCommand('claude'),
  ]);

  const resolvedCodex = codexPath || findCodexFallbackBinary();
  const resolvedAgy = agyPath || findAgyFallbackBinary();
  const resolvedClaude = claudePath || findClaudeFallbackBinary();

  return {
    gpt: {
      installed: Boolean(resolvedCodex),
      binaryPath: resolvedCodex,
      meta: CLI_META.gpt,
    },
    agy: {
      installed: Boolean(resolvedAgy),
      binaryPath: resolvedAgy,
      hasAgy: Boolean(resolvedAgy),
      hasGcloud: Boolean(gcloud),
      meta: CLI_META.agy,
    },
    claude: {
      installed: Boolean(resolvedClaude),
      binaryPath: resolvedClaude,
      meta: CLI_META.claude,
    },
  };
}

function getWatchPathsForProvider(providerId) {
  if (providerId === 'gpt') return gptProvider.getDefaultAuthPaths();
  if (providerId === 'agy') return agyProvider.getDefaultAuthPaths();
  if (providerId === 'claude') return claudeProvider.getDefaultAuthPaths();
  return [];
}

/**
 * Opens a guaranteed-visible Windows PowerShell console window to run the official CLI login command.
 * Uses `cmd.exe /c start /wait` so a new visible console window is created even from a GUI Electron app,
 * while still notifying `onWindowClosed` when the user closes the login terminal.
 */
function launchPowerShellLogin(title, commandStr, onWindowClosed = null) {
  const safeTitle = title.replace(/'/g, "''");
  const script = [
    `$Host.UI.RawUI.WindowTitle = '${safeTitle}'`,
    `Write-Host '============================================' -ForegroundColor Cyan`,
    `Write-Host '  ${safeTitle}' -ForegroundColor White`,
    `Write-Host '  브라우저에서 로그인을 완료한 뒤 창을 닫으면 트레이 앱에 자동 반영됩니다.' -ForegroundColor Gray`,
    `Write-Host '============================================' -ForegroundColor Cyan`,
    `Write-Host ''`,
    commandStr,
    `Write-Host ''`,
    `Read-Host '작업이 완료되었습니다. Enter를 누르거나 창을 닫아주세요'`,
  ].join('\n');

  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  const child = spawn(
    'cmd.exe',
    ['/d', '/s', '/c', `start /wait "CLI Login" powershell.exe -NoLogo -ExecutionPolicy Bypass -EncodedCommand ${encoded}`],
    {
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    }
  );

  if (typeof onWindowClosed === 'function') {
    child.on('exit', () => {
      onWindowClosed();
    });
  }
}

async function launchProviderCliLogin(providerId, mode = 'login', onCredentialDetected = null) {
  const status = await detectCliStatus();
  const info = status[providerId];
  if (!info) {
    return { ok: false, message: '알 수 없는 프로바이더입니다.' };
  }

  let title = '';
  let cmd = '';

  if (providerId === 'gpt') {
    title = 'GPT CLI (Codex) 로그인';
    if (mode === 'install') {
      cmd = CLI_META.gpt.installAndLoginCommand;
    } else if (info.binaryPath) {
      cmd = `& '${info.binaryPath.replace(/'/g, "''")}' login`;
    } else {
      cmd = CLI_META.gpt.loginCommand;
    }
  } else if (providerId === 'agy') {
    if (mode === 'adc') {
      title = 'AGY CLI — Google ADC 로그인';
      cmd = CLI_META.agy.altLoginCommand;
    } else if (mode === 'install') {
      title = 'Antigravity CLI (agy) 설치 및 로그인';
      cmd = CLI_META.agy.installAndLoginCommand;
    } else {
      title = 'Antigravity CLI (agy) 로그인';
      if (info.binaryPath) {
        cmd = `& '${info.binaryPath.replace(/'/g, "''")}'`;
      } else {
        cmd = 'agy';
      }
    }
  } else if (providerId === 'claude') {
    title = 'Claude CLI 로그인';
    if (mode === 'install') {
      cmd = CLI_META.claude.installAndLoginCommand;
    } else if (info.binaryPath) {
      cmd = `& '${info.binaryPath.replace(/'/g, "''")}' auth login`;
    } else {
      cmd = CLI_META.claude.loginCommand;
    }
  }

  let notified = false;
  const triggerOnce = () => {
    if (notified || typeof onCredentialDetected !== 'function') return;
    notified = true;
    onCredentialDetected(providerId);
  };

  launchPowerShellLogin(title, cmd, () => {
    // Refresh after user closes the login terminal (handles Windows Credential Manager updates too)
    setTimeout(triggerOnce, 500);
  });

  // Also poll credential files so UI updates immediately even before terminal closes
  if (typeof onCredentialDetected === 'function') {
    const watchPaths = getWatchPathsForProvider(providerId);
    const initialMtimes = new Map();
    for (const p of watchPaths) {
      try {
        initialMtimes.set(p, fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0);
      } catch {
        initialMtimes.set(p, 0);
      }
    }

    let checks = 0;
    const timer = setInterval(() => {
      if (notified) {
        clearInterval(timer);
        return;
      }
      checks += 1;
      let changed = false;
      for (const p of watchPaths) {
        try {
          if (fs.existsSync(p)) {
            const mt = fs.statSync(p).mtimeMs;
            if (mt > (initialMtimes.get(p) || 0)) {
              changed = true;
              break;
            }
          }
        } catch {
          // ignore transient lock
        }
      }
      if (changed) {
        clearInterval(timer);
        triggerOnce();
      } else if (checks >= 90) {
        clearInterval(timer);
      }
    }, 2000);
  }

  return { ok: true, command: cmd };
}

module.exports = {
  CLI_META,
  detectCliStatus,
  launchProviderCliLogin,
  getWatchPathsForProvider,
};
