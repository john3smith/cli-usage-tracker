'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  refreshIntervalMinutes: 5,
  autoStart: false,
  notifyEnabled: true,
  notifyThreshold: 85,
  previewMode: false,
  providers: {
    gpt: {
      mode: 'auto', // 'auto' | 'file' | 'token' | 'disconnected'
      customFilePath: '',
      customCliPath: '',
      encryptedToken: null,
      accountId: '',
    },
    agy: {
      mode: 'auto',
      customFilePath: '',
      customCliPath: '',
      encryptedToken: null,
      projectId: '',
    },
    claude: {
      mode: 'auto',
      customFilePath: '',
      customCliPath: '',
      encryptedToken: null,
    },
  },
};

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function mergeConfig(base, incoming) {
  const out = deepClone(base);
  if (!incoming || typeof incoming !== 'object') return out;
  for (const key of ['refreshIntervalMinutes', 'autoStart', 'notifyEnabled', 'notifyThreshold', 'previewMode']) {
    if (incoming[key] !== undefined) out[key] = incoming[key];
  }
  if (incoming.providers && typeof incoming.providers === 'object') {
    for (const id of ['gpt', 'agy', 'claude']) {
      if (incoming.providers[id]) {
        out.providers[id] = { ...out.providers[id], ...incoming.providers[id] };
      }
    }
  }
  return out;
}

class ConfigStore {
  constructor(userDataDir, safeStorage = null) {
    this.dir = userDataDir;
    this.filePath = path.join(userDataDir, 'config.json');
    this.safeStorage = safeStorage;
    this.config = this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        return mergeConfig(DEFAULT_CONFIG, JSON.parse(raw));
      }
    } catch {
      // Fallback to defaults if config is corrupted
    }
    return deepClone(DEFAULT_CONFIG);
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), 'utf8');
  }

  getAll() {
    return deepClone(this.config);
  }

  getPublicSettings() {
    const cfg = this.getAll();
    // Never expose raw encrypted blobs to renderer
    for (const id of ['gpt', 'agy', 'claude']) {
      cfg.providers[id].hasSavedToken = Boolean(cfg.providers[id].encryptedToken);
      delete cfg.providers[id].encryptedToken;
    }
    return cfg;
  }

  updateSettings(patch) {
    if (patch.refreshIntervalMinutes !== undefined) {
      this.config.refreshIntervalMinutes = Number(patch.refreshIntervalMinutes) || 0;
    }
    if (patch.autoStart !== undefined) {
      this.config.autoStart = Boolean(patch.autoStart);
    }
    if (patch.notifyEnabled !== undefined) {
      this.config.notifyEnabled = Boolean(patch.notifyEnabled);
    }
    if (patch.notifyThreshold !== undefined) {
      this.config.notifyThreshold = Math.max(50, Math.min(99, Number(patch.notifyThreshold) || 85));
    }
    if (patch.previewMode !== undefined) {
      this.config.previewMode = Boolean(patch.previewMode);
    }
    this.save();
    return this.getPublicSettings();
  }

  getProviderConfig(id) {
    return this.config.providers[id] || deepClone(DEFAULT_CONFIG.providers[id]);
  }

  updateProviderConfig(id, patch) {
    if (!this.config.providers[id]) return null;
    this.config.providers[id] = {
      ...this.config.providers[id],
      ...patch,
    };
    this.save();
    return this.getPublicSettings();
  }

  encryptSecret(plaintext) {
    if (!plaintext) return null;
    if (this.safeStorage && this.safeStorage.isEncryptionAvailable()) {
      const buf = this.safeStorage.encryptString(plaintext);
      return { scheme: 'dpapi', value: buf.toString('base64') };
    }
    return { scheme: 'b64', value: Buffer.from(plaintext, 'utf8').toString('base64') };
  }

  decryptSecret(record) {
    if (!record || !record.value) return null;
    try {
      const buf = Buffer.from(record.value, 'base64');
      if (record.scheme === 'dpapi' && this.safeStorage && this.safeStorage.isEncryptionAvailable()) {
        return this.safeStorage.decryptString(buf);
      }
      if (record.scheme === 'b64') {
        return buf.toString('utf8');
      }
    } catch {
      return null;
    }
    return null;
  }

  setProviderToken(id, token, extra = {}) {
    if (!this.config.providers[id]) return;
    this.config.providers[id] = {
      ...this.config.providers[id],
      ...extra,
      mode: 'token',
      encryptedToken: this.encryptSecret(token.trim()),
    };
    this.save();
  }

  getProviderToken(id) {
    const prov = this.config.providers[id];
    if (!prov || !prov.encryptedToken) return null;
    return this.decryptSecret(prov.encryptedToken);
  }

  setProviderFile(id, filePath) {
    if (!this.config.providers[id]) return;
    this.config.providers[id] = {
      ...this.config.providers[id],
      mode: 'file',
      customFilePath: filePath,
    };
    this.save();
  }

  setProviderAuto(id) {
    if (!this.config.providers[id]) return;
    this.config.providers[id] = {
      ...this.config.providers[id],
      mode: 'auto',
    };
    this.save();
  }

  disconnectProvider(id) {
    if (!this.config.providers[id]) return;
    this.config.providers[id] = {
      ...this.config.providers[id],
      mode: 'disconnected',
      encryptedToken: null,
      customFilePath: '',
    };
    this.save();
  }
}

module.exports = {
  ConfigStore,
  DEFAULT_CONFIG,
};
