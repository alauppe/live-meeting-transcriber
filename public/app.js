const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const state = {
  meetingId: crypto.randomUUID(),
  meetingTitle: 'Unsaved talk',
  activeScreen: 'lookups',
  config: { sttProvider: 'browser', uploadTranscriptionEnabled: false },
  recognition: null,
  sttSocket: null,
  mediaStream: null,
  audioContext: null,
  sourceNode: null,
  processorNode: null,
  zeroGainNode: null,
  dsp: { hpLastX: 0, hpLastY: 0, agcGain: 1 },
  isLive: false,
  startedAt: null,
  lastSegmentEnd: 0,
  lastProviderFinalKey: '',
  segments: [],
  topics: [],
  checks: [],
  agendaItems: [],
  slides: [],
  slideVersion: 0,
  slideTransitionReason: '',
  selectedSlideIndex: 0,
  selectedTopicSlug: null,
  selectedFactIndex: 0,
  selectedAgendaIndex: 0,
  selectedPreviousTalkId: null,
  savedTalks: [],
  slidePendingUpdates: [],
  slideReplacementTimer: null,
  lastSlideReplaceAt: 0,
  lastTopicRunAtSegment: 0,
  lastFactRunAtSegment: 0,
  lastSlideLoopSegment: 0,
  lastSlideLoopTopicCount: 0
};

const els = {
  navButtons: Array.from(document.querySelectorAll('.nav-btn')),
  screens: Array.from(document.querySelectorAll('.screen')),
  sectionMenu: document.querySelector('#sectionMenu'),
  screenTitle: document.querySelector('#screenTitle'),
  latestTranscript: document.querySelector('#latestTranscript'),
  meetingLabel: document.querySelector('#meetingLabel'),
  latestLookupMini: document.querySelector('#latestLookupMini'),
  latestFactMini: document.querySelector('#latestFactMini'),
  latestSlideMini: document.querySelector('#latestSlideMini'),
  latestLineMini: document.querySelector('#latestLineMini'),
  pulseButtons: Array.from(document.querySelectorAll('[data-pulse-screen]')),
  textSizeSelect: document.querySelector('#textSizeSelect'),
  startBtn: document.querySelector('#startBtn'),
  stopBtn: document.querySelector('#stopBtn'),
  demoBtn: document.querySelector('#demoBtn'),
  uploadForm: document.querySelector('#uploadForm'),
  recordingInput: document.querySelector('#recordingInput'),
  uploadStatus: document.querySelector('#uploadStatus'),
  previousTalkDetail: document.querySelector('#previousTalkDetail'),
  statusPill: document.querySelector('#statusPill'),
  transcript: document.querySelector('#transcript'),
  interim: document.querySelector('#interim'),
  askForm: document.querySelector('#askForm'),
  questionInput: document.querySelector('#questionInput'),
  answer: document.querySelector('#answer'),
  lookupFeed: document.querySelector('#lookupFeed'),
  topicDetail: document.querySelector('#topicDetail'),
  factChecks: document.querySelector('#factChecks'),
  agendaBtn: document.querySelector('#agendaBtn'),
  agenda: document.querySelector('#agenda'),
  buildSlidesBtn: document.querySelector('#buildSlidesBtn'),
  prevSlideBtn: document.querySelector('#prevSlideBtn'),
  nextSlideBtn: document.querySelector('#nextSlideBtn'),
  slideStage: document.querySelector('#slideStage')
};

const demoLines = [
  'Today we are reviewing a live meeting transcriber that uses xAI realtime speech to text through a backend WebSocket proxy.',
  'The first customer segment is healthcare, so HIPAA compliance and retention controls are required before production.',
  'The speaker claimed that SOC 2 audits always take less than three months, which should be verified before we repeat it.',
  'Next we need a pricing model that supports team workspaces, meeting storage, realtime fact checking, and generated slides as paid add-ons.',
  'Laptop microphones often create reverb, so the browser should apply echo cancellation, noise suppression, high-pass filtering, a gate, and light AGC before streaming.'
];
let demoIndex = 0;

els.startBtn.addEventListener('click', startMeeting);
els.stopBtn.addEventListener('click', stopMeeting);
els.demoBtn.addEventListener('click', addDemoLine);
for (const button of els.navButtons) {
  button.addEventListener('click', () => setScreen(button.dataset.screen));
}
for (const button of els.pulseButtons) {
  button.addEventListener('click', () => setScreen(button.dataset.pulseScreen));
}
els.textSizeSelect.addEventListener('change', () => setTextSize(els.textSizeSelect.value));
els.askForm.addEventListener('submit', askQuestion);
els.agendaBtn.addEventListener('click', generateAgenda);
els.uploadForm.addEventListener('submit', uploadRecording);
els.buildSlidesBtn.addEventListener('click', buildSlides);
els.prevSlideBtn.addEventListener('click', () => selectSlide(state.selectedSlideIndex - 1));
els.nextSlideBtn.addEventListener('click', () => selectSlide(state.selectedSlideIndex + 1));

init();

async function init() {
  state.savedTalks = loadSavedTalks();
  state.selectedPreviousTalkId = state.savedTalks[0]?.id || null;
  setTextSize(localStorage.getItem('liveMeetingTranscriber.textSize') || 'medium');
  renderAppShell();
  try {
    state.config = await fetch('/api/config').then((response) => response.json());
    const provider = state.config.sttProvider === 'xai' ? 'xAI realtime STT ready' : 'Browser STT fallback';
    setStatus(provider, 'idle');
    if (!state.config.uploadTranscriptionEnabled) {
      els.uploadStatus.textContent = 'Recording upload requires X_AI_API_KEY on the server.';
    }
  } catch {
    setStatus('Local fallback', 'idle');
  }
  renderPreviousTalkDetail();
}

