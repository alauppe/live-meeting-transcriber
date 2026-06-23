import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
await loadEnvFile(path.join(__dirname, '.env'));
await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });

const port = Number(process.env.PORT || 5177);
const host = process.env.HOST || '127.0.0.1';
const xaiApiKey = process.env.X_AI_API_KEY || process.env.XAI_API_KEY || '';
const openaiApiKey = process.env.OPENAI_API_KEY || '';
const llmProvider = xaiApiKey ? 'xai' : (openaiApiKey ? 'openai' : 'local');
const llmApiKey = xaiApiKey || openaiApiKey;
const llmModel = process.env.X_AI_MODEL || process.env.XAI_MODEL || process.env.OPENAI_MODEL || (xaiApiKey ? 'grok-4.3' : 'gpt-4.1-mini');
const llmResponsesUrl = xaiApiKey ? 'https://api.x.ai/v1/responses' : 'https://api.openai.com/v1/responses';
const db = initDatabase(path.join(__dirname, 'data', 'meeting.sqlite'));

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return sendJson(res, {
        sttProvider: xaiApiKey ? 'xai' : 'browser',
        llmProvider,
        llmModel,
        uploadTranscriptionEnabled: Boolean(xaiApiKey),
        dspDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          highPassHz: 120,
          noiseGate: true,
          agc: true
        }
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/slide-versions') {
      return sendJson(res, listSlideVersions(url.searchParams.get('meetingId') || 'local'));
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/transcribe-upload') return sendJson(res, await transcribeUpload(req, url));
      const body = await readJson(req);
      if (url.pathname === '/api/ask') return sendJson(res, await answerQuestion(body));
      if (url.pathname === '/api/topics') return sendJson(res, await findTopics(body));
      if (url.pathname === '/api/fact-check') return sendJson(res, await factCheck(body));
      if (url.pathname === '/api/agenda') return sendJson(res, await buildAgenda(body));
      if (url.pathname === '/api/slides') return sendJson(res, await buildSlides(body));
      return sendJson(res, { error: 'Unknown API route' }, 404);
    }

    if (req.method !== 'GET') return sendText(res, 'Method not allowed', 405);
    await serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

server.listen(port, host, () => {
  console.log(`Live Meeting Transcriber listening at http://${host}:${port}`);
  console.log(xaiApiKey ? `xAI STT and analysis enabled with ${llmModel}` : 'xAI disabled; browser STT/local fallbacks available.');
  if (!xaiApiKey && openaiApiKey) console.log(`OpenAI analysis enabled with ${llmModel}`);
});

const sttWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/stt') {
    socket.destroy();
    return;
  }
  sttWss.handleUpgrade(req, socket, head, (ws) => sttWss.emit('connection', ws, req));
});

sttWss.on('connection', (client, req) => {
  proxyXaiStt(client, req);
});

async function loadEnvFile(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
    }
  } catch {
    // A .env file is optional.
  }
}

function proxyXaiStt(client, req) {
  if (!xaiApiKey) {
    client.send(JSON.stringify({ type: 'error', message: 'X_AI_API_KEY is not configured on the server.' }));
    client.close();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const upstreamParams = new URLSearchParams({
    sample_rate: '16000',
    encoding: 'pcm',
    interim_results: 'true',
    language: url.searchParams.get('language') || 'en',
    smart_turn: url.searchParams.get('smart_turn') || '0.7',
    smart_turn_timeout: url.searchParams.get('smart_turn_timeout') || '3000'
  });
  for (const keyterm of url.searchParams.getAll('keyterm').slice(0, 100)) {
    upstreamParams.append('keyterm', keyterm);
  }

  const upstream = new WebSocket(`wss://api.x.ai/v1/stt?${upstreamParams.toString()}`, {
    headers: { Authorization: `Bearer ${xaiApiKey}` }
  });
  const queued = [];
  let upstreamReady = false;

  upstream.on('message', (data) => {
    const text = data.toString();
    try {
      const event = JSON.parse(text);
      if (event.type === 'transcript.created') {
        upstreamReady = true;
        while (queued.length && upstream.readyState === WebSocket.OPEN) {
          const item = queued.shift();
          upstream.send(item.data, { binary: item.isBinary });
        }
      }
    } catch {}
    if (client.readyState === WebSocket.OPEN) client.send(text);
  });

  upstream.on('error', (error) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  });

  upstream.on('close', () => {
    if (client.readyState === WebSocket.OPEN) client.close();
  });

  client.on('message', (data, isBinary) => {
    if (upstream.readyState !== WebSocket.OPEN || !upstreamReady) {
      queued.push({ data, isBinary });
      return;
    }
    upstream.send(data, { binary: isBinary });
  });

  client.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify({ type: 'audio.done' }));
      setTimeout(() => upstream.close(), 1000).unref();
    }
  });
}

