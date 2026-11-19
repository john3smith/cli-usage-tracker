'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usageApi', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  refreshAll: () => ipcRenderer.invoke('usage:refresh-all'),
  refreshOne: (providerId) => ipcRenderer.invoke('usage:refresh-one', providerId),
  detectClis: () => ipcRenderer.invoke('cli:detect'),
  launchCliLogin: (providerId, mode) => ipcRenderer.invoke('auth:launch-cli', { providerId, mode }),
  pickAuthFile: (providerId) => ipcRenderer.invoke('auth:pick-file', providerId),
  saveManualToken: (payload) => ipcRenderer.invoke('auth:save-token', payload),
  reconnectAuto: (providerId) => ipcRenderer.invoke('auth:reconnect-auto', providerId),
  logoutProvider: (providerId) => ipcRenderer.invoke('auth:logout', providerId),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  setPinned: (pinned) => ipcRenderer.invoke('window:set-pinned', pinned),
  setHeight: (height) => ipcRenderer.invoke('window:set-height', height),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  onStateUpdated: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('state:updated', handler);
    return () => ipcRenderer.removeListener('state:updated', handler);
  },
});