async function startMeeting() {
  if (state.config.sttProvider === 'xai' && navigator.mediaDevices && window.WebSocket) {
    await startXaiMeeting();
    return;
  }
  startBrowserMeeting();
}

async function startXaiMeeting() {
  try {
    state.startedAt = Date.now();
    state.isLive = true;
    state.lastProviderFinalKey = '';
    setButtonsForLive(true);
    setStatus('Opening xAI stream', 'idle');

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    state.sttSocket = new WebSocket(`${protocol}//${location.host}/stt?language=en`);
    state.sttSocket.binaryType = 'arraybuffer';
    state.sttSocket.onmessage = handleSttMessage;
    state.sttSocket.onerror = () => setStatus('xAI stream error', 'error');
    state.sttSocket.onclose = () => {
      if (state.isLive) {
        state.isLive = false;
        setButtonsForLive(false);
        stopAudioGraph();
        persistCurrentTalk('Interrupted live draft');
        setStatus('xAI stream closed. Restart service, then press Start.', 'error');
      }
    };

    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    state.audioContext = new AudioContext();
    state.sourceNode = state.audioContext.createMediaStreamSource(state.mediaStream);
    state.processorNode = state.audioContext.createScriptProcessor(4096, 1, 1);
    state.zeroGainNode = state.audioContext.createGain();
    state.zeroGainNode.gain.value = 0;

    state.processorNode.onaudioprocess = (event) => {
      if (!state.isLive || state.sttSocket?.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm = processAudioForStt(input, state.audioContext.sampleRate);
      state.sttSocket.send(pcm.buffer);
    };

    state.sourceNode.connect(state.processorNode);
    state.processorNode.connect(state.zeroGainNode);
    state.zeroGainNode.connect(state.audioContext.destination);
    setStatus('Live via xAI + DSP', 'live');
  } catch (error) {
    setButtonsForLive(false);
    state.isLive = false;
    setStatus(error.message || 'Mic start failed', 'error');
  }
}

function startBrowserMeeting() {
  if (!SpeechRecognition) {
    setStatus('SpeechRecognition unsupported. Use Add demo line or upload a recording.', 'error');
    return;
  }

  state.startedAt = Date.now();
  state.isLive = true;
  state.recognition = new SpeechRecognition();
  state.recognition.continuous = true;
  state.recognition.interimResults = true;
  state.recognition.lang = 'en-US';

  state.recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0]?.transcript?.trim();
      if (!text) continue;
      if (result.isFinal) {
        addSegment(text, result[0]?.confidence ?? 0.7, { source: 'browser' });
      } else {
        interim += `${text} `;
      }
    }
    els.interim.textContent = interim ? `Listening: ${interim.trim()}` : '';
  };

  state.recognition.onerror = (event) => {
    setStatus(`Speech error: ${event.error}`, 'error');
  };

  state.recognition.onend = () => {
    if (state.isLive) {
      try {
        state.recognition.start();
      } catch {
        setStatus('Recognizer restarting...', 'idle');
      }
    }
  };

  state.recognition.start();
  setButtonsForLive(true);
  setStatus('Live via browser STT', 'live');
}

function handleSttMessage(message) {
  let event;
  try {
    event = JSON.parse(message.data);
  } catch {
    return;
  }

  if (event.type === 'transcript.created') {
    setStatus('xAI ready', 'live');
    return;
  }

  if (event.type === 'error') {
    setStatus(event.message || 'xAI STT error', 'error');
    return;
  }

  if (event.type === 'transcript.partial') {
    const text = String(event.text || '').trim();
    if (!text) return;
    if (event.is_final) {
      const startSec = Number(event.start || state.lastSegmentEnd);
      const endSec = startSec + Number(event.duration || Math.max(1, text.length / 12));
      const key = `${Math.round(startSec * 10)}:${text}`;
      if (key !== state.lastProviderFinalKey) {
        state.lastProviderFinalKey = key;
        addSegment(text, 0.9, { startSec, endSec, source: 'xai' });
      }
      if (event.speech_final) els.interim.textContent = '';
    } else {
      els.interim.textContent = `xAI: ${text}`;
    }
    return;
  }

  if (event.type === 'transcript.done') {
    if (event.text && !state.segments.some((segment) => segment.text === event.text)) {
      addSegment(event.text, 0.9, { startSec: 0, endSec: event.duration || state.lastSegmentEnd, source: 'xai' });
    }
    setStatus('xAI transcript complete', 'idle');
  }
}

function stopMeeting() {
  state.isLive = false;
  setButtonsForLive(false);
  els.interim.textContent = '';

  if (state.recognition) state.recognition.stop();
  if (state.sttSocket?.readyState === WebSocket.OPEN) {
    state.sttSocket.send(JSON.stringify({ type: 'audio.done' }));
    state.sttSocket.close();
  }
  stopAudioGraph();

  setStatus('Ended', 'idle');
  persistCurrentTalk('Stopped meeting');
  generateAgenda();
  buildSlides('final');
}

