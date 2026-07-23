const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell, desktopCapturer } = require('electron');
const path = require('path');
const os   = require('os');
const http = require('http');

// Fix "Unable to move the cache: Access is denied" on Windows —
// redirect Chromium's cache to a writable temp location before app is ready.
app.setPath('userData', path.join(os.tmpdir(), 'MeetingAI'));

// Enable WASAPI loopback audio capture on Windows (required for system audio)
app.commandLine.appendSwitch('enable-features', 'WebRtcAllowInputVolumeAdjustment');
app.commandLine.appendSwitch('auto-select-desktop-capture-source', 'Entire screen');

let win;

// Only one instance may own the global shortcuts (Alt+Shift+A/D) — Windows
// grants a hotkey to whichever process registers it first, so a second
// launch would silently fail to get the hotkey while its window sits on top.
// Refuse the second launch entirely and focus the existing window instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    win.show();
    win.focus();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  PHONE REMOTE INPUT — a tiny LAN web server so you can type from your phone
//  (same Wi-Fi) and have it land in the app's input box. No PIN/QR by design
//  (single user); anyone on the LAN who knows the URL could post — fine at home.
// ══════════════════════════════════════════════════════════════════════════════
const PHONE_PORT = 8390;
let phoneServer = null;

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return '127.0.0.1';
}
function phoneUrl() { return `http://${getLanIp()}:${PHONE_PORT}`; }

