const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  closeWindow:        ()    => ipcRenderer.send('close-window'),
  getPlatform:        ()    => ipcRenderer.invoke('get-platform'),
  getDesktopSources:  ()    => ipcRenderer.invoke('get-desktop-sources'),
  captureScreenshot:  ()    => ipcRenderer.invoke('capture-screenshot'),
  getPhoneUrl:        ()    => ipcRenderer.invoke('phone:url'),
  onPhoneInput:       (cb)  => ipcRenderer.on('phone-input', (_, data) => cb(data)),
  onToggleMic:        (cb)  => ipcRenderer.on('toggle-mic', cb),
  onToggleCapture:    (cb)  => ipcRenderer.on('toggle-capture', cb),
  onTogglePromptMode: (cb)  => ipcRenderer.on('toggle-prompt-mode', cb),
  setOpacity:         (val) => ipcRenderer.send('set-opacity', val),
  resizeBy:           (dw, dh) => ipcRenderer.send('resize-by', { dw, dh }),
});