function stopAudioGraph() {
  try { state.processorNode?.disconnect(); } catch {}
  try { state.sourceNode?.disconnect(); } catch {}
  try { state.zeroGainNode?.disconnect(); } catch {}
  for (const track of state.mediaStream?.getTracks?.() || []) track.stop();
  state.audioContext?.close?.();
  state.processorNode = null;
  state.sourceNode = null;
  state.zeroGainNode = null;
  state.mediaStream = null;
  state.audioContext = null;
}

function processAudioForStt(input, sampleRate) {
  const highPassed = new Float32Array(input.length);
  const cutoff = 120;
  const rc = 1 / (2 * Math.PI * cutoff);
  const dt = 1 / sampleRate;
  const alpha = rc / (rc + dt);
  let sumSquares = 0;

  for (let i = 0; i < input.length; i += 1) {
    const x = input[i];
    const y = alpha * (state.dsp.hpLastY + x - state.dsp.hpLastX);
    state.dsp.hpLastX = x;
    state.dsp.hpLastY = y;
    highPassed[i] = y;
    sumSquares += y * y;
  }

  const rms = Math.sqrt(sumSquares / Math.max(1, highPassed.length));
  const gatedScale = rms < 0.008 ? 0.15 : 1;
  const desiredGain = clamp(0.065 / Math.max(rms, 0.012), 0.75, 3.2);
  state.dsp.agcGain = state.dsp.agcGain * 0.94 + desiredGain * 0.06;

  for (let i = 0; i < highPassed.length; i += 1) {
    highPassed[i] = clamp(highPassed[i] * gatedScale * state.dsp.agcGain, -0.95, 0.95);
  }

  return downsampleToPcm16(highPassed, sampleRate, 16000);
}

function downsampleToPcm16(samples, sourceRate, targetRate) {
  const ratio = sourceRate / targetRate;
  const length = Math.floor(samples.length / ratio);
  const pcm = new Int16Array(length);

  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += samples[j];
    const sample = sum / Math.max(1, end - start);
    pcm[i] = clamp(sample, -1, 1) * 0x7fff;
  }

  return pcm;
}

function addDemoLine() {
  if (!state.startedAt) state.startedAt = Date.now();
  addSegment(demoLines[demoIndex % demoLines.length], 0.92, { source: 'demo' });
  demoIndex += 1;
}

function addSegment(text, confidence = 0.8, overrides = {}) {
  const now = state.startedAt ? (Date.now() - state.startedAt) / 1000 : state.lastSegmentEnd + 8;
  const startSec = overrides.startSec ?? Math.max(state.lastSegmentEnd, now - Math.max(3, Math.min(14, text.length / 11)));
  const endSec = overrides.endSec ?? Math.max(startSec + 1, now);
  const segment = {
    id: overrides.id || crypto.randomUUID(),
    startSec,
    endSec,
    text,
    confidence,
    source: overrides.source || 'unknown'
  };
  state.lastSegmentEnd = Math.max(state.lastSegmentEnd, endSec);
  state.segments.push(segment);
  renderTranscript();
  renderLatestTranscript();
  renderPulsePane();
  scheduleIntelligence();
  scheduleSlideLoop('transcript-growth');
  persistCurrentTalk('Live draft');
}

function loadSegments(segments, source = 'upload', options = {}) {
  state.meetingId = options.meetingId || crypto.randomUUID();
  state.meetingTitle = options.title || (source === 'upload' ? 'Uploaded talk' : 'Loaded talk');
  state.startedAt = null;
  state.segments = (segments || []).map((segment, index) => ({
    id: segment.id || `${source}-${index}`,
    startSec: Number(segment.startSec || 0),
    endSec: Number(segment.endSec || segment.startSec || 0),
    text: String(segment.text || '').trim(),
    confidence: Number(segment.confidence || 0.85),
    source
  })).filter((segment) => segment.text);
  state.lastSegmentEnd = state.segments.reduce((max, segment) => Math.max(max, segment.endSec), 0);
  state.topics = [];
  state.checks = [];
  state.agendaItems = [];
  state.slides = [];
  state.slideVersion = 0;
  state.slideTransitionReason = '';
  state.selectedSlideIndex = 0;
  state.selectedTopicSlug = null;
  state.lastTopicRunAtSegment = 0;
  state.lastFactRunAtSegment = 0;
  state.lastSlideLoopSegment = 0;
  state.lastSlideLoopTopicCount = 0;
  state.slidePendingUpdates = [];
  renderTranscript();
  renderLatestTranscript();
  renderTopics();
  renderFactChecks();
  renderAgenda([]);
  renderSlide();
  renderAppShell();
  runIntelligence().then(() => {
    generateAgenda();
    buildSlides('loaded-talk');
  });
}

function renderTranscript() {
  const newestFirst = [...state.segments].reverse();
  els.transcript.innerHTML = newestFirst.map((segment) => `
    <article id="${segment.id}" class="segment">
      <a class="timestamp" href="#${segment.id}">${formatTime(segment.startSec)}</a>
      <div class="segment-text">${escapeHtml(segment.text)}</div>
    </article>
  `).join('');
  renderAppShell();
  renderPulsePane();
}

function renderLatestTranscript() {
  const latest = state.segments.slice(-4).reverse();
  els.meetingLabel.textContent = state.meetingTitle;
  if (!latest.length) {
    els.latestTranscript.classList.add('empty');
    els.latestTranscript.textContent = 'The last 3-4 transcript lines stay here during the talk.';
    return;
  }
  els.latestTranscript.classList.remove('empty');
  els.latestTranscript.innerHTML = latest.map((segment) => `
    <div class="latest-line">
      <a class="timestamp" href="#${segment.id}">${formatTime(segment.startSec)}</a>
      <span>${escapeHtml(segment.text)}</span>
    </div>
  `).join('');
}