const PHONE_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"/>
<title>MeetingAI Remote</title>
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0d1117;color:#e6edf3;padding:14px}
  h1{font-size:15px;margin:0 0 10px;color:#58a6ff;font-weight:700}
  textarea{width:100%;height:44vh;resize:none;font-size:17px;line-height:1.5;padding:12px;border-radius:12px;border:1px solid #30363d;background:#161b22;color:#e6edf3}
  textarea:focus{outline:none;border-color:#58a6ff}
  .row{display:flex;gap:10px;margin-top:12px}
  button{flex:1;padding:16px;font-size:16px;font-weight:700;border:none;border-radius:12px;color:#fff}
  #send{background:#238636}#ins{background:#1f6feb}#clr{flex:0 0 70px;background:#30363d}
  button:active{filter:brightness(1.25)}
  #status{text-align:center;margin-top:12px;height:20px;font-size:14px;color:#7ee787}
</style></head><body>
  <h1>📱 MeetingAI — Remote Input</h1>
  <textarea id="t" autofocus placeholder="Type your question here, then tap Send to AI…"></textarea>
  <div class="row">
    <button id="send">Send to AI</button>
    <button id="ins">Insert</button>
    <button id="clr">Clear</button>
  </div>
  <div id="status"></div>
<script>
  var t=document.getElementById('t'),s=document.getElementById('status');
  function flash(m,ok){s.style.color=ok?'#7ee787':'#f85149';s.textContent=m;setTimeout(function(){s.textContent='';},2000);}
  function post(send){
    var text=t.value;
    if(send&&!text.trim())return;
    fetch('/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:text,send:send})})
      .then(function(r){if(!r.ok)throw 0;flash(send?'✓ Sent to AI':'✓ Inserted',true);if(send)t.value='';t.focus();})
      .catch(function(){flash('⚠️ Not connected — check Wi-Fi',false);});
  }
  document.getElementById('send').onclick=function(){post(true);};
  document.getElementById('ins').onclick=function(){post(false);};
  document.getElementById('clr').onclick=function(){t.value='';t.focus();};
</script></body></html>`;

function startPhoneServer() {
  if (phoneServer) return;
  phoneServer = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/index'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(PHONE_PAGE);
    }
    if (req.method === 'POST' && req.url === '/send') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          const text = typeof data.text === 'string' ? data.text : '';
          const send = !!data.send;
          if (win && !win.isDestroyed()) win.webContents.send('phone-input', { text, send });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (_) { res.writeHead(400); res.end('bad request'); }
      });
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  phoneServer.on('error', e => console.error('[phone] server error:', e.message));
  phoneServer.listen(PHONE_PORT, '0.0.0.0', () => console.log(`[phone] remote input → ${phoneUrl()}`));
}

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

if (gotLock) {
  app.whenReady().then(() => {
    createWindow();
    startPhoneServer();

    // Global hotkey: Alt+Shift+A → show/hide window
    const okA = globalShortcut.register('Alt+Shift+A', () => {
      if (!win) return;
      if (win.isVisible()) {
        win.hide();
      } else {
        win.show();
        win.focus();
      }
    });
    if (!okA) console.error('[shortcut] Alt+Shift+A registration FAILED — likely already bound by another app.');

    // Global hotkey: Alt+Shift+D → toggle DevTools (to view the [llm] logs / errors)
    const okD = globalShortcut.register('Alt+Shift+D', () => {
      if (!win) return;
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
      else win.webContents.openDevTools({ mode: 'detach' });
    });
    if (!okD) console.error('[shortcut] Alt+Shift+D registration FAILED.');

    // Global hotkey: Alt+Shift+M → toggle the 🎙 mic, without needing to click
    // into this window (works while focus is on Zoom, an editor, etc.)
    const okM = globalShortcut.register('Alt+Shift+M', () => {
      if (win && !win.isDestroyed()) win.webContents.send('toggle-mic');
    });
    if (!okM) console.error('[shortcut] Alt+Shift+M registration FAILED — likely already bound by another app.');

    // Global hotkey: Alt+Shift+N → toggle Start/Stop meeting capture button,
    // without needing to click into this window.
    const okN = globalShortcut.register('Alt+Shift+N', () => {
      if (win && !win.isDestroyed()) win.webContents.send('toggle-capture');
    });
    if (!okN) console.error('[shortcut] Alt+Shift+N registration FAILED — likely already bound by another app.');

    // Global hotkey: Alt+Shift+B → toggle which system prompt is active
    // (System/Settings prompt ⇄ Custom-prompt box), shown live in the UI badge.
    const okB = globalShortcut.register('Alt+Shift+B', () => {
      if (win && !win.isDestroyed()) win.webContents.send('toggle-prompt-mode');
    });
    if (!okB) console.error('[shortcut] Alt+Shift+B registration FAILED — likely already bound by another app.');
  });
}

// ── IPC: window controls from renderer ───────────────────────────────────────
ipcMain.on('close-window',  () => win?.hide());
ipcMain.on('set-opacity',   (_, val) => win?.setOpacity(Math.min(1, Math.max(0.1, val))));
ipcMain.handle('get-platform', () => process.platform);
ipcMain.handle('phone:url', () => phoneUrl());

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

// ── IPC: full-screen screenshot → returned as a JPEG data URL for AI vision ───
// Hides our (content-protected) overlay first so the region behind it is captured,
// then restores it. Captures what's on screen even when the shared app blocks copy.
ipcMain.handle('capture-screenshot', async () => {
  const t0 = Date.now();
  const wasVisible = win?.isVisible();
  try {
    if (wasVisible) win.hide();
    await new Promise(r => setTimeout(r, 150)); // let the desktop repaint without the overlay
    const tHidden = Date.now();
    const display = screen.getPrimaryDisplay();
    const sf = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width:  Math.round(display.size.width  * sf),
        height: Math.round(display.size.height * sf),
      },
    });
    const tSources = Date.now();
    const src = sources.find(s => String(s.display_id) === String(display.id)) || sources[0];
    if (!src) throw new Error('No screen available to capture.');
    let img = src.thumbnail;
    const orig = img.getSize();
    const MAX_W = 1600;                        // cap width → smaller payload, still readable
    if (img.getSize().width > MAX_W) img = img.resize({ width: MAX_W });
    const jpeg = img.toJPEG(82);
    const tDone = Date.now();
    console.log(`[screenshot/main] hide+repaint ${tHidden - t0}ms · getSources ${tSources - tHidden}ms · resize+encode ${tDone - tSources}ms · ${orig.width}x${orig.height}→${img.getSize().width}px · ${Math.round(jpeg.length / 1024)} KB`);
    return 'data:image/jpeg;base64,' + jpeg.toString('base64');
  } finally {
    if (wasVisible && win) win.show();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  try { phoneServer?.close(); } catch (_) {}
});

// Keep app running when all windows closed (Windows/Linux)
app.on('window-all-closed', (e) => e.preventDefault());
