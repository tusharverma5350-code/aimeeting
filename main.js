const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell, desktopCapturer } = require('electron');
const path = require('path');
const os   = require('os');

// Fix "Unable to move the cache: Access is denied" on Windows —
// redirect Chromium's cache to a writable temp location before app is ready.
app.setPath('userData', path.join(os.tmpdir(), 'MeetingAI'));

// Enable WASAPI loopback audio capture on Windows (required for system audio)
app.commandLine.appendSwitch('enable-features', 'WebRtcAllowInputVolumeAdjustment');
app.commandLine.appendSwitch('auto-select-desktop-capture-source', 'Entire screen');

let win;

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width:  440,
    height: 400,
    x: width  - 460,
    y: height - 360,
    frame:       false,       // no title bar
    transparent: true,        // glass background
    alwaysOnTop: true,        // float above all windows
    resizable:   false,       // no OS non-client border → no resize-cursor leak on share
    skipTaskbar:  true,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // ══════════════════════════════════════════════════════════════════
  //  THE KEY LINE — excludes this window from ALL screen capture.
  //  Works on Windows 10 2004+ and macOS 10.10+.
  //  Google Meet, Zoom, OBS, Windows Game Bar — none can capture it.
  // ══════════════════════════════════════════════════════════════════
  win.setContentProtection(true);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Grant microphone + display-capture access without prompting
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'display-capture') return callback(true);
    callback(false);
  });

  win.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media' || permission === 'display-capture') return true;
    return false;
  });
}

app.whenReady().then(() => {
  createWindow();

  // Global hotkey: Alt+Shift+A → show/hide window
  globalShortcut.register('Alt+Shift+A', () => {
    if (!win) return;
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });
});

// ── IPC: window controls from renderer ───────────────────────────────────────
ipcMain.on('close-window',  () => win?.hide());
ipcMain.on('set-opacity',   (_, val) => win?.setOpacity(Math.min(1, Math.max(0.1, val))));
ipcMain.handle('get-platform', () => process.platform);

// Keyboard-driven resize (resizable:false disables native drag-resize).
// Anchor the bottom-right corner so the window grows/shrinks from the top-left —
// keeps a bottom-right-docked window inside the screen bounds.
ipcMain.on('resize-by', (_, { dw = 0, dh = 0 } = {}) => {
  if (!win) return;
  const b     = win.getBounds();
  const newW  = Math.max(320, Math.min(1400, b.width  + dw));
  const newH  = Math.max(220, Math.min(1200, b.height + dh));
  const realDw = newW - b.width;
  const realDh = newH - b.height;
  win.setBounds({
    x:      Math.round(b.x - realDw),   // move left edge opposite to width delta
    y:      Math.round(b.y - realDh),   // move top  edge opposite to height delta
    width:  newW,
    height: newH,
  });
});

// Expose desktopCapturer sources to renderer (required for system audio capture)
ipcMain.handle('get-desktop-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 1, height: 1 },
    fetchWindowIcons: false,
  });
  return sources.map(s => ({ id: s.id, name: s.name }));
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Keep app running when all windows closed (Windows/Linux)
app.on('window-all-closed', (e) => e.preventDefault());