async function uploadRecording(event) {
  event.preventDefault();
  const file = els.recordingInput.files?.[0];
  if (!file) return;

  els.uploadStatus.classList.remove('empty');
  els.uploadStatus.textContent = `Uploading and transcribing ${file.name}...`;
  try {
    const params = new URLSearchParams({ filename: file.name, type: file.type || 'application/octet-stream', language: 'en' });
    const response = await fetch(`/api/transcribe-upload?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Upload failed: ${response.status}`);
    loadSegments(result.segments || [], 'upload', { title: file.name });
    persistCurrentTalk(`Uploaded ${file.name}`);
    els.uploadStatus.textContent = `Loaded ${result.segments?.length || 0} transcript segments from ${file.name}.`;
  } catch (error) {
    els.uploadStatus.textContent = error.message;
  }
}

async function askQuestion(event) {
  event.preventDefault();
  const question = els.questionInput.value.trim();
  if (!question) return;
  els.answer.classList.remove('empty');
  els.answer.textContent = 'Reading the talk so far...';

  try {
    const result = await api('/api/ask', { question, transcript: state.segments });
    const citations = (result.citations || []).map((citation) => {
      const target = nearestSegment(citation.startSec);
      const href = target ? `#${target.id}` : '#';
      return `<a class="citation" href="${href}">${formatTime(citation.startSec || 0)}</a>`;
    }).join(' ');
    els.answer.innerHTML = `<p>${escapeHtml(result.answer || 'No answer returned.')}</p>${citations ? `<p>${citations}</p>` : ''}`;
  } catch (error) {
    els.answer.textContent = error.message;
  }
}

let intelligenceTimer = null;
function scheduleIntelligence() {
  clearTimeout(intelligenceTimer);
  intelligenceTimer = setTimeout(runIntelligence, 900);
}

async function runIntelligence() {
  if (state.segments.length - state.lastTopicRunAtSegment >= 2) {
    state.lastTopicRunAtSegment = state.segments.length;
    await refreshTopics();
  }
  if (state.segments.length - state.lastFactRunAtSegment >= 2) {
    state.lastFactRunAtSegment = state.segments.length;
    await refreshFactChecks();
  }
}

async function refreshTopics() {
  const recent = state.segments.slice(-6).map((seg) => seg.text).join(' ');
  const existingTopics = state.topics.map((topic) => topic.title);
  try {
    const result = await api('/api/topics', { recentText: recent, transcript: state.segments, existingTopics });
    for (const topic of result.topics || []) {
      const topicSlug = slugify(topic.title);
      if (!topicSlug || state.topics.some((item) => item.slug === topicSlug)) continue;
      state.topics.push({ ...topic, slug: topicSlug, createdAt: Date.now() });
      state.selectedTopicSlug = topicSlug;
    }
    renderTopics();
    scheduleSlideLoop('topic-change');
  } catch (error) {
    console.warn(error);
  }
}

function renderTopics() {
  if (!state.topics.length) {
    els.lookupFeed.classList.add('empty');
    els.lookupFeed.textContent = 'New topics appear here newest-first as the speaker introduces them.';
    els.topicDetail.classList.add('empty');
    els.topicDetail.textContent = 'Select a lookup for detail.';
    renderAppShell();
    return;
  }

  els.lookupFeed.classList.remove('empty');
  els.lookupFeed.innerHTML = [...state.topics].reverse().slice(0, 8).map((topic) => `
    <article class="lookup-card ${topic.slug === state.selectedTopicSlug ? 'active' : ''}" data-topic-card="${escapeAttr(topic.slug)}">
      <h3>${escapeHtml(topic.title)}</h3>
      <p>${escapeHtml(topic.summary || topic.whyRelevant || 'Mentioned by the speaker.')}</p>
      <p><strong>Why:</strong> ${escapeHtml(topic.whyRelevant || 'Mentioned in the recent transcript.')}</p>
      <div class="links">
        ${(topic.links || []).slice(0, 2).map((link) => `
          <a href="${escapeAttr(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.title || link.url)}</a>
        `).join('')}
      </div>
    </article>
  `).join('');
  for (const card of els.lookupFeed.querySelectorAll('[data-topic-card]')) {
    card.addEventListener('click', () => {
      state.selectedTopicSlug = card.dataset.topicCard;
      renderTopics();
    });
  }

  const selected = state.topics.find((topic) => topic.slug === state.selectedTopicSlug) || state.topics[state.topics.length - 1];
  els.topicDetail.classList.remove('empty');
  els.topicDetail.innerHTML = `
    <h3>${escapeHtml(selected.title)}</h3>
    <p>${escapeHtml(selected.summary || '')}</p>
    <p><strong>Why it matters:</strong> ${escapeHtml(selected.whyRelevant || 'Mentioned in the talk.')}</p>
    <div class="links">
      ${(selected.links || []).slice(0, 5).map((link) => `
        <a href="${escapeAttr(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.title || link.url)}</a>
      `).join('')}
    </div>
  `;
  renderAppShell();
}

