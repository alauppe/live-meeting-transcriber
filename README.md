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
- xAI-backed analysis endpoints when `X_AI_API_KEY` is set, with local fallbacks for development.

## Run

```bash
cd live-meeting-transcriber
npm run dev
```

Open `http://127.0.0.1:5177`.

If xAI is not configured and your browser does not support `SpeechRecognition`, use the `Add demo line` button to exercise the full product flow.

## xAI Configuration

```bash
echo 'X_AI_API_KEY=...' > .env
export X_AI_MODEL=grok-4.3
npm run dev
```

The app intentionally keeps xAI access on the server. The browser never receives the API key.

## Production Direction

See [SPEC.md](SPEC.md). The MVP uses xAI realtime STT when configured. The production path should keep the backend STT proxy, add a hardened DSP/media worker, persist meetings, and support browser/mobile microphones, phone calls, meeting bots, and recording uploads through the same transcript intelligence pipeline.
