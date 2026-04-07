// Renderer — triple mode: Meeting Audio / My Mic / Paste

const CLAUDE_MODEL      = 'claude-sonnet-4-6';
const CHUNK_INTERVAL_MS = 5000;   // send audio chunk every 5s for transcription
const SILENCE_DELAY_MS  = 1000;   // send to Claude after 1s of silence
const MAX_HISTORY       = 20;     // max messages kept in context (10 turns)

let currentMode          = 'meeting';  // 'meeting' | 'mic' | 'paste'
let isListening          = false;
let isWaitingForResponse = false;
let silenceTimer         = null;
let accumulatedText      = '';         // builds up until silence → sent to Claude

// Conversation history — shared across all modes
let conversationHistory  = [];         // [{ role: 'user'|'assistant', content: string }]

// System audio capture refs
let mediaStream    = null;
let mediaRecorder  = null;
let audioChunks    = [];
let chunkTimer     = null;

// Mic speech recognition ref
let recognition = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const listenBtn      = document.getElementById('listen-btn');
const transcriptEl   = document.getElementById('transcript');
const transcriptBar  = document.getElementById('transcript-bar');
const pastePanel     = document.getElementById('paste-panel');
const pasteInput     = document.getElementById('paste-input');
const responseEl     = document.getElementById('response');
const statusDot      = document.getElementById('status-dot');
const statusLabel    = document.getElementById('status-label');
const closeBtn       = document.getElementById('close-btn');
const clearHistoryBtn= document.getElementById('clear-history-btn');
const settingsBtn    = document.getElementById('settings-btn');
const settingsPanel  = document.getElementById('settings-panel');
const settingsClose  = document.getElementById('settings-close');
const apiKeyEl       = document.getElementById('apiKey');
const groqKeyEl      = document.getElementById('groqKey');
const systemPromptEl = document.getElementById('systemPrompt');
const saveBtn        = document.getElementById('save-btn');
const saveMsg        = document.getElementById('save-msg');
const tabs           = document.querySelectorAll('.tab');

// ── Load settings ─────────────────────────────────────────────────────────────
(function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('ai_settings') || '{}');
    if (s.apiKey)       apiKeyEl.value       = s.apiKey;
    if (s.groqKey)      groqKeyEl.value      = s.groqKey;
    if (s.systemPrompt) systemPromptEl.value = s.systemPrompt;
  } catch (_) {}
})();

// ── Mode tabs ─────────────────────────────────────────────────────────────────
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    if (isListening) return; // don't switch while active
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const prev = currentMode;
    currentMode = tab.dataset.mode;

    if (currentMode === 'paste') {
      transcriptBar.classList.add('hidden');
      pastePanel.classList.remove('hidden');
      listenBtn.textContent = '↑ Send';
      listenBtn.className   = 'btn-start';
    } else {
      pastePanel.classList.add('hidden');
      transcriptBar.classList.remove('hidden');
      listenBtn.textContent = '▶ Start';
      listenBtn.className   = 'btn-start';
    }

    transcriptEl.textContent = '—';
    setResponse('Response will appear here...', 'muted');
    setStatus('idle');
  });
});

// ── Clear history ─────────────────────────────────────────────────────────────
clearHistoryBtn.addEventListener('click', () => {
  conversationHistory = [];
  setResponse('History cleared.', 'muted');
  setTimeout(() => setResponse('Response will appear here...', 'muted'), 1500);
});

// ── Paste: Ctrl+Enter to send ─────────────────────────────────────────────────
pasteInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    listenBtn.click();
  }
});

// ── Close / settings ──────────────────────────────────────────────────────────
closeBtn.addEventListener('click', () => window.electronAPI.closeWindow());
settingsBtn.addEventListener('click', () => settingsPanel.classList.toggle('hidden'));
settingsClose.addEventListener('click', () => settingsPanel.classList.add('hidden'));

// Eye toggles
[['eyeBtn1', 'apiKey'], ['eyeBtn2', 'groqKey']].forEach(([btnId, inputId]) => {
  document.getElementById(btnId).addEventListener('click', () => {
    const el   = document.getElementById(inputId);
    const show = el.type === 'password';
    el.type    = show ? 'text' : 'password';
    document.getElementById(btnId).textContent = show ? '🙈' : '👁';
  });
});