async function refreshFactChecks() {
  const recent = state.segments.slice(-8).map((seg) => seg.text).join(' ');
  try {
    const result = await api('/api/fact-check', { recentText: recent, transcript: state.segments });
    const seen = new Set(state.checks.map((check) => check.claim.toLowerCase()));
    for (const check of result.checks || []) {
      if (!check.claim || seen.has(check.claim.toLowerCase())) continue;
      state.checks.unshift(check);
      seen.add(check.claim.toLowerCase());
    }
    state.checks = state.checks.slice(0, 12);
    state.selectedFactIndex = 0;
    renderFactChecks();
    scheduleSlideLoop('fact-check-update');
  } catch (error) {
    console.warn(error);
  }
}

function renderFactChecks() {
  if (!state.checks.length) {
    els.factChecks.classList.add('empty');
    els.factChecks.textContent = 'Claims that need review will appear here.';
    renderAppShell();
    return;
  }

  els.factChecks.classList.remove('empty');
  els.factChecks.innerHTML = state.checks.map((check) => `
    <article class="fact-card">
      <div class="fact-meta">
        <span class="badge ${escapeAttr(check.status || 'needs_review')}">${escapeHtml((check.status || 'needs_review').replace('_', ' '))}</span>
        <span class="badge uncertain">${Math.round(Number(check.confidence || 0) * 100)}% confidence</span>
      </div>
      <strong>${escapeHtml(check.claim || '')}</strong>
      <p>${escapeHtml(check.evidence || '')}</p>
      <div class="links">
        ${(check.links || []).slice(0, 3).map((link) => `
          <a href="${escapeAttr(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.title || link.url)}</a>
        `).join('')}
      </div>
    </article>
  `).join('');
  renderAppShell();
}

async function generateAgenda() {
  if (!state.segments.length) {
    els.agenda.textContent = 'No transcript is available yet.';
    return;
  }
  els.agenda.classList.remove('empty');
  els.agenda.textContent = 'Building linked agenda...';
  try {
    const result = await api('/api/agenda', { segments: state.segments });
    renderAgenda(result.agenda || []);
  } catch (error) {
    els.agenda.textContent = error.message;
  }
}

function renderAgenda(items) {
  state.agendaItems = items || [];
  if (!items.length) {
    els.agenda.textContent = 'No agenda returned.';
    renderAppShell();
    return;
  }
  els.agenda.innerHTML = [...items].reverse().map((item, displayIndex) => {
    const target = nearestSegment(item.startSec);
    const originalIndex = items.length - 1 - displayIndex;
    return `
      <article class="agenda-item" data-agenda-index="${originalIndex}">
        <a href="#${target?.id || ''}" class="timestamp">${formatTime(item.startSec || 0)}</a>
        <div>
          <h3 class="agenda-title">${escapeHtml(item.title || 'Untitled section')}</h3>
          <p>${escapeHtml(item.summary || '')}</p>
          ${renderAgendaList('Decisions', item.decisions)}
          ${renderAgendaList('Action items', item.actionItems)}
          ${renderAgendaList('Open questions', item.openQuestions)}
        </div>
      </article>
    `;
  }).join('');
  renderAppShell();
  persistCurrentTalk('Agenda generated');
}

function renderAgendaList(title, items) {
  if (!Array.isArray(items) || !items.length) return '';
  return `<p><strong>${title}:</strong> ${items.map(escapeHtml).join('; ')}</p>`;
}

let slideTimer = null;
const SLIDE_REPLACE_MIN_MS = 30000;
const SLIDE_REPLACE_DEBOUNCE_MS = 6000;

function scheduleSlides(reason = 'manual') {
  clearTimeout(slideTimer);
  slideTimer = setTimeout(() => buildSlides(reason), 1600);
}

function scheduleSlideLoop(reason) {
  const enoughTranscriptChange = state.segments.length - state.lastSlideLoopSegment >= 2;
  const topicChanged = state.topics.length !== state.lastSlideLoopTopicCount;
  const visible = state.activeScreen === 'slides';
  if (!enoughTranscriptChange && !topicChanged && !visible && state.slides.length) return;
  state.lastSlideLoopSegment = state.segments.length;
  state.lastSlideLoopTopicCount = state.topics.length;

  if (state.slides.length && reason !== 'manual' && reason !== 'final' && reason !== 'loaded-talk') {
    addSlidePendingUpdate(reason);
    scheduleSlideReplacement(reason);
    return;
  }

  scheduleSlides(reason);
}

function addSlidePendingUpdate(reason) {
  const latestSegment = state.segments[state.segments.length - 1];
  const latestTopic = state.topics[state.topics.length - 1];
  const updates = [];
  if (reason === 'topic-change' && latestTopic) {
    updates.push(`New topic: ${latestTopic.title}`);
    if (latestTopic.whyRelevant) updates.push(latestTopic.whyRelevant);
    if (latestTopic.summary) updates.push(latestTopic.summary);
  } else if (latestSegment) {
    updates.push(compactSlideBullet(latestSegment.text));
  } else {
    updates.push(`Update queued: ${reason}`);
  }
  for (const text of updates.filter(Boolean).slice(0, 3).reverse()) {
    state.slidePendingUpdates.unshift({ reason, text, createdAt: Date.now() });
  }
  state.slidePendingUpdates = dedupePendingUpdates(state.slidePendingUpdates).slice(0, 8);
  renderSlide();
}

function scheduleSlideReplacement(reason) {
  clearTimeout(state.slideReplacementTimer);
  const elapsed = Date.now() - state.lastSlideReplaceAt;
  const waitForCooldown = Math.max(0, SLIDE_REPLACE_MIN_MS - elapsed);
  const delay = Math.max(SLIDE_REPLACE_DEBOUNCE_MS, waitForCooldown);
  state.slideReplacementTimer = setTimeout(() => buildSlides(reason), delay);
}

