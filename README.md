# Live Meeting Transcriber

Browser-first MVP for a live meeting intelligence product.

## What Works Today

- Live microphone transcription through an xAI STT WebSocket proxy when `X_AI_API_KEY` is present.
- Browser-side audio cleanup before streaming: echo cancellation, noise suppression, high-pass filtering, noise gate, and light AGC.
- Browser Web Speech API fallback when xAI is not configured.
- Upload a previous talk recording and run the same transcript, topic, fact-check, Q&A, and agenda flow.
- Real-time transcript with interim and final text.
- Ask questions about the transcript so far.
- Automatic topic detection into a right-side research tab rail.
- Realtime claim review/fact-check queue.
- End-of-talk agenda with clickable transcript anchors.
- On-screen generated slides from topics, transcript quotes, fact-check context, and lookup assets.
- SQLite-backed slide version history for live deck revisions.
- xAI-backed analysis endpoints when `X_AI_API_KEY` is set, optional Cerebras fast-loop slide synthesis, and local fallbacks for development.

## Run

```bash
cd live-meeting-transcriber
npm run dev
```

Open `http://127.0.0.1:5177`.

If xAI is not configured and your browser does not support `SpeechRecognition`, use the `Add demo line` button to exercise the full product flow.

## Provider Configuration

```bash
echo 'X_AI_API_KEY=...' > .env
echo 'CEREBRAS_KEY=...' >> .env
export X_AI_MODEL=grok-4.3
export CEREBRAS_MODEL=gpt-oss-120b
npm run dev
```

The app intentionally keeps provider access on the server. The browser never receives API keys.

By default, the app uses `grok-4.3` for xAI STT, live web-search lookups, realtime fact checks, Q&A, agenda generation, and quality/final slide builds. When `CEREBRAS_KEY` or `CEREBRAS_API_KEY` is set, high-frequency live slide synthesis uses Cerebras `gpt-oss-120b` with low reasoning effort. If Cerebras is not configured or fails, those high-frequency slide loops fall back locally instead of spending primary-model calls.

## Production Direction

See [SPEC.md](SPEC.md). The MVP uses xAI realtime STT when configured. The production path should keep the backend STT proxy, add a hardened DSP/media worker, persist meetings, and support browser/mobile microphones, phone calls, meeting bots, and recording uploads through the same transcript intelligence pipeline.
