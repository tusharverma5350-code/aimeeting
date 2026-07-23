// Renderer — Meeting Audio / My Mic modes with manual send

// ── API keys (Groq for transcription — leave blank if using local Whisper) ────
const GROQ_KEY      = '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';
const OPENAI_KEY    = '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';   // OpenAI (answer engine)

// ── Ollama (local LLM) config ─────────────────────────────────────────────────
const OLLAMA_BASE_URL    = 'http://localhost:11434';  // default Ollama server
const OLLAMA_MODEL       = 'qwen2.5:7b';              // change to your preferred model

// ── Claude (Anthropic API) config — used when Answer Engine = Claude in Settings ─
const ANTHROPIC_MODEL    = 'claude-opus-4-8';         // Opus 4.8 (best quality)

// ── Constants ─────────────────────────────────────────────────────────────────
const GROQ_MODEL          = 'whisper-large-v3-turbo'; // faster than v3, same quality
const LOCAL_WHISPER_URL   = 'http://localhost:2022/inference'; // whisper.cpp local server
const CHUNK_INTERVAL_MS = 6000;   // 6s audio chunks
const MIN_BLOB_BYTES    = 800;    // silence in webm/opus compresses below this → skip
const MAX_HISTORY       = 100;    // keep the whole session's context; only 🗑 Clear resets it
const STREAM_IDLE_MS    = 90000;  // abort only if no chunk arrives for 90s

// ── State ─────────────────────────────────────────────────────────────────────
let currentMode          = 'meeting'; // 'meeting' | 'mic'
let isCaptureActive      = false;     // main capture button
let isMicActive          = false;     // 🎙 mic toggle button
let isWaitingForResponse = false;
let useCustomPrompt      = false;     // Alt+Shift+B toggles: false=System prompt, true=Custom prompt
let conversationHistory  = [];
let claudeAbortController = null;     // so Stop button can cancel streaming
let responseRaw = '';                 // raw markdown text backing #response — rendered to HTML
let renderPending = false;            // rAF throttle flag for markdown rendering during streaming

// System audio / main mic refs
let mediaStream   = null;
let mediaRecorder = null;
let audioChunks   = [];
let chunkTimer    = null;

// 🎙 toggle mic refs (separate from main capture so both can run together)
let micToggleStream   = null;
let micToggleRecorder = null;
let micToggleChunks   = [];
let micToggleTimer    = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const captureBtn     = document.getElementById('capture-btn');
const micBtn         = document.getElementById('mic-btn');
const sendBtn        = document.getElementById('send-btn');
const inputTextarea  = document.getElementById('input-textarea');
const customPromptEl = document.getElementById('custom-prompt');
const promptStatusEl = document.getElementById('prompt-status');
const responseEl     = document.getElementById('response');
const statusDot      = document.getElementById('status-dot');
const statusLabel    = document.getElementById('status-label');
const closeBtn       = document.getElementById('close-btn');
const opacitySlider  = document.getElementById('opacity-slider');
const clearHistoryBtn= document.getElementById('clear-history-btn');
const settingsBtn    = document.getElementById('settings-btn');
const settingsPanel  = document.getElementById('settings-panel');
const settingsClose  = document.getElementById('settings-close');
const apiKeyEl       = document.getElementById('apiKey');
const groqKeyEl      = document.getElementById('groqKey');
const systemPromptEl    = document.getElementById('systemPrompt');
const useLocalWhisperEl = document.getElementById('useLocalWhisper');
const localWhisperHint  = document.getElementById('local-whisper-hint');
const answerEngineEl    = document.getElementById('answerEngine');
const claudeHint        = document.getElementById('claude-hint');
const claudeModelEl     = document.getElementById('claudeModel');
const claudeModelRow    = document.getElementById('claude-model-row');
const openaiModelEl     = document.getElementById('openaiModel');
const openaiModelRow    = document.getElementById('openai-model-row');
const saveBtn           = document.getElementById('save-btn');
const saveMsg           = document.getElementById('save-msg');
const tabs              = document.querySelectorAll('.tab');
const fakeCursor        = document.getElementById('fake-cursor');
const appEl             = document.getElementById('app');

// ── Fake cursor: visible locally, invisible on share ─────────────────────────
appEl.addEventListener('mouseenter', () => fakeCursor.classList.add('visible'));
appEl.addEventListener('mouseleave', () => fakeCursor.classList.remove('visible'));
document.addEventListener('mousemove', (e) => {
  fakeCursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
});

// ── Keyboard resize — Ctrl+Shift+Arrow (no OS cursor, no share leak) ─────────
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey && e.shiftKey) || e.altKey) return;
  const step = e.repeat ? 15 : 30;
  let dw = 0, dh = 0;
  switch (e.key) {
    case 'ArrowRight': dw =  step; break;
    case 'ArrowLeft':  dw = -step; break;
    case 'ArrowDown':  dh =  step; break;
    case 'ArrowUp':    dh = -step; break;
    default: return;
  }
  e.preventDefault();
  window.electronAPI.resizeBy(dw, dh);
});

// ── Live "which prompt is active" badge next to the custom-prompt box ───────────
// Alt+Shift+B toggles useCustomPrompt between System ⇄ Custom; the badge always
// reflects the current mode so it's visible mid-interview without opening Settings.
function updatePromptStatus() {
  if (!promptStatusEl) return;
  const typed = customPromptEl?.value.trim() || '';
  if (useCustomPrompt) {
    if (typed) {
      promptStatusEl.textContent = '🔀 CUSTOM prompt active (Alt+Shift+B)';
      promptStatusEl.className = 'active';
    } else {
      promptStatusEl.textContent = '🔀 CUSTOM mode, but box is empty → falling back to System prompt (Alt+Shift+B)';
      promptStatusEl.className = '';
    }
  } else {
    const { systemPrompt } = getSettings();
    promptStatusEl.textContent = `🔀 SYSTEM prompt active — ${systemPrompt ? 'Settings' : 'default'} (Alt+Shift+B)`;
    promptStatusEl.className = '';
  }
}
customPromptEl?.addEventListener('input', updatePromptStatus);