function initDatabase(filePath) {
  const database = new DatabaseSync(filePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS slide_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      reason TEXT NOT NULL,
      active_index INTEGER NOT NULL,
      transition_reason TEXT,
      slides_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_slide_versions_meeting ON slide_versions(meeting_id, version);
  `);
  return database;
}

async function serveStatic(routePath, res) {
  const cleanPath = routePath === '/' ? '/index.html' : routePath;
  const requested = path.normalize(decodeURIComponent(cleanPath)).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(publicDir, requested);
  if (!fullPath.startsWith(publicDir)) return sendText(res, 'Not found', 404);

  try {
    const data = await fs.readFile(fullPath);
    res.writeHead(200, { 'Content-Type': contentType(fullPath) });
    res.end(data);
  } catch {
    sendText(res, 'Not found', 404);
  }
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

async function readJson(req) {
  const raw = (await readRaw(req)).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function readRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendText(res, text, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function answerQuestion(body) {
  const question = String(body.question || '').trim();
  const transcript = normalizeSegments(body.transcript);
  if (!question) return { answer: 'Ask a question about the talk so far.', citations: [] };
  if (!transcript.length) return { answer: 'There is no transcript yet.', citations: [] };

  if (llmApiKey) {
    const prompt = [
      'Answer the user question using only the transcript. If the answer is not in the transcript, say that clearly.',
      'Return compact JSON: {"answer":"...","citations":[{"startSec":0,"text":"short supporting transcript excerpt"}]}.',
      '',
      'Transcript:',
      transcriptText(transcript),
      '',
      `Question: ${question}`
    ].join('\n');
    const parsed = await llmJson(prompt);
    if (parsed?.answer) return { answer: String(parsed.answer), citations: Array.isArray(parsed.citations) ? parsed.citations : [] };
  }

  return localAnswer(question, transcript);
}

async function findTopics(body) {
  const transcript = normalizeSegments(body.transcript);
  const recentText = String(body.recentText || transcriptText(transcript.slice(-8))).trim();
  const existing = new Set((body.existingTopics || []).map((t) => slug(String(t))));
  if (!recentText) return { topics: [] };

  if (llmApiKey) {
    const prompt = [
      'Find newly introduced research-worthy topics in this live talk excerpt.',
      'Prefer names, organizations, standards, products, scientific/medical/legal/financial concepts, unfamiliar acronyms, and fast-changing topics.',
      'Skip generic terms and topics already known.',
      `Already known topic slugs: ${Array.from(existing).join(', ') || '(none)'}`,
      'Use web search when useful. Return compact JSON: {"topics":[{"title":"...","summary":"...","whyRelevant":"...","searchQuery":"...","links":[{"title":"...","url":"..."}]}]}.',
      '',
      recentText
    ].join('\n');
    const parsed = await llmJson(prompt, { webSearch: true });
    if (Array.isArray(parsed?.topics)) {
      return { topics: parsed.topics.filter((topic) => topic?.title && !existing.has(slug(topic.title))).slice(0, 5) };
    }
  }

  const topics = extractLocalTopics(recentText)
    .filter((topic) => !existing.has(slug(topic)))
    .slice(0, 5)
    .map((topic) => ({
      title: topic,
      summary: `Research placeholder for "${topic}". Add OPENAI_API_KEY to generate a live source-backed brief.`,
      whyRelevant: 'Mentioned by the speaker in the recent transcript.',
      searchQuery: topic,
      links: searchLinks(topic)
    }));

  return { topics };
}

async function factCheck(body) {
  const transcript = normalizeSegments(body.transcript);
  const recentText = String(body.recentText || transcriptText(transcript.slice(-8))).trim();
  if (!recentText) return { checks: [] };

  if (llmApiKey) {
    const prompt = [
      'Identify fact-checkable claims in this live talk excerpt and check them with web search when needed.',
      'Do not fact-check opinions or vague intentions.',
      'Return compact JSON: {"checks":[{"claim":"...","status":"supported|contradicted|uncertain|needs_review","confidence":0.0,"evidence":"...","links":[{"title":"...","url":"..."}]}]}.',
      '',
      recentText
    ].join('\n');
    const parsed = await llmJson(prompt, { webSearch: true });
    if (Array.isArray(parsed?.checks)) return { checks: parsed.checks.slice(0, 6) };
  }

  const claims = extractLocalClaims(recentText).slice(0, 5).map((claim) => ({
    claim,
    status: 'needs_review',
    confidence: 0.35,
    evidence: 'Potential factual claim detected locally. Add OPENAI_API_KEY for source-backed verification.',
    links: searchLinks(claim)
  }));

  return { checks: claims };
}

async function buildAgenda(body) {
  const segments = normalizeSegments(body.segments || body.transcript);
  if (!segments.length) return { agenda: [] };

  if (llmApiKey) {
    const prompt = [
      'Build a concise agenda for this completed talk. Group the transcript into coherent sections.',
      'Return compact JSON: {"agenda":[{"title":"...","startSec":0,"endSec":60,"summary":"...","decisions":[],"actionItems":[],"openQuestions":[]}]}.',
      '',
      transcriptText(segments)
    ].join('\n');
    const parsed = await llmJson(prompt);
    if (Array.isArray(parsed?.agenda)) return { agenda: parsed.agenda };
  }

  return { agenda: localAgenda(segments) };
}

async function buildSlides(body) {
  const segments = normalizeSegments(body.segments || body.transcript);
  const topics = Array.isArray(body.topics) ? body.topics.slice(0, 12) : [];
  const checks = Array.isArray(body.checks) ? body.checks.slice(0, 8) : [];
  const currentSlides = Array.isArray(body.currentSlides) ? body.currentSlides.slice(0, 16) : [];
  const currentActiveIndex = Number(body.activeSlideIndex || 0);
  const meetingId = String(body.meetingId || 'local');
  const reason = String(body.reason || 'manual');
  if (!segments.length && !topics.length) return { slides: [] };

  let slideResult;
  if (llmApiKey) {
    const prompt = [
      'You are the live slide director for a talk in progress.',
      'Update the on-screen slide deck based on topic changes, transcript quotes, researched topics, and fact-check context.',
      'Decide whether the current slide is too full and should be reduced, split, or advanced to the next topic slide.',
      'Slides can change during the presentation, but should converge into one coherent deck by the end.',
      'Each slide should be useful on screen: concise title, one strong quote if available, 2-4 bullets, and lookup assets/links.',
      'If source links or image assets are known, include them in assets. Do not invent URLs.',
      'Return compact JSON: {"activeSlideIndex":0,"transitionReason":"...","slides":[{"title":"...","kicker":"...","quote":"...","startSec":0,"bullets":["..."],"assets":[{"title":"...","url":"...","type":"link|image"}]}]}.',
      '',
      `Trigger reason: ${reason}`,
      `Current active slide index: ${currentActiveIndex}`,
      '',
      'Current slides:',
      JSON.stringify(currentSlides),
      '',
      'Transcript:',
      transcriptText(segments),
      '',
      'Topics:',
      JSON.stringify(topics),
      '',
      'Fact checks:',
      JSON.stringify(checks)
    ].join('\n');
    const parsed = await llmJson(prompt, { webSearch: true, imageSearch: true });
    if (Array.isArray(parsed?.slides)) {
      slideResult = {
        slides: parsed.slides.slice(0, 16),
        activeSlideIndex: clampNumber(parsed.activeSlideIndex, 0, Math.max(0, parsed.slides.length - 1), currentActiveIndex),
        transitionReason: String(parsed.transitionReason || reason)
      };
    }
  }

  if (!slideResult) {
    const slides = localSlides(segments, topics, checks);
    slideResult = {
      slides,
      activeSlideIndex: chooseLocalActiveSlide(slides, topics, currentActiveIndex),
      transitionReason: reason
    };
  }

  const version = saveSlideVersion(meetingId, reason, slideResult.activeSlideIndex, slideResult.transitionReason, slideResult.slides);
  return { ...slideResult, version, meetingId };
}

async function transcribeUpload(req, url) {
  if (!xaiApiKey) throw new Error('X_AI_API_KEY is required for recording upload transcription.');
  const audio = await readRaw(req);
  if (!audio.length) throw new Error('No audio file was uploaded.');

  const filename = url.searchParams.get('filename') || 'recording.webm';
  const mimeType = req.headers['content-type'] || url.searchParams.get('type') || 'application/octet-stream';
  const language = url.searchParams.get('language') || 'en';

  const form = new FormData();
  form.append('format', 'true');
  form.append('language', language);
  form.append('diarize', 'true');
  form.append('file', new Blob([audio], { type: mimeType }), filename);

  const response = await fetch('https://api.x.ai/v1/stt', {
    method: 'POST',
    headers: { Authorization: `Bearer ${xaiApiKey}` },
    body: form
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`xAI STT upload failed: ${response.status} ${text.slice(0, 500)}`);
  }

  const result = await response.json();
  return {
    text: result.text || '',
    duration: result.duration || 0,
    segments: wordsToSegments(result.words || [], result.text || '', result.duration || 0)
  };
}

function wordsToSegments(words, text, duration) {
  if (Array.isArray(words) && words.length) {
    const segments = [];
    let bucket = [];
    for (const word of words) {
      bucket.push(word);
      const joined = bucket.map((item) => item.text).join(' ');
      const sentenceEnded = /[.!?]$/.test(String(word.text || ''));
      if (bucket.length >= 18 || (bucket.length >= 8 && sentenceEnded)) {
        segments.push(wordBucketToSegment(bucket, segments.length));
        bucket = [];
      }
    }
    if (bucket.length) segments.push(wordBucketToSegment(bucket, segments.length));
    return segments;
  }

  const sentences = String(text || '').split(/(?<=[.!?])\s+/).filter(Boolean);
  const slice = sentences.length ? duration / sentences.length : 0;
  return sentences.map((sentence, index) => ({
    id: `upload-${index}`,
    startSec: index * slice,
    endSec: (index + 1) * slice,
    text: sentence,
    confidence: 0.8
  }));
}

function wordBucketToSegment(words, index) {
  return {
    id: `upload-${index}`,
    startSec: Number(words[0]?.start || 0),
    endSec: Number(words[words.length - 1]?.end || words[0]?.start || 0),
    text: words.map((item) => item.text).join(' '),
    speaker: words.find((item) => item.speaker !== undefined)?.speaker,
    confidence: 0.9
  };
}

async function llmJson(input, opts = {}) {
  const payload = {
    model: llmModel,
    input,
    temperature: 0.2
  };
  if (opts.webSearch) {
    const tool = { type: 'web_search' };
    if (opts.imageSearch && llmProvider === 'xai') tool.enable_image_search = true;
    payload.tools = [tool];
  }

  const response = await fetch(llmResponsesUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${llmApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  const text = data.output_text || collectOutputText(data);
  return parseJsonLoose(text);
}

function collectOutputText(data) {
  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.text) parts.push(content.text);
    }
  }
  return parts.join('\n');
}

function parseJsonLoose(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {}
  }
  return null;
}

function normalizeSegments(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((seg, index) => ({
      id: String(seg.id || `seg-${index}`),
      startSec: Number(seg.startSec || 0),
      endSec: Number(seg.endSec || seg.startSec || 0),
      text: String(seg.text || '').trim()
    }))
    .filter((seg) => seg.text);
}

function transcriptText(segments) {
  return segments.map((seg) => `[${formatTime(seg.startSec)}-${formatTime(seg.endSec)}] ${seg.text}`).join('\n');
}

function localAnswer(question, segments) {
  const keywords = tokenize(question).filter((word) => word.length > 3);
  const scored = segments
    .map((seg) => ({
      seg,
      score: keywords.reduce((sum, word) => sum + (seg.text.toLowerCase().includes(word) ? 1 : 0), 0)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  if (!scored.length) {
    return {
      answer: 'I could not find that in the transcript so far. Try asking with a term the speaker used.',
      citations: []
    };
  }

  return {
    answer: scored.map(({ seg }) => seg.text).join(' '),
    citations: scored.map(({ seg }) => ({ startSec: seg.startSec, text: seg.text }))
  };
}

function extractLocalTopics(text) {
  const topics = new Set();
  const acronyms = text.match(/\b[A-Z]{2,}(?:-[A-Z0-9]+)?\b/g) || [];
  for (const item of acronyms) topics.add(item);

  const titleCase = text.match(/\b(?:[A-Z][a-z0-9]+(?:\s+|$)){2,4}/g) || [];
  for (const item of titleCase) {
    const cleaned = item.trim().replace(/[.,;:!?]$/, '');
    if (!/^(The|This|That|These|Those|When|Where|What|How|And|But)\b/.test(cleaned)) topics.add(cleaned);
  }

  const keyTerms = text.match(/\b(?:WebRTC|SIP|HIPAA|SOC 2|OpenAI|Realtime|Medicare|Salesforce|Zoom|Teams|Google Meet|Postgres|vector search|fact checking)\b/gi) || [];
  for (const item of keyTerms) topics.add(item);

  return Array.from(topics).filter((topic) => topic.length > 2 && topic.length < 80);
}

function extractLocalClaims(text) {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.filter((sentence) => {
    if (/\b(I think|I feel|maybe|probably|we should|we want)\b/i.test(sentence)) return false;
    return /\b(\d+%?|\$[\d,]+|\b\d{4}\b|always|never|all|none|first|largest|smallest|fastest|required|illegal|compliant|supports|does not support)\b/i.test(sentence);
  });
}

function localAgenda(segments) {
  const bucketSize = Math.max(3, Math.ceil(segments.length / 6));
  const agenda = [];
  for (let i = 0; i < segments.length; i += bucketSize) {
    const group = segments.slice(i, i + bucketSize);
    const text = group.map((seg) => seg.text).join(' ');
    const title = inferTitle(text, agenda.length + 1);
    agenda.push({
      title,
      startSec: group[0].startSec,
      endSec: group[group.length - 1].endSec,
      summary: summarizeLocal(text),
      decisions: findPhrases(text, /\b(?:decided|decision|we will|agreed to)\b[^.!?]*/gi),
      actionItems: findPhrases(text, /\b(?:todo|action item|follow up|send|schedule|build|create|review)\b[^.!?]*/gi),
      openQuestions: findPhrases(text, /[^.!?]*\?/g)
    });
  }
  return agenda;
}

function localSlides(segments, topics, checks) {
  const slides = [];
  slides.push({
    title: 'Talk in progress',
    kicker: 'Live generated overview',
    quote: pickQuote(segments),
    startSec: segments[0]?.startSec || 0,
    bullets: [
      `${segments.length} transcript segments captured`,
      `${topics.length} live lookup topics identified`,
      `${checks.length} claims queued for review`
    ],
    assets: []
  });

  for (const topic of topics.slice(0, 7)) {
    const quote = findQuoteForTopic(segments, topic.title) || pickQuote(segments);
    slides.push({
      title: topic.title || 'Live topic',
      kicker: topic.whyRelevant || 'Topic introduced by the speaker',
      quote,
      startSec: nearestQuoteStart(segments, quote),
      bullets: [
        topic.summary || 'Research brief pending.',
        topic.whyRelevant || 'Mentioned in the talk.'
      ].filter(Boolean),
      assets: (topic.links || []).slice(0, 3).map((link) => ({ title: link.title, url: link.url, type: 'link' }))
    });
  }

  if (checks.length) {
    slides.push({
      title: 'Claims to verify',
      kicker: 'Realtime fact-check queue',
      quote: checks[0]?.claim || '',
      startSec: 0,
      bullets: checks.slice(0, 4).map((check) => `${check.status || 'needs_review'}: ${check.claim}`),
      assets: checks.flatMap((check) => check.links || []).slice(0, 3).map((link) => ({ title: link.title, url: link.url, type: 'link' }))
    });
  }

  return slides;
}

function chooseLocalActiveSlide(slides, topics, currentActiveIndex) {
  if (!slides.length) return 0;
  const latestTopic = topics[topics.length - 1]?.title;
  if (latestTopic) {
    const found = slides.findIndex((slide) => slug(slide.title) === slug(latestTopic));
    if (found >= 0) return found;
  }
  return Math.min(currentActiveIndex, slides.length - 1);
}

function saveSlideVersion(meetingId, reason, activeIndex, transitionReason, slides) {
  const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM slide_versions WHERE meeting_id = ?').get(meetingId);
  const version = Number(current?.version || 0) + 1;
  db.prepare(`
    INSERT INTO slide_versions (meeting_id, version, reason, active_index, transition_reason, slides_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(meetingId, version, reason, activeIndex, transitionReason, JSON.stringify(slides), new Date().toISOString());
  return version;
}

function listSlideVersions(meetingId) {
  const rows = db.prepare(`
    SELECT id, meeting_id AS meetingId, version, reason, active_index AS activeSlideIndex,
           transition_reason AS transitionReason, slides_json AS slidesJson, created_at AS createdAt
    FROM slide_versions
    WHERE meeting_id = ?
    ORDER BY version DESC
    LIMIT 50
  `).all(meetingId);
  return {
    versions: rows.map((row) => ({
      ...row,
      slides: JSON.parse(row.slidesJson),
      slidesJson: undefined
    }))
  };
}

function pickQuote(segments) {
  const sorted = [...segments].sort((a, b) => b.text.length - a.text.length);
  return sorted.find((seg) => seg.text.length > 50)?.text || segments[segments.length - 1]?.text || '';
}

function findQuoteForTopic(segments, topic) {
  const words = tokenize(topic).filter((word) => word.length > 3);
  const found = segments.find((seg) => words.some((word) => seg.text.toLowerCase().includes(word)));
  return found?.text || '';
}

function nearestQuoteStart(segments, quote) {
  const found = segments.find((seg) => quote && seg.text === quote);
  return found?.startSec || 0;
}

function inferTitle(text, index) {
  const topics = extractLocalTopics(text);
  if (topics[0]) return topics[0];
  const words = tokenize(text).filter((word) => word.length > 4);
  return words.slice(0, 4).map((word) => word[0].toUpperCase() + word.slice(1)).join(' ') || `Section ${index}`;
}

function summarizeLocal(text) {
  const first = text.split(/(?<=[.!?])\s+/).find(Boolean) || text;
  return first.length > 220 ? `${first.slice(0, 217)}...` : first;
}

function findPhrases(text, regex) {
  return Array.from(text.matchAll(regex)).map((match) => match[0].trim()).filter(Boolean).slice(0, 5);
}

function searchLinks(query) {
  const q = encodeURIComponent(query);
  return [
    { title: `Search web for "${query}"`, url: `https://www.google.com/search?q=${q}` },
    { title: `Search Wikipedia for "${query}"`, url: `https://en.wikipedia.org/w/index.php?search=${q}` }
  ];
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function tokenize(text) {
  return String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function formatTime(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}