// Save settings
saveBtn.addEventListener('click', () => {
  const apiKey       = apiKeyEl.value.trim();
  const groqKey      = groqKeyEl.value.trim();
  const systemPrompt = systemPromptEl.value.trim();

  if (!apiKey) { showSaveMsg('Anthropic API key is required', 'red'); return; }
  if (!apiKey.startsWith('sk-ant')) { showSaveMsg('Key should start with sk-ant...', 'red'); return; }

  localStorage.setItem('ai_settings', JSON.stringify({ apiKey, groqKey, systemPrompt }));
  showSaveMsg('✓ Saved!', 'green');
  setTimeout(() => settingsPanel.classList.add('hidden'), 1000);
});

function showSaveMsg(msg, color) {
  saveMsg.textContent = msg;
  saveMsg.style.color = color === 'green' ? '#3fb950' : '#f85149';
  setTimeout(() => { saveMsg.textContent = ''; }, 3000);
}

// ── Listen / Send button ──────────────────────────────────────────────────────
listenBtn.addEventListener('click', async () => {

  // ── Paste mode: send pasted text ──────────────────────────────────────────
  if (currentMode === 'paste') {
    const text = pasteInput.value.trim();
    if (!text || isWaitingForResponse) return;
    const s = getSettings();
    if (!s.apiKey) {
      settingsPanel.classList.remove('hidden');
      showSaveMsg('Enter your Anthropic API key first', 'red');
      return;
    }
    pasteInput.value = '';
    await sendToClaude(text);
    return;
  }

  // ── Audio modes: toggle start/stop ────────────────────────────────────────
  if (isListening) {
    stopAll();
    return;
  }

  const s = getSettings();
  if (!s.apiKey) {
    settingsPanel.classList.remove('hidden');
    showSaveMsg('Enter your Anthropic API key first', 'red');
    return;
  }
  if (currentMode === 'meeting' && !s.groqKey) {
    settingsPanel.classList.remove('hidden');
    showSaveMsg('Enter your Groq API key for meeting audio mode', 'red');
    return;
  }

  if (currentMode === 'meeting') {
    await startMeetingAudio(s.groqKey);
  } else {
    startMicMode();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  MODE 1: MEETING AUDIO
//  Captures system audio (what plays through speakers = meeting participants)
//  Tries three approaches in order:
//    1. Electron desktopCapturer (chromeMediaSource: desktop)
//    2. Loopback audio device  (Stereo Mix / Wave Out Mix)
//    3. Clear error guiding the user to enable Stereo Mix
// ─────────────────────────────────────────────────────────────────────────────
async function startMeetingAudio(groqKey) {
  setStatus('connecting');
  setResponse('Connecting to system audio...', 'muted');

  try {
    mediaStream = await getSystemAudioStream();

    isListening = true;
    listenBtn.textContent = '⏹ Stop';
    listenBtn.className   = 'btn-stop';
    setStatus('listening');
    setResponse('Listening to meeting audio...', 'muted');
    accumulatedText = '';

    startChunkedRecording(groqKey);

  } catch (err) {
    console.error('System audio error:', err);
    setResponse('⚠️ ' + (err.message || 'Could not capture system audio'), 'error');
    setStatus('error');
    cleanupSystemAudio();
  }
}

// Try every available method to get a system-audio MediaStream.
// Returns the stream on success, throws a descriptive Error on total failure.
async function getSystemAudioStream() {

  // ── Approach 1: Electron desktopCapturer ─────────────────────────────────
  // Works on macOS reliably; works on Windows only when the driver exposes
  // WASAPI loopback through the screen-capture pipeline.
  try {
    const sources = await window.electronAPI.getDesktopSources();
    if (sources && sources.length > 0) {
      const source = sources.find(s => s.name.toLowerCase().includes('screen')) || sources[0];

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource:   'desktop',
            chromeMediaSourceId: source.id,
          }
        },
        video: {
          mandatory: {
            chromeMediaSource:   'desktop',
            chromeMediaSourceId: source.id,
            maxWidth:    1,
            maxHeight:   1,
            maxFrameRate: 1,
          }
        }
      });

      stream.getVideoTracks().forEach(t => t.stop());
      const audioTrack = stream.getAudioTracks()[0];

      if (audioTrack) {
        console.log('[audio] Using desktopCapturer track:', audioTrack.label);
        return new MediaStream([audioTrack]);
      }
      // Stream obtained but no audio track — clean up and fall through
      stream.getTracks().forEach(t => t.stop());
      console.warn('[audio] desktopCapturer gave no audio track, trying loopback...');
    }
  } catch (e) {
    console.warn('[audio] desktopCapturer approach failed:', e.message);
  }

  // ── Approach 2: Loopback input device (Stereo Mix / Wave Out Mix) ─────────
  // On Windows, "Stereo Mix" is a virtual recording device that mirrors the
  // speaker output. It must be enabled in Sound Settings → Recording tab.
  try {
    // Ask for mic permission first so labels are populated
    const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    tempStream.getTracks().forEach(t => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const LOOPBACK_KEYWORDS = [
      'stereo mix', 'loopback', 'what u hear', 'wave out',
      'sum', 'mix', 'output', 'speaker'
    ];

    const loopbackDevice = devices.find(d =>
      d.kind === 'audioinput' &&
      LOOPBACK_KEYWORDS.some(kw => d.label.toLowerCase().includes(kw))
    );

    if (loopbackDevice) {
      console.log('[audio] Using loopback device:', loopbackDevice.label);
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId:          { exact: loopbackDevice.deviceId },
          echoCancellation:  false,
          noiseSuppression:  false,
          autoGainControl:   false,
        }
      });
    }
    console.warn('[audio] No loopback device found among:', devices.filter(d => d.kind === 'audioinput').map(d => d.label));
  } catch (e) {
    console.warn('[audio] Loopback device approach failed:', e.message);
  }

  // ── Total failure ─────────────────────────────────────────────────────────
  throw new Error(
    'Cannot capture system audio.\n' +
    'Fix: Right-click the speaker icon → Sound Settings → Recording tab → ' +
    'right-click empty area → "Show Disabled Devices" → Enable "Stereo Mix" → retry.'
  );
}