async function buildSlides(reason = 'manual') {
  if (!state.segments.length && !state.topics.length) {
    els.slideStage.textContent = 'No transcript or topics are available yet.';
    return;
  }
  els.slideStage.classList.remove('empty');
  if (!state.slides.length) {
    els.slideStage.textContent = 'Composing live slides...';
  } else {
    state.slideTransitionReason = `Preparing replacement deck: ${reason}. Current slide remains visible until ready.`;
    renderSlide();
  }
  try {
    const result = await api('/api/slides', {
      meetingId: state.meetingId,
      reason,
      segments: state.segments,
      topics: state.topics,
      checks: state.checks,
      currentSlides: state.slides,
      activeSlideIndex: state.selectedSlideIndex
    });
    const incomingSlides = result.slides || [];
    if (!incomingSlides.length) return;
    state.lastSlideReplaceAt = Date.now();
    state.slides = result.slides || [];
    state.slidePendingUpdates = [];
    state.slideVersion = result.version || state.slideVersion;
    state.slideTransitionReason = result.transitionReason || '';
    state.selectedSlideIndex = Math.min(
      Number.isFinite(result.activeSlideIndex) ? result.activeSlideIndex : state.selectedSlideIndex,
      Math.max(0, state.slides.length - 1)
    );
    renderSlide();
    renderAppShell();
    persistCurrentTalk('Slides updated');
  } catch (error) {
    if (!state.slides.length) els.slideStage.textContent = error.message;
    state.slideTransitionReason = `Slide replacement failed: ${error.message}`;
    renderSlide();
  }
}

function selectSlide(index) {
  if (!state.slides.length) return;
  const last = state.slides.length - 1;
  state.selectedSlideIndex = index < 0 ? last : index > last ? 0 : index;
  renderSlide();
}

function renderSlide() {
  if (!state.slides.length) {
    els.slideStage.classList.add('empty');
    els.slideStage.textContent = 'Slides will combine live topics, talk quotes, fact-check context, and lookup assets.';
    return;
  }

  const slide = state.slides[state.selectedSlideIndex] || state.slides[0];
  const assets = (slide.assets || []).slice(0, 4);
  const pending = state.slidePendingUpdates.slice(0, 5);
  els.slideStage.classList.remove('empty');
  els.slideStage.innerHTML = `
    <div class="slide-card">
      <div>
        <p class="slide-kicker">${escapeHtml(slide.kicker || `Slide ${state.selectedSlideIndex + 1}`)}</p>
        <h3 class="slide-title">${escapeHtml(slide.title || 'Live slide')}</h3>
        ${slide.quote ? `<blockquote class="slide-quote">“${escapeHtml(slide.quote)}”</blockquote>` : ''}
      </div>
      <aside class="slide-side">
        <span class="slide-count">${state.selectedSlideIndex + 1} / ${state.slides.length} · v${state.slideVersion || 1}</span>
        ${state.slideTransitionReason ? `<p>${escapeHtml(state.slideTransitionReason)}</p>` : ''}
        ${pending.length ? `
          <p class="slide-kicker">New points as speaker progresses</p>
          <ul class="slide-bullets pending-updates">
            ${pending.map((item) => `<li>${escapeHtml(item.text)}</li>`).join('')}
          </ul>
        ` : ''}
        <ul class="slide-bullets">
          ${(slide.bullets || []).slice(0, 4).map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}
        </ul>
        <div class="links">
          ${assets.map((asset) => `
            <a class="asset-card" href="${escapeAttr(asset.url || '#')}" target="_blank" rel="noreferrer">
              ${escapeHtml(asset.type === 'image' ? 'Image asset' : 'Lookup asset')}: ${escapeHtml(asset.title || asset.url || 'Source')}
            </a>
          `).join('')}
        </div>
      </aside>
    </div>
  `;
  renderAppShell();
}

function setScreen(screen) {
  state.activeScreen = screen || 'lookups';
  renderAppShell();
  if (state.activeScreen === 'slides' && !state.slides.length) buildSlides('manual');
}

function renderAppShell() {
  for (const button of els.navButtons) {
    button.classList.toggle('active', button.dataset.screen === state.activeScreen);
  }
  for (const screen of els.screens) {
    screen.classList.toggle('active', screen.dataset.screenPanel === state.activeScreen);
  }
  const titles = {
    lookups: 'Live lookup tabs',
    transcript: 'Transcript',
    facts: 'Realtime fact checks',
    slides: 'Generated slides',
    agenda: 'Final agenda',
    previous: 'Previous talks'
  };
  els.screenTitle.textContent = titles[state.activeScreen] || 'Live meeting intelligence';
  renderSectionMenu();
  renderPreviousTalkDetail();
  renderPulsePane();
}