// Global hotkey Alt+Shift+B (registered in main.js) flips System ⇄ Custom.
window.electronAPI.onTogglePromptMode?.(() => {
  useCustomPrompt = !useCustomPrompt;
  updatePromptStatus();
  console.log('[llm] 🔀 prompt mode toggled →', useCustomPrompt ? 'CUSTOM' : 'SYSTEM');
});

// ── Load saved system prompt ──────────────────────────────────────────────────
(function loadSettings() {
  try {
    let s = JSON.parse(localStorage.getItem('ai_settings') || '{}');
    // One-time migration: ChatGPT is now the default answer engine. Runs once
    // so an engine explicitly chosen (and Saved) afterward is never overridden.
    if (!s._defaultEngineMigrated) {
      s.answerEngine = 'openai';
      s._defaultEngineMigrated = true;
      localStorage.setItem('ai_settings', JSON.stringify(s));
    }
    if (s.systemPrompt) systemPromptEl.value = s.systemPrompt;
    if (s.useLocalWhisper) {
      useLocalWhisperEl.checked = true;
      localWhisperHint.classList.remove('hidden');
    }
    answerEngineEl.value = s.answerEngine || 'openai';
    if (claudeModelEl) claudeModelEl.value = s.anthropicModel || 'claude-opus-4-8';
    if (openaiModelEl) openaiModelEl.value = s.openaiModel || 'gpt-4o';
    updateEngineUI(answerEngineEl.value);
    // Pre-fill key fields (password inputs → masked)
    apiKeyEl.value  = s.anthropicKey || '';
    groqKeyEl.value = GROQ_KEY;
  } catch (_) {}
  updatePromptStatus();
  // Fill the OpenAI model dropdown live from the key's available models.
  // Deferred so all module-level declarations below are initialized first.
  setTimeout(populateOpenAIModels, 0);
})();

// Writes a single key into ai_settings without touching the rest — used for
// changes that should apply instantly (e.g. picking an OpenAI model) rather than
// waiting for the Save button.
function persistSetting(key, value) {
  try {
    const s = JSON.parse(localStorage.getItem('ai_settings') || '{}');
    s[key] = value;
    localStorage.setItem('ai_settings', JSON.stringify(s));
  } catch (_) {}
}

// ── Tabs — switch freely even while capturing ─────────────────────────────────
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const newMode = tab.dataset.mode;
    if (newMode === currentMode) return;

    // Stop current capture; keep textarea text intact
    if (isCaptureActive) stopCapture();
    // mic toggle keeps running across tab switches

    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentMode = newMode;
    syncCaptureBtn();
    if (!isCaptureActive && !isMicActive) setStatus('idle');
  });
});

// ── Close / settings ──────────────────────────────────────────────────────────
// Close button must fully release mic/audio tracks — otherwise the OS keeps the
// mic indicator lit and other sites/apps see the mic as in-use by MeetingAI.
closeBtn.addEventListener('click', () => {
  if (isCaptureActive) stopCapture();
  if (isMicActive) stopMicToggle();
  window.electronAPI.closeWindow();
});
settingsBtn.addEventListener('click', () => settingsPanel.classList.toggle('hidden'));
settingsClose.addEventListener('click', () => settingsPanel.classList.add('hidden'));

// ── Opacity slider ────────────────────────────────────────────────────────────
opacitySlider.addEventListener('input', (e) => {
  window.electronAPI.setOpacity(parseFloat(e.target.value));
});

// ── Eye toggles ───────────────────────────────────────────────────────────────
[['eyeBtn1', 'apiKey'], ['eyeBtn2', 'groqKey']].forEach(([btnId, inputId]) => {
  document.getElementById(btnId)?.addEventListener('click', () => {
    const el   = document.getElementById(inputId);
    const show = el.type === 'password';
    el.type    = show ? 'text' : 'password';
    document.getElementById(btnId).textContent = show ? '🙈' : '👁';
  });
});

// ── Save settings ─────────────────────────────────────────────────────────────
saveBtn.addEventListener('click', () => {
  const systemPrompt    = systemPromptEl.value.trim();
  const useLocalWhisper = useLocalWhisperEl.checked;
  const answerEngine    = answerEngineEl.value;
  const anthropicKey    = apiKeyEl.value.trim();
  const anthropicModel  = claudeModelEl.value;
  const openaiModel     = openaiModelEl.value;
  localStorage.setItem('ai_settings', JSON.stringify({
    systemPrompt, useLocalWhisper, answerEngine, anthropicKey, anthropicModel, openaiModel,
    _defaultEngineMigrated: true,   // preserve — prevents the one-time engine migration from re-firing
  }));
  showSaveMsg('✓ Saved!', 'green');
  updatePromptStatus();
  setTimeout(() => settingsPanel.classList.add('hidden'), 1000);
});

useLocalWhisperEl.addEventListener('change', (e) => {
  localWhisperHint.classList.toggle('hidden', !e.target.checked);
});

answerEngineEl.addEventListener('change', (e) => {
  updateEngineUI(e.target.value);
  // Refresh the model list the first time OpenAI is picked (models rarely change,
  // so a cached first fill is enough — no need to refetch on every switch).
  if (e.target.value === 'openai') populateOpenAIModels();
});

// Switching the model in the dropdown takes effect immediately (next Send) —
// persist it right away so the user doesn't have to press Save to change models.
openaiModelEl?.addEventListener('change', () => {
  persistSetting('openaiModel', openaiModelEl.value);
  console.log('[llm] OpenAI model →', openaiModelEl.value);
});

function updateEngineUI(engine) {
  claudeHint.classList.toggle('hidden', engine !== 'claude');
  claudeModelRow.classList.toggle('hidden', engine !== 'claude');
  openaiModelRow.classList.toggle('hidden', engine !== 'openai');
}

// ── OpenAI model dropdown — filled live from the key's available models ────────
// Curated fallback (matches index.html) used if the /v1/models call fails offline.
const OPENAI_MODELS_FALLBACK = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'];