function startChunkedRecording(groqKey) {
  if (!mediaStream) return;

  // Pick a supported mimeType
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find(m =>
    MediaRecorder.isTypeSupported(m)
  ) || '';

  mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : {});
  audioChunks   = [];

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    if (!isListening) return;

    const chunks = [...audioChunks];
    audioChunks  = [];

    if (chunks.length > 0) {
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      transcribeWithGroq(blob, groqKey);
    }

    // Restart for next chunk
    if (isListening && mediaStream) {
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

async function transcribeWithGroq(blob, groqKey) {
  try {
    const form = new FormData();
    form.append('file', blob, 'audio.webm');
    form.append('model', 'whisper-large-v3');
    form.append('language', 'en');
    form.append('response_format', 'json');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${groqKey}` },
      body:    form
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn('Groq error:', err);
      return;
    }

    const data = await res.json();
    const text = (data.text || '').trim();

    // Ignore empty or noise artifacts
    if (!text || text.length < 3) return;

    // Append to transcript display
    accumulatedText += (accumulatedText ? ' ' : '') + text;
    transcriptEl.textContent = accumulatedText;

    // Reset silence timer — send to Claude after SILENCE_DELAY_MS of quiet
    clearTimeout(silenceTimer);
    if (!isWaitingForResponse) {
      silenceTimer = setTimeout(() => {
        const toSend = accumulatedText.trim();
        if (toSend.split(/\s+/).length >= 3) {
          accumulatedText = '';
          sendToClaude(toSend);
        }
      }, SILENCE_DELAY_MS);
    }

  } catch (err) {
    console.warn('Transcription error:', err.message);
  }
}

function cleanupSystemAudio() {
  clearTimeout(chunkTimer);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch (_) {}
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  mediaRecorder = null;
  audioChunks   = [];
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODE 2: MY MIC
//  Web Speech API on the user's microphone (for user's own questions)
// ─────────────────────────────────────────────────────────────────────────────
function startMicMode() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setResponse('Speech recognition not available.', 'error');
    return;
  }

  recognition = new SR();
  recognition.continuous      = true;
  recognition.interimResults  = true;
  recognition.lang            = 'en-US';
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    isListening = true;
    listenBtn.textContent = '⏹ Stop';
    listenBtn.className   = 'btn-stop';
    setStatus('listening');
    setResponse('Listening to your mic...', 'muted');
    accumulatedText = '';
  };

  recognition.onresult = (event) => {
    if (!isListening || isWaitingForResponse) return;

    let interim = '', final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      event.results[i].isFinal ? (final += t) : (interim += t);
    }

    if (final) {
      accumulatedText += (accumulatedText ? ' ' : '') + final;
      transcriptEl.textContent = accumulatedText;

      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        const toSend = accumulatedText.trim();
        if (toSend.split(/\s+/).length >= 2) {
          accumulatedText = '';
          sendToClaude(toSend);
        }
      }, SILENCE_DELAY_MS);

    } else if (interim) {
      transcriptEl.textContent = accumulatedText + (accumulatedText ? ' ' : '') + interim;
    }
  };

  recognition.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    if (e.error === 'not-allowed') {
      setResponse('Microphone permission denied.', 'error');
      stopAll();
      return;
    }
  };

  recognition.onend = () => {
    if (isListening) {
      setTimeout(() => { try { recognition?.start(); } catch (_) {} }, 300);
    }
  };

  try { recognition.start(); } catch (e) {
    setResponse('Mic error: ' + e.message, 'error');
  }
}

// ── Stop everything ───────────────────────────────────────────────────────────
function stopAll() {
  isListening          = false;
  isWaitingForResponse = false;
  accumulatedText      = '';
  clearTimeout(silenceTimer);
  clearTimeout(chunkTimer);

  // Stop mic recognition
  if (recognition) {
    recognition.onend = null;
    recognition.stop();
    recognition = null;
  }

  // Stop system audio
  cleanupSystemAudio();

  listenBtn.textContent    = '▶ Start';
  listenBtn.className      = 'btn-start';
  transcriptEl.textContent = '—';
  setStatus('idle');
}

// ── Claude API (streaming) ────────────────────────────────────────────────────
async function sendToClaude(text) {
  const { apiKey, systemPrompt } = getSettings();
  if (!apiKey) return;

  isWaitingForResponse = true;
  setStatus('thinking');
  setResponse('', '');
  if (currentMode !== 'paste') transcriptEl.textContent = text;

  const system = systemPrompt ||
    'You are a helpful meeting assistant. Give fast, concise answers. Use bullet points for lists. Be brief and direct.';

  // Append user turn to history
  conversationHistory.push({ role: 'user', content: text });
  if (conversationHistory.length > MAX_HISTORY) {
    conversationHistory = conversationHistory.slice(-MAX_HISTORY);
  }

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      CLAUDE_MODEL,
        max_tokens: 1024,
        stream:     true,
        system,
        messages:   conversationHistory   // full history sent every time
      })
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setResponse('⚠️ ' + (err?.error?.message || `API error (${res.status})`), 'error');
      conversationHistory.pop(); // drop the failed user turn
      resetAfterResponse();
      return;
    }

    setStatus('responding');
    responseEl.className   = '';
    responseEl.textContent = '';

    const reader    = res.body.getReader();
    const decoder   = new TextDecoder();
    let buffer      = '';
    let doneSent    = false;
    let assistantText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (!doneSent) { saveAssistant(assistantText); resetAfterResponse(); }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
            assistantText          += parsed.delta.text;
            responseEl.textContent += parsed.delta.text;
            responseEl.scrollTop    = responseEl.scrollHeight;
          } else if (parsed.type === 'message_stop' && !doneSent) {
            doneSent = true; saveAssistant(assistantText); resetAfterResponse();
          } else if (parsed.type === 'error') {
            setResponse('⚠️ ' + (parsed.error?.message || 'Stream error'), 'error');
            conversationHistory.pop();
            doneSent = true; resetAfterResponse();
          }
        } catch (_) {}
      }
    }

  } catch (err) {
    clearTimeout(timeout);
    setResponse('⚠️ ' + (err.name === 'AbortError' ? 'Request timed out.' : err.message), 'error');
    conversationHistory.pop(); // drop the failed user turn
    resetAfterResponse();
  }
}

// Append assistant reply to history (called once streaming completes)
function saveAssistant(text) {
  if (!text) return;
  conversationHistory.push({ role: 'assistant', content: text });
  if (conversationHistory.length > MAX_HISTORY) {
    conversationHistory = conversationHistory.slice(-MAX_HISTORY);
  }
}

function resetAfterResponse() {
  isWaitingForResponse = false;
  if (currentMode !== 'paste') transcriptEl.textContent = '—';
  setStatus(isListening ? 'listening' : 'idle');
  if (currentMode === 'paste') pasteInput.focus();
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
  statusDot.className    = s.dot;
  statusLabel.textContent = s.label;
}

function setResponse(text, cls) {
  responseEl.textContent = text;
  responseEl.className   = cls || '';
}

function getSettings() {
  try { return JSON.parse(localStorage.getItem('ai_settings') || '{}'); }
  catch (_) { return {}; }
}