function renderPulsePane() {
  const latestTopic = state.topics[state.topics.length - 1];
  if (latestTopic) {
    els.latestLookupMini.classList.remove('empty');
    els.latestLookupMini.innerHTML = `<strong>${escapeHtml(latestTopic.title)}</strong>${escapeHtml(latestTopic.whyRelevant || latestTopic.summary || 'New topic detected.')}`;
  } else {
    els.latestLookupMini.classList.add('empty');
    els.latestLookupMini.textContent = 'No lookup yet.';
  }

  const latestFact = state.checks[0];
  if (latestFact) {
    els.latestFactMini.classList.remove('empty');
    els.latestFactMini.innerHTML = `<strong>${escapeHtml(latestFact.status || 'needs_review')}</strong>${escapeHtml(latestFact.claim || latestFact.evidence || 'Claim detected.')}`;
  } else {
    els.latestFactMini.classList.add('empty');
    els.latestFactMini.textContent = 'No claims yet.';
  }

  const currentSlide = state.slides[state.selectedSlideIndex];
  if (currentSlide) {
    els.latestSlideMini.classList.remove('empty');
    const pending = state.slidePendingUpdates[0]?.text;
    els.latestSlideMini.innerHTML = `<strong>${escapeHtml(currentSlide.title || 'Current slide')}</strong>${escapeHtml(pending || state.slideTransitionReason || 'Slide is stable.')}`;
  } else {
    els.latestSlideMini.classList.add('empty');
    els.latestSlideMini.textContent = 'No slide yet.';
  }

  const latestLine = state.segments[state.segments.length - 1];
  if (latestLine) {
    els.latestLineMini.classList.remove('empty');
    els.latestLineMini.innerHTML = `<strong>${formatTime(latestLine.startSec)}</strong>${escapeHtml(latestLine.text)}`;
  } else {
    els.latestLineMini.classList.add('empty');
    els.latestLineMini.textContent = 'No transcript yet.';
  }
}

function setTextSize(size) {
  const normalized = ['small', 'medium', 'large', 'xlarge'].includes(size) ? size : 'medium';
  document.body.classList.remove('text-small', 'text-medium', 'text-large', 'text-xlarge');
  document.body.classList.add(`text-${normalized}`);
  els.textSizeSelect.value = normalized;
  localStorage.setItem('liveMeetingTranscriber.textSize', normalized);
}

function compactSlideBullet(text) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (cleaned.length <= 120) return cleaned;
  const sentence = cleaned.split(/(?<=[.!?])\s+/).find((part) => part.length >= 24) || cleaned;
  return sentence.length > 120 ? `${sentence.slice(0, 117)}...` : sentence;
}