// Keep only text chat-completion models: gpt-*, o1/o3/o4, chatgpt-*, minus the
// non-chat modalities (image/audio/realtime/tts/transcribe/embeddings/…) and the
// Responses-API-only variants (-pro, codex, deep-research) that /v1/chat rejects.
function isOpenAIChatModel(id) {
  if (!/^(gpt-|o1|o3|o4|chatgpt-)/.test(id)) return false;
  return !/(image|audio|realtime|transcrib|tts|search|embedding|instruct|codex|deep-research|moderation|whisper|dall|-pro\b|luna|sol|terra)/.test(id);
}

let openaiModelsLoaded = false;
async function populateOpenAIModels(force = false) {
  if (!openaiModelEl || !OPENAI_KEY) return;
  if (openaiModelsLoaded && !force) return;   // fill once per session
  const saved = getSettings().openaiModel || 'gpt-4o';

  let ids;
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
    });
    if (!res.ok) throw new Error('models HTTP ' + res.status);
    const data = await res.json();
    ids = (data.data || []).map(m => m.id).filter(isOpenAIChatModel)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));   // newest/highest first
    if (!ids.length) throw new Error('no chat models returned');
    console.log('[llm] OpenAI models loaded:', ids.length);
  } catch (e) {
    console.warn('[llm] OpenAI model list fetch failed — using fallback:', e.message);
    ids = OPENAI_MODELS_FALLBACK.slice();
  }

  // Never let the fill silently drop the user's saved choice.
  if (!ids.includes(saved)) ids.unshift(saved);

  openaiModelEl.innerHTML = ids.map(id => `<option value="${id}">${id}</option>`).join('');
  openaiModelEl.value = saved;
  openaiModelsLoaded = true;
}

function showSaveMsg(msg, color) {
  saveMsg.textContent = msg;
  saveMsg.style.color = color === 'green' ? '#3fb950' : '#f85149';
  setTimeout(() => { saveMsg.textContent = ''; }, 3000);
}

// ── Clear history ─────────────────────────────────────────────────────────────
clearHistoryBtn.addEventListener('click', () => {
  conversationHistory = [];
  setResponse('History cleared.', 'muted');
  setTimeout(() => setResponse('Response will appear here...', 'muted'), 1500);
});

// ── Send / Stop button ────────────────────────────────────────────────────────
sendBtn.addEventListener('click', async () => {
  // If a response is in flight, this button acts as Stop
  if (isWaitingForResponse) {
    if (claudeAbortController) claudeAbortController.abort();
    return;
  }
  const text = inputTextarea.value.trim();
  if (!text) return;
  inputTextarea.value = '';
  await sendToClaude(text);
});

inputTextarea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendBtn.click();
  }
});

// ── Main capture button ───────────────────────────────────────────────────────
captureBtn.addEventListener('click', async () => {
  if (isCaptureActive) {
    stopCapture();
  } else {
    if (currentMode === 'meeting') {
      await startSystemCapture();
    } else {
      startMainMicCapture();
    }
  }
});

// ── 🎙 Mic toggle button (user's own voice → textarea) ────────────────────────
micBtn.addEventListener('click', () => {
  if (isMicActive) {
    stopMicToggle();
  } else {
    startMicToggle();
  }
});

// ── Global-shortcut bridges: Alt+Shift+M (mic) / Alt+Shift+S (start/stop) ─────
// Let the OS-level hotkeys (registered in main.js) drive the same click
// handlers above, so they work even when this window isn't focused.
window.electronAPI.onToggleMic?.(() => micBtn.click());
window.electronAPI.onToggleCapture?.(() => captureBtn.click());

// ═══════════════════════════════════════════════════════════════════════════════
//  SYSTEM AUDIO CAPTURE (Meeting mode)
//  desktopCapturer → MediaRecorder → Groq whisper-large-v3-turbo → textarea
// ═══════════════════════════════════════════════════════════════════════════════
async function startSystemCapture() {
  setStatus('connecting');
  try {
    mediaStream = await getSystemAudioStream();
    isCaptureActive = true;
    syncCaptureBtn();
    setStatus('listening');
    startChunkedRecording();
  } catch (err) {
    console.error('System audio error:', err);
    setResponse('⚠️ ' + err.message, 'error');
    setStatus('error');
    cleanupSystemAudio();
  }
}

async function getSystemAudioStream() {
  // Approach 1: Electron desktopCapturer
  try {
    const sources = await window.electronAPI.getDesktopSources();
    if (sources && sources.length > 0) {
      const source = sources.find(s => s.name.toLowerCase().includes('screen')) || sources[0];
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id } },
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxWidth: 1, maxHeight: 1, maxFrameRate: 1 } }
      });
      stream.getVideoTracks().forEach(t => t.stop());
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        console.log('[audio] desktopCapturer:', audioTrack.label);
        return new MediaStream([audioTrack]);
      }
      stream.getTracks().forEach(t => t.stop());
    }
  } catch (e) { console.warn('[audio] desktopCapturer failed:', e.message); }

  // Approach 2: Loopback device (Stereo Mix / Wave Out Mix)
  try {
    const temp = await navigator.mediaDevices.getUserMedia({ audio: true });
    temp.getTracks().forEach(t => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    const kw = ['stereo mix', 'loopback', 'what u hear', 'wave out', 'mix', 'output'];
    const dev = devices.find(d =>
      d.kind === 'audioinput' && kw.some(k => d.label.toLowerCase().includes(k))
    );
    if (dev) {
      console.log('[audio] Loopback device:', dev.label);
      return await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: dev.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
    }
  } catch (e) { console.warn('[audio] Loopback failed:', e.message); }

  throw new Error(
    'Cannot capture system audio.\n' +
    'Fix: Right-click speaker → Sound Settings → Recording tab → right-click empty area → "Show Disabled Devices" → Enable "Stereo Mix"'
  );
}

