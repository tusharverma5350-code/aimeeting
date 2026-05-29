const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  closeWindow:        ()    => ipcRenderer.send('close-window'),
  getPlatform:        ()    => ipcRenderer.invoke('get-platform'),
  getDesktopSources:  ()    => ipcRenderer.invoke('get-desktop-sources'),
  setOpacity:         (val) => ipcRenderer.send('set-opacity', val),
  resizeBy:           (dw, dh) => ipcRenderer.send('resize-by', { dw, dh }),
});