function dedupePendingUpdates(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderSectionMenu() {
  const items = sectionItemsForScreen();
  if (!items.length) {
    els.sectionMenu.classList.add('empty');
    document.body.classList.add('no-inner-menu');
    els.sectionMenu.innerHTML = '';
    return;
  }
  els.sectionMenu.classList.remove('empty');
  document.body.classList.remove('no-inner-menu');
  els.sectionMenu.innerHTML = items.map((item) => `
    <button class="section-item ${item.active ? 'active' : ''}" data-action="${item.action}" data-id="${escapeAttr(item.id)}">
      ${escapeHtml(item.label)}
      ${item.meta ? `<small>${escapeHtml(item.meta)}</small>` : ''}
    </button>
  `).join('');
  for (const item of els.sectionMenu.querySelectorAll('.section-item')) {
    item.addEventListener('click', () => handleSectionMenuClick(item.dataset.action, item.dataset.id));
  }
}

function sectionItemsForScreen() {
  if (state.activeScreen === 'lookups') {
    return [...state.topics].reverse().map((topic) => ({
      id: topic.slug,
      action: 'topic',
      label: topic.title,
      meta: 'lookup',
      active: topic.slug === state.selectedTopicSlug
    }));
  }
  if (state.activeScreen === 'transcript') {
    return state.segments.slice(-30).reverse().map((segment) => ({
      id: segment.id,
      action: 'transcript',
      label: segment.text.slice(0, 46),
      meta: formatTime(segment.startSec),
      active: false
    }));
  }
  if (state.activeScreen === 'facts') {
    return state.checks.map((check, index) => ({
      id: String(index),
      action: 'fact',
      label: check.claim.slice(0, 46),
      meta: check.status || 'needs review',
      active: index === state.selectedFactIndex
    }));
  }
  if (state.activeScreen === 'slides') {
    return state.slides.map((slide, index) => ({
      id: String(index),
      action: 'slide',
      label: slide.title || `Slide ${index + 1}`,
      meta: `${index + 1} / ${state.slides.length}`,
      active: index === state.selectedSlideIndex
    }));
  }
  if (state.activeScreen === 'agenda') {
    return [...state.agendaItems].reverse().map((item, displayIndex) => {
      const index = state.agendaItems.length - 1 - displayIndex;
      return {
        id: String(index),
        action: 'agenda',
        label: item.title || `Section ${index + 1}`,
        meta: formatTime(item.startSec || 0),
        active: index === state.selectedAgendaIndex
      };
    });
  }
  if (state.activeScreen === 'previous') {
    return state.savedTalks.map((talk) => ({
      id: talk.id,
      action: 'previous',
      label: talk.title || 'Saved talk',
      meta: new Date(talk.updatedAt || talk.createdAt).toLocaleString(),
      active: talk.id === state.selectedPreviousTalkId
    }));
  }
  return [];
}

function handleSectionMenuClick(action, id) {
  if (action === 'topic') {
    state.selectedTopicSlug = id;
    renderTopics();
    return;
  }
  if (action === 'transcript') {
    document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  if (action === 'fact') {
    state.selectedFactIndex = Number(id) || 0;
    renderFactChecks();
    return;
  }
  if (action === 'slide') {
    selectSlide(Number(id) || 0);
    return;
  }
  if (action === 'agenda') {
    state.selectedAgendaIndex = Number(id) || 0;
    document.querySelector(`[data-agenda-index="${state.selectedAgendaIndex}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    renderAppShell();
    return;
  }
  if (action === 'previous') {
    state.selectedPreviousTalkId = id;
    renderPreviousTalkDetail();
    renderAppShell();
  }
}

function renderPreviousTalkDetail() {
  if (!els.previousTalkDetail) return;
  const talk = state.savedTalks.find((item) => item.id === state.selectedPreviousTalkId);
  if (!talk) {
    els.previousTalkDetail.classList.add('empty');
    els.previousTalkDetail.textContent = 'No saved talks yet. Upload a recording or start a live meeting to create one.';
    return;
  }
  els.previousTalkDetail.classList.remove('empty');
  els.previousTalkDetail.innerHTML = `
    <h3>${escapeHtml(talk.title || 'Saved talk')}</h3>
    <p><strong>Updated:</strong> ${escapeHtml(new Date(talk.updatedAt || talk.createdAt).toLocaleString())}</p>
    <p><strong>Transcript lines:</strong> ${talk.segments?.length || 0}</p>
    <p><strong>Topics:</strong> ${talk.topics?.length || 0} · <strong>Fact checks:</strong> ${talk.checks?.length || 0} · <strong>Slides:</strong> ${talk.slides?.length || 0}</p>
    <button id="loadPreviousTalkBtn" class="primary" type="button">Load this talk</button>
    <button id="deletePreviousTalkBtn" type="button">Delete saved copy</button>
  `;
  document.querySelector('#loadPreviousTalkBtn')?.addEventListener('click', () => loadSavedTalk(talk.id));
  document.querySelector('#deletePreviousTalkBtn')?.addEventListener('click', () => deleteSavedTalk(talk.id));
}

function loadSavedTalk(id) {
  const talk = state.savedTalks.find((item) => item.id === id);
  if (!talk) return;
  state.meetingId = talk.id;
  state.meetingTitle = talk.title || 'Saved talk';
  state.startedAt = null;
  state.lastSegmentEnd = Number(talk.lastSegmentEnd || 0);
  state.segments = talk.segments || [];
  state.topics = talk.topics || [];
  state.checks = talk.checks || [];
  state.agendaItems = talk.agendaItems || [];
  state.slides = talk.slides || [];
  state.slideVersion = talk.slideVersion || 0;
  state.slideTransitionReason = talk.slideTransitionReason || '';
  state.selectedSlideIndex = 0;
  state.selectedTopicSlug = state.topics[state.topics.length - 1]?.slug || state.topics[0]?.slug || null;
  state.selectedFactIndex = 0;
  state.selectedAgendaIndex = 0;
  state.slidePendingUpdates = [];
  renderTranscript();
  renderLatestTranscript();
  renderTopics();
  renderFactChecks();
  renderAgenda(state.agendaItems);
  renderSlide();
  setScreen('transcript');
  els.uploadStatus.textContent = `Loaded ${state.meetingTitle}. Press Start to continue listening into this talk.`;
}

function persistCurrentTalk(reason = 'Updated') {
  if (!state.segments.length) return;
  const now = new Date().toISOString();
  if (!state.meetingTitle || state.meetingTitle === 'Unsaved talk') {
    state.meetingTitle = `Live talk ${new Date().toLocaleString()}`;
  }
  const snapshot = {
    id: state.meetingId,
    title: state.meetingTitle,
    reason,
    createdAt: now,
    updatedAt: now,
    lastSegmentEnd: state.lastSegmentEnd,
    segments: state.segments,
    topics: state.topics,
    checks: state.checks,
    agendaItems: state.agendaItems,
    slides: state.slides,
    slideVersion: state.slideVersion,
    slideTransitionReason: state.slideTransitionReason
  };
  const existing = state.savedTalks.find((talk) => talk.id === state.meetingId);
  if (existing?.createdAt) snapshot.createdAt = existing.createdAt;
  state.savedTalks = [snapshot, ...state.savedTalks.filter((talk) => talk.id !== state.meetingId)].slice(0, 20);
  saveSavedTalks(state.savedTalks);
  state.selectedPreviousTalkId = state.meetingId;
  renderLatestTranscript();
}

function deleteSavedTalk(id) {
  state.savedTalks = state.savedTalks.filter((talk) => talk.id !== id);
  saveSavedTalks(state.savedTalks);
  state.selectedPreviousTalkId = state.savedTalks[0]?.id || null;
  renderAppShell();
}

function loadSavedTalks() {
  try {
    const parsed = JSON.parse(localStorage.getItem('liveMeetingTranscriber.talks') || '[]');
    return Array.isArray(parsed)
      ? parsed.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      : [];
  } catch {
    return [];
  }
}

function saveSavedTalks(talks) {
  try {
    localStorage.setItem('liveMeetingTranscriber.talks', JSON.stringify(talks));
  } catch {
    // Local browser quota can be exceeded by long transcripts; SaaS storage replaces this.
  }
}

function nearestSegment(sec = 0) {
  return state.segments.reduce((best, segment) => {
    if (!best) return segment;
    return Math.abs(segment.startSec - sec) < Math.abs(best.startSec - sec) ? segment : best;
  }, null);
}

async function api(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

function setButtonsForLive(isLive) {
  els.startBtn.disabled = isLive;
  els.stopBtn.disabled = !isLive;
}

function setStatus(text, mode) {
  els.statusPill.textContent = text;
  els.statusPill.className = `status ${mode}`;
}

function formatTime(sec) {
  const total = Math.max(0, Math.round(sec || 0));
  const mins = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}