function startChunkedRecording() {
  if (!mediaStream) return;
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find(m =>
    MediaRecorder.isTypeSupported(m)
  ) || '';

  mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : {});
  audioChunks = [];

  mediaRecorder.ondataavailable = (e) => {
    if (e.data?.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    if (!isCaptureActive) return;
    const chunks = [...audioChunks];
    audioChunks = [];

    if (chunks.length > 0) {
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      // VAD: webm/opus encodes silence to <~800 bytes — skip to save Groq quota
      if (blob.size >= MIN_BLOB_BYTES) {
        transcribeAudio(blob);
      }
    }

    if (isCaptureActive && mediaStream) {
      try {
        mediaRecorder.start();
        chunkTimer = setTimeout(() => {
          if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
        }, CHUNK_INTERVAL_MS);
      } catch (_) {}
    }
  };

  mediaRecorder.start();
  chunkTimer = setTimeout(() => {
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
  }, CHUNK_INTERVAL_MS);
}

async function transcribeWithGroq(blob, retry = 0) {
  try {
    const form = new FormData();
    form.append('file', blob, 'audio.webm');
    form.append('model', GROQ_MODEL);
    form.append('language', 'en');
    form.append('response_format', 'json');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}` },
      body:    form
    });

    // Rate limited (429) — wait 2s and retry once
    if (res.status === 429 && retry === 0) {
      await new Promise(r => setTimeout(r, 2000));
      return transcribeWithGroq(blob, 1);
    }

    if (!res.ok) { console.warn('Groq error:', res.status, await res.json().catch(() => ({}))); return; }

    const data = await res.json();
    const text = (data.text || '').trim();
    if (!text || text.length < 3) return;

    appendToTextarea(text);
  } catch (err) {
    console.warn('Transcription error:', err.message);
  }
}

// Dispatcher — picks local Whisper or Groq based on settings
async function transcribeAudio(blob) {
  const { useLocalWhisper } = getSettings();
  if (useLocalWhisper) return transcribeLocal(blob);
  return transcribeWithGroq(blob);
}

async function transcribeLocal(blob) {
  try {
    const form = new FormData();
    form.append('file', blob, 'audio.webm');
    form.append('response-format', 'json');
    form.append('language', 'en');

    const res = await fetch(LOCAL_WHISPER_URL, { method: 'POST', body: form });
    if (!res.ok) { console.warn('Local Whisper error:', res.status); return; }

    const data = await res.json();
    const text = (data.text || '').trim();
    if (!text || text.length < 3) return;
    appendToTextarea(text);
  } catch (err) {
    console.warn('Local Whisper unreachable:', err.message);
    appendToResponse('\n⚠️ Local Whisper server not running on port 2022. Start it or switch to Groq in Settings.', 'error');
  }
}

function cleanupSystemAudio() {
  clearTimeout(chunkTimer);
  if (mediaRecorder?.state !== 'inactive') { try { mediaRecorder.stop(); } catch (_) {} }
  mediaStream?.getTracks().forEach(t => t.stop());
  mediaStream = null; mediaRecorder = null; audioChunks = [];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MIC CAPTURE — main capture in "My Mic" mode
//  getUserMedia → MediaRecorder → Groq Whisper → textarea
// ═══════════════════════════════════════════════════════════════════════════════
async function startMainMicCapture() {
  setStatus('connecting');
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    isCaptureActive = true;
    syncCaptureBtn();
    setStatus('listening');
    startChunkedRecording();
  } catch (err) {
    console.error('Mic capture error:', err);
    appendToResponse('\n⚠️ ' + err.message, 'error');
    setStatus('error');
    cleanupSystemAudio();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  🎙 MIC TOGGLE — separate button, always captures user's own voice → textarea
//  Uses Groq Whisper so it works without Google/network dependency
// ═══════════════════════════════════════════════════════════════════════════════
async function startMicToggle() {
  try {
    micToggleStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    isMicActive = true;
    micBtn.classList.add('active');
    if (!isCaptureActive) setStatus('listening');

    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find(m =>
      MediaRecorder.isTypeSupported(m)
    ) || '';
    micToggleRecorder = new MediaRecorder(micToggleStream, mimeType ? { mimeType } : {});
    micToggleChunks   = [];

    micToggleRecorder.ondataavailable = (e) => {
      if (e.data?.size > 0) micToggleChunks.push(e.data);
    };

    micToggleRecorder.onstop = async () => {
      if (!isMicActive) return;
      const chunks = [...micToggleChunks];
      micToggleChunks = [];
      if (chunks.length > 0) {
        const blob = new Blob(chunks, { type: micToggleRecorder.mimeType || 'audio/webm' });
        if (blob.size >= MIN_BLOB_BYTES) transcribeAudio(blob);
      }
      if (isMicActive && micToggleStream) {
        try {
          micToggleRecorder.start();
          micToggleTimer = setTimeout(() => {
            if (micToggleRecorder?.state === 'recording') micToggleRecorder.stop();
          }, CHUNK_INTERVAL_MS);
        } catch (_) {}
      }
    };

    micToggleRecorder.start();
    micToggleTimer = setTimeout(() => {
      if (micToggleRecorder?.state === 'recording') micToggleRecorder.stop();
    }, CHUNK_INTERVAL_MS);
  } catch (err) {
    console.error('Mic toggle error:', err);
    appendToResponse('\n⚠️ Mic: ' + err.message, 'error');
    stopMicToggle();
  }
}

function stopMicToggle() {
  isMicActive = false;
  micBtn.classList.remove('active');
  clearTimeout(micToggleTimer);
  if (micToggleRecorder?.state !== 'inactive') { try { micToggleRecorder.stop(); } catch (_) {} }
  micToggleStream?.getTracks().forEach(t => t.stop());
  micToggleStream = null; micToggleRecorder = null; micToggleChunks = [];
  if (!isCaptureActive) setStatus('idle');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STOP MAIN CAPTURE
// ═══════════════════════════════════════════════════════════════════════════════
function stopCapture() {
  isCaptureActive = false;
  cleanupSystemAudio();
  syncCaptureBtn();
  if (!isMicActive) setStatus('idle');
}

// ── Sync capture button label/style ──────────────────────────────────────────
function syncCaptureBtn() {
  if (isCaptureActive) {
    captureBtn.textContent = '⏹ Stop';
    captureBtn.className   = 'btn-stop';
  } else {
    captureBtn.textContent = currentMode === 'meeting' ? '▶ Meeting' : '▶ Listen';
    captureBtn.className   = 'btn-start';
  }
}

// ── Append transcribed/recognized text to input textarea ─────────────────────
function appendToTextarea(text) {
  const cur = inputTextarea.value;
  inputTextarea.value = cur + (cur && !cur.endsWith('\n') && !cur.endsWith(' ') ? ' ' : '') + text;
  inputTextarea.scrollTop = inputTextarea.scrollHeight;
}

// Default interview-coach system prompt — shared by text answers and screenshot analysis.
const DEFAULT_SYSTEM_PROMPT = `You are an experienced Software Engineer with over 15 years of experience who has successfully cleared interviews at Google, Amazon, Microsoft, Meta, Apple, Uber, Walmart, Adobe, Atlassian, and other top product-based companies.

You are NOT the interviewer.

You are the interview candidate.

Your responsibility is to answer every theoretical interview question exactly as if you are speaking to a real interviewer.

The user should be able to directly repeat your answer during the interview without making any modifications.

Always answer in the FIRST PERSON.

Never sound like ChatGPT.

Never sound like an AI assistant.

Never sound like a textbook.

Never say "As an AI..."

Always sound natural, confident, and conversational.

Use simple English while maintaining technical accuracy.

Think step by step before answering.

Always explain WHY before HOW.

If multiple valid answers exist, explain the most commonly accepted one first and then briefly mention alternatives.

Never guess technical facts.

If you are uncertain about any technical detail, clearly mention the assumption instead of making up information.

====================================================
RESPONSE STRUCTURE
====================================================

Whenever I ask any theoretical interview question related to Java, Spring Boot, Angular, React, JavaScript, TypeScript, SQL, DBMS, OOP, Operating Systems, Computer Networks, JVM, Collections, Multithreading, Design Patterns, Microservices, Docker, Kubernetes, AWS, System Design concepts, or any software engineering topic, always follow this exact structure.

----------------------------------------------------
1. Direct Interview Answer
----------------------------------------------------

Start by directly answering the interviewer's question.

Example:

"Sure.

HashMap is a data structure that stores key-value pairs. Internally, it uses hashing to provide fast insertion, deletion, and lookup operations."

Do not delay the answer.

----------------------------------------------------
2. Explain the Concept
----------------------------------------------------

Explain:

• What it is

• Why it exists

• What problem it solves

• Why developers use it

• When it should be used

• When it should NOT be used

Keep the explanation natural and conversational.

----------------------------------------------------
3. Internal Working
----------------------------------------------------

Explain exactly how it works internally in a step-by-step manner.

Whenever applicable, explain:

• Memory layout

• Object creation

• Internal data structures

• Execution flow

• Lifecycle

• Thread execution

• Synchronization

• Garbage Collection

• Hashing

• Indexing

• Dependency Injection

• Bean Lifecycle

• Request Lifecycle

• Change Detection

• Virtual DOM

• Transactions

• Connection Pooling

• Caching

or any other relevant internal implementation.

Always explain WHY each internal step happens.

----------------------------------------------------
4. Real-World Analogy
----------------------------------------------------

Provide one simple real-world analogy that makes the concept easy to understand.

----------------------------------------------------
5. Practical Project Example
----------------------------------------------------

Give one practical software development example explaining where and why this concept is used in a real project.

----------------------------------------------------
6. Code Example (If Applicable)
----------------------------------------------------

If the concept involves programming, write clean Java code.

Use meaningful variable names.

Add comments only for important logic.

After writing the code, explain every important line.

Explain:

• Why this line is written.

• What it does.

• What would happen if it were removed.

----------------------------------------------------
7. Advantages
----------------------------------------------------

Explain all major advantages.

----------------------------------------------------
8. Disadvantages
----------------------------------------------------

Explain all limitations and disadvantages.

Also mention situations where this concept is NOT the right choice.

----------------------------------------------------
9. Comparison (Whenever Applicable)
----------------------------------------------------

If there is a similar concept, compare both.

Examples:

• HashMap vs Hashtable

• ArrayList vs LinkedList

• HashSet vs TreeSet

• Process vs Thread

• TCP vs UDP

• Interface vs Abstract Class

• Spring vs Spring Boot

• Angular vs React

• REST vs GraphQL

Compare them in terms of:

• Performance

• Memory

• Use cases

• Advantages

• Disadvantages

• When to choose each one

----------------------------------------------------
10. Common Interview Follow-up Questions
----------------------------------------------------

Mention the most common follow-up questions that an interviewer may ask after this question.

Answer each follow-up question as well

----------------------------------------------------
12. Final Interview Summary
----------------------------------------------------

End exactly like a confident interview candidate.

For example:

"So, that's why I prefer using HashMap in most single-threaded applications because it provides average O(1) lookup performance. However, if thread safety is required, I would choose ConcurrentHashMap instead."

====================================================
GLOBAL RULES
====================================================

• Always answer in first person.

• Always explain WHY before HOW.

• Never skip the internal working.

• Never give shallow explanations.

• Never sound robotic.

• Never use overly academic language.

• Prefer practical explanations over theoretical jargon.

• Always include real-world examples whenever possible.

• Always include practical project examples whenever applicable.

• Always include interview follow-up questions.

• Always explain trade-offs.

• If the question is about a framework, explain its architecture and request lifecycle whenever relevant.

• If the question is about a data structure or algorithmic concept, explain its internal implementation and complexity whenever relevant.

• If the question is about Java, always explain JVM-related behavior wherever applicable.

The response should sound exactly like an experienced software engineer confidently explaining the concept during a real technical interview.`;

// ═══════════════════════════════════════════════════════════════════════════════
//  CLAUDE API (streaming) — sends full history for context
// ═══════════════════════════════════════════════════════════════════════════════
async function sendToClaude(text) {
  isWaitingForResponse = true;
  // Turn Send → Stop so user can cancel this response and send a new one
  sendBtn.disabled = false;
  sendBtn.textContent = '⏹ Stop';
  sendBtn.classList.add('btn-stop-response');
  setStatus('thinking');

  // Alt+Shift+B toggle picks the mode; within CUSTOM mode, an empty box still
  // falls back to Settings prompt / default so we never send an empty system prompt.
  const typedPrompt = customPromptEl?.value.trim() || '';
  const { systemPrompt } = getSettings();
  const system = useCustomPrompt
    ? (typedPrompt || systemPrompt || DEFAULT_SYSTEM_PROMPT)
    : (systemPrompt || DEFAULT_SYSTEM_PROMPT);
  logPromptSource(useCustomPrompt && typedPrompt, systemPrompt, system);

  // Add user turn to history
  conversationHistory.push({ role: 'user', content: text });
  if (conversationHistory.length > MAX_HISTORY) conversationHistory = conversationHistory.slice(-MAX_HISTORY);

  claudeAbortController = new AbortController();
  // Idle timeout: aborts only if no chunk arrives for STREAM_IDLE_MS.
  // Resets on every chunk so long answers stream freely.
  let idleTimer = setTimeout(() => claudeAbortController.abort(), STREAM_IDLE_MS);
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => claudeAbortController.abort(), STREAM_IDLE_MS);
  };

  let assembled = '';
  let questionShown = false;
  const onText = (delta) => {
    if (!questionShown) { setStatus('responding'); appendNewQuestion(text); questionShown = true; }
    assembled   += delta;
    responseRaw += delta;
    scheduleRender();
  };

  try {
    // Route to the chosen answer engine: local Ollama (free) or Claude (Anthropic API)
    const engine = getSettings().answerEngine;
    console.log('[llm] ▶ engine=' + engine + ' · history=' + conversationHistory.length + ' msgs · Q="' + text.slice(0, 80) + '"');
    const t0 = performance.now();
    if (engine === 'claude') {
      await streamAnthropic(system, conversationHistory, resetIdle, onText);
    } else if (engine === 'openai') {
      await streamOpenAI(system, conversationHistory, resetIdle, onText);
    } else {
      await streamClaudeOnce(system, conversationHistory, resetIdle, onText);
    }
    console.log('[llm] ✓ done in ' + ((performance.now() - t0) / 1000).toFixed(1) + 's · ' + assembled.length + ' chars');
    renderResponseNow();   // force a final, immediate flush past the rAF throttle
    saveAssistant(assembled);
  } catch (err) {
    if (err.name !== 'AbortError') console.error('[llm] ✗ failed:', err);
    if (err.name === 'AbortError') {
      appendToResponse('\n⏹ Stopped.', '');
      if (assembled) saveAssistant(assembled);
      else if (conversationHistory.length && conversationHistory[conversationHistory.length - 1].role === 'user') {
        conversationHistory.pop();
      }
    } else {
      appendToResponse('\n⚠️ ' + err.message, 'error');
      if (assembled) saveAssistant(assembled);
      else conversationHistory.pop();
    }
  } finally {
    clearTimeout(idleTimer);
    resetAfterResponse();
  }
}

// Streams one Ollama call using its /api/chat endpoint (ndjson streaming).
// Returns the stop reason: 'stop' when done, null otherwise.
// onText fires per text delta; onResetIdle fires per network chunk.
async function streamClaudeOnce(system, messages, onResetIdle, onText) {
  // Convert conversation history to Ollama's chat format
  const ollamaMessages = [
    { role: 'system', content: system },
    ...messages.map(m => ({ role: m.role, content: m.content }))
  ];

  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    signal: claudeAbortController.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:   OLLAMA_MODEL,
      messages: ollamaMessages,
      stream:  true
    })
  });

  console.log('[llm] Ollama response status', res.status);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('[llm] Ollama error', res.status, JSON.stringify(err));
    throw new Error(err?.error || `Ollama error (${res.status}). Is Ollama running?`);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', stopReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onResetIdle();

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch (_) { continue; }

      // Ollama streams ndjson: each line has {message: {content: "..."}, done: bool}
      if (parsed.message?.content) {
        onText(parsed.message.content);
      }
      if (parsed.done) {
        stopReason = 'stop';
      }
      if (parsed.error) {
        throw new Error(parsed.error);
      }
    }
  }

  return stopReason;
}

// Streams one Claude (Anthropic Messages API) call — SSE. onText fires per text delta.
// `anthropic-dangerous-direct-browser-access` lets us call the API from the renderer.
async function streamAnthropic(system, messages, onResetIdle, onText) {
  const key = getSettings().anthropicKey;
  if (!key) throw new Error('No Anthropic API key — add it in ⚙ Settings.');
  const model = getSettings().anthropicModel || ANTHROPIC_MODEL;
  console.log('[llm] Claude request →', model);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: claudeAbortController.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      // Anthropic requires max_tokens — set it to each model's maximum output so
      // answers are effectively uncapped (Haiku tops out at 64K, others at 128K).
      max_tokens: /haiku/.test(model) ? 64000 : 128000,
      system,
      stream: true,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    }),
  });

  console.log('[llm] Claude response status', res.status);
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    const msg = e?.error?.message || `Claude error (${res.status}).`;
    console.error('[llm] Claude error', res.status, JSON.stringify(e));
    if (res.status === 401) throw new Error('Invalid Anthropic API key.');
    if (res.status === 400 && /credit|balance/i.test(msg)) throw new Error('Claude: out of credits — top up at console.anthropic.com.');
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onResetIdle();

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;          // ignore "event:" lines
      const data = t.slice(5).trim();
      let obj;
      try { obj = JSON.parse(data); } catch (_) { continue; }
      if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') {
        onText(obj.delta.text);
      } else if (obj.type === 'error') {
        throw new Error(obj.error?.message || 'Claude stream error.');
      } else if (obj.type === 'message_stop') {
        return 'stop';
      }
    }
  }
  return 'stop';
}

// Streams one OpenAI (Chat Completions) call — SSE. onText fires per text delta.
async function streamOpenAI(system, messages, onResetIdle, onText) {
  const model = getSettings().openaiModel || 'gpt-4o';
  console.log('[llm] OpenAI request →', model);

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: claudeAbortController.signal,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      // No token cap — omitting the limit lets each model generate up to its own
      // maximum (and avoids the gpt-4-turbo 4096 ceiling erroring on a fixed value).
      model,
      stream: true,
      messages: [
        { role: 'system', content: system },
        ...messages.map(m => ({ role: m.role, content: m.content })),
      ],
    }),
  });

  console.log('[llm] OpenAI response status', res.status);
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    console.error('[llm] OpenAI error', res.status, JSON.stringify(e));
    if (res.status === 401) throw new Error('Invalid OpenAI API key.');
    throw new Error(e?.error?.message || `OpenAI error (${res.status}).`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onResetIdle();

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') return 'stop';
      let obj;
      try { obj = JSON.parse(data); } catch (_) { continue; }
      const delta = obj.choices?.[0]?.delta?.content;
      if (delta) onText(delta);
    }
  }
  return 'stop';
}

// Confirms — in the console — exactly which system prompt is being sent to the LLM
// for this question, and shows the first line so you can verify it's your text.
function logPromptSource(typedPrompt, settingsPrompt, finalSystem) {
  const source = typedPrompt ? 'CUSTOM PROMPT (typed box)' : settingsPrompt ? 'SETTINGS prompt' : 'DEFAULT prompt';
  const preview = finalSystem.split('\n')[0].slice(0, 100);
  console.log(`[llm] 📝 system prompt source: ${source} · "${preview}${finalSystem.length > 100 ? '…' : ''}"`);
}

function saveAssistant(text) {
  if (!text) return;
  conversationHistory.push({ role: 'assistant', content: text });
  if (conversationHistory.length > MAX_HISTORY) conversationHistory = conversationHistory.slice(-MAX_HISTORY);
}

function resetAfterResponse() {
  isWaitingForResponse = false;
  sendBtn.disabled = false;
  sendBtn.textContent = '↑ Send';
  sendBtn.classList.remove('btn-stop-response');
  claudeAbortController = null;
  setStatus(isCaptureActive || isMicActive ? 'listening' : 'idle');
  inputTextarea.focus();
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function setStatus(state) {
  const map = {
    idle:       { dot: '',       label: 'Idle' },
    connecting: { dot: 'yellow', label: 'Connecting...' },
    listening:  { dot: 'green',  label: 'Listening' },
    thinking:   { dot: 'yellow', label: 'Thinking...' },
    responding: { dot: 'yellow', label: 'Responding...' },
    error:      { dot: 'red',    label: 'Error' },
  };
  const s = map[state] || map.idle;
  statusDot.className     = s.dot;
  statusLabel.textContent = s.label;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MARKDOWN → HTML — the LLM answers in Markdown (headers, code fences, bold,
//  lists); this renders it properly instead of showing raw #/```/** symbols.
// ═══════════════════════════════════════════════════════════════════════════════
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Inline formatting within a single (already-escaped) line: `code`, **bold**, *italic*
function renderInline(text) {
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return text;
}

function renderMarkdown(raw) {
  const lines = raw.split('\n');
  let html = '', inList = false, paraBuf = [];
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  const flushPara = () => {
    if (paraBuf.length) {
      html += '<p>' + renderInline(escapeHtml(paraBuf.join('\n'))).replace(/\n/g, '<br>') + '</p>';
      paraBuf = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block ```lang ... ``` — content is never markdown-parsed
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushPara(); closeList();
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; // skip closing fence (or run off the end while still streaming — fine)
      html += `<pre class="md-code"><code>${escapeHtml(code.join('\n'))}</code></pre>`;
      continue;
    }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara(); closeList();
      html += '<hr>';
      i++; continue;
    }

    // Headers (#, ##, ###, ####)
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara(); closeList();
      html += `<div class="md-h md-h${h[1].length}">${renderInline(escapeHtml(h[2]))}</div>`;
      i++; continue;
    }

    // Bullet list item
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      flushPara();
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${renderInline(escapeHtml(li[1]))}</li>`;
      i++; continue;
    }

    // Blank line — paragraph/list boundary
    if (line.trim() === '') {
      flushPara(); closeList();
      i++; continue;
    }

    paraBuf.push(line);
    i++;
  }
  flushPara(); closeList();
  return html;
}

// Re-renders #response from responseRaw. Throttled to once per animation frame
// so a fast token stream doesn't re-parse the whole markdown on every delta.
function renderResponseNow() {
  responseEl.innerHTML = renderMarkdown(responseRaw);
  scrollIfAtBottom();
}
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; renderResponseNow(); });
}

function setResponse(text, cls) {
  responseRaw = text;
  responseEl.className = cls || '';
  renderResponseNow();
}

// Only auto-scroll if the user is already at (or within 60px of) the bottom
function scrollIfAtBottom() {
  const nearBottom = responseEl.scrollTop + responseEl.clientHeight >= responseEl.scrollHeight - 60;
  if (nearBottom) responseEl.scrollTop = responseEl.scrollHeight;
}

// Prepend a divider + question label before each new streamed answer
function appendNewQuestion(question) {
  const hasContent = responseRaw.trim() && !responseEl.classList.contains('muted');
  if (hasContent) {
    responseRaw += '\n\n' + '─'.repeat(40) + '\n';
  } else {
    responseRaw = '';
  }
  // Always reset to the normal (soothing) color for a new answer — a prior
  // failed question shouldn't leave this one tinted red.
  responseEl.className = '';
  const preview = question.length > 120 ? question.slice(0, 120) + '…' : question;
  responseRaw += '▶ Q: ' + preview + '\n\nA: ';
  renderResponseNow();
}

// Append text to response area without clearing previous answers
function appendToResponse(text, cls) {
  if (cls) responseEl.className = cls;
  responseRaw += text;
  renderResponseNow();
}

function getSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('ai_settings') || '{}');
    return {
      systemPrompt: saved.systemPrompt || '',
      useLocalWhisper: saved.useLocalWhisper || false,
      answerEngine: saved.answerEngine || 'openai',
      anthropicKey: saved.anthropicKey || '',
      anthropicModel: saved.anthropicModel || 'claude-opus-4-8',
      openaiModel: saved.openaiModel || 'gpt-4o',
    };
  } catch (_) { return { systemPrompt: '', useLocalWhisper: false, answerEngine: 'openai', anthropicKey: '', anthropicModel: 'claude-opus-4-8', openaiModel: 'gpt-4o' }; }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SCREENSHOT → TRANSCRIBE INTO INPUT BOX
//  Grabs the whole screen (works even when the shared app disables copying, e.g.
//  during a Zoom share), and uses a Groq vision call to TRANSCRIBE (not answer)
//  what's visible into the input textarea — so you can review/edit it before
//  pressing Send. The actual answer then comes from your selected engine
//  (OpenAI/Claude/Ollama), not the vision model.
// ═══════════════════════════════════════════════════════════════════════════════
const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
const screenshotBtn = document.getElementById('screenshot-btn');

screenshotBtn?.addEventListener('click', analyzeScreenshot);

// Visible progress (status line) + console log for the screenshot pipeline.
// Open the console with Alt+Shift+D to watch full [screenshot] timing logs.
function slog(msg) {
  console.log('[screenshot]', msg);
  if (statusLabel) statusLabel.textContent = msg;
}

async function analyzeScreenshot() {
  if (isWaitingForResponse) return;
  const t0 = performance.now();

  // 1) Capture the screen (main process hides our overlay, grabs a JPEG data URL).
  let dataUrl;
  try {
    slog('📸 Capturing screen…');
    screenshotBtn.disabled = true;
    dataUrl = await window.electronAPI.captureScreenshot();
    if (!dataUrl) throw new Error('Empty screenshot.');
  } catch (e) {
    setStatus('error');
    appendToResponse('\n⚠️ Screenshot failed: ' + e.message, 'error');
    screenshotBtn.disabled = false;
    setStatus(isCaptureActive || isMicActive ? 'listening' : 'idle');
    return;
  }
  const tCap = performance.now();
  const kb = Math.round(dataUrl.length / 1024);
  slog(`✅ Captured ${kb} KB in ${((tCap - t0) / 1000).toFixed(1)}s · reading screen…`);

  // 2) Enter the same "responding" state as a normal send (Stop button works).
  isWaitingForResponse = true;
  sendBtn.disabled = false;
  sendBtn.textContent = '⏹ Stop';
  sendBtn.classList.add('btn-stop-response');
  setStatus('thinking');

  // Whatever's already typed becomes guidance for what to pull out of the
  // screenshot (e.g. "just the function signature"). It does NOT stay in the
  // box — the transcription replaces it, ready for you to review and edit.
  const guidance = inputTextarea.value.trim();
  const transcribeSystem = 'You transcribe screenshots into plain text for someone who will review, edit, and then ask an AI about it. Read everything visible — questions, code, problem statements, constraints, examples — and output it as clean, accurate text exactly as shown. Preserve code structure, indentation, and line breaks (use markdown code fences for code). Do NOT answer, solve, explain, or add any commentary of your own — only transcribe what is visible, verbatim.';
  const userText = guidance
    ? `Transcribe this screenshot. Focus especially on: ${guidance}`
    : 'Transcribe everything visible in this screenshot — the full question, code, constraints, and examples.';

  claudeAbortController = new AbortController();
  let idleTimer = setTimeout(() => claudeAbortController.abort(), STREAM_IDLE_MS);
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => claudeAbortController.abort(), STREAM_IDLE_MS);
  };

  inputTextarea.value = '';
  let shown = false, tFirst = 0;
  const onText = (delta) => {
    if (!shown) {
      tFirst = performance.now();
      slog(`💬 First token after ${((tFirst - tCap) / 1000).toFixed(1)}s · filling textbox…`);
      shown = true;
    }
    inputTextarea.value += delta;
    inputTextarea.scrollTop = inputTextarea.scrollHeight;
  };

  try {
    await streamGroqVision(transcribeSystem, userText, dataUrl, resetIdle, onText);
    slog(`✅ Screenshot read in ${((performance.now() - t0) / 1000).toFixed(1)}s — review below, then press Send`);
  } catch (err) {
    if (err.name === 'AbortError') {
      slog('⏹ Stopped.');
    } else {
      console.error('[screenshot] ✗ failed:', err);
      appendToResponse('\n⚠️ Screenshot read failed: ' + err.message, 'error');
    }
  } finally {
    clearTimeout(idleTimer);
    screenshotBtn.disabled = false;
    resetAfterResponse();
  }
}

// Streams one Groq vision call (OpenAI-style SSE). onText fires per text delta.
async function streamGroqVision(system, userText, dataUrl, onResetIdle, onText) {
  if (!GROQ_KEY) throw new Error('No Groq API key set — screenshot analysis needs Groq vision.');

  const reqStart = performance.now();
  console.log('[screenshot] POST Groq vision →', GROQ_VISION_MODEL);
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    signal: claudeAbortController.signal,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: GROQ_VISION_MODEL,
      stream: true,
      temperature: 0.3,
      max_tokens: 8000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: dataUrl } },
        ] },
      ],
    }),
  });
  console.log(`[screenshot] Groq responded ${res.status} after ${((performance.now() - reqStart) / 1000).toFixed(1)}s`);

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.error?.message || `Vision model error (${res.status}). Check the Groq key / model.`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onResetIdle();

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') return 'stop';
      let parsed;
      try { parsed = JSON.parse(data); } catch (_) { continue; }
      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) onText(delta);
    }
  }
  return 'stop';
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHONE REMOTE INPUT — type on your phone (same Wi-Fi) → lands in the input box.
//  "Send to AI" also fires the answer; "Insert" just fills the box.
// ═══════════════════════════════════════════════════════════════════════════════
window.electronAPI.onPhoneInput?.(({ text, send }) => {
  if (typeof text !== 'string') return;
  // Append to whatever's already typed on the laptop — don't wipe it out.
  if (text.trim()) appendToTextarea(text.trim());
  if (send) {
    sendBtn.click();          // reuses the normal send flow (reads box → sends → clears)
  } else {
    inputTextarea.focus();
  }
});

// Show the phone URL in Settings so you know what to open on your phone.
window.electronAPI.getPhoneUrl?.().then(url => {
  const el = document.getElementById('phone-url');
  if (el && url) el.textContent = url;
}).catch(() => {});
