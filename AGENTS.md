# Live Meeting Transcriber: Codex Project Guide

## Project Purpose

Live Meeting Transcriber is an open-source browser-first meeting intelligence app. It captures or imports a talk, produces a live transcript, answers questions about the talk so far, detects new topics for live lookup, performs realtime fact-check triage, generates a linked agenda, and creates dynamic slides from the talk.

The prototype is intentionally simple: Node server, browser UI, xAI STT/LLM integration when configured, optional Cerebras fast-loop synthesis, and local fallbacks when provider credits or keys are unavailable. Future development should preserve the working local-first flow while moving toward SaaS-grade users, storage, and multi-source ingestion.

## Current Architecture

- `server.js`: Node HTTP server, static file host, xAI STT WebSocket proxy, REST analysis endpoints, local fallback logic, SQLite slide version store.
- `public/index.html`: Single-page browser UI shell.
- `public/styles.css`: Full UI styling and responsive layout.
- `public/app.js`: Browser app state, mic capture, DSP, STT WebSocket client, transcript handling, topic/fact/agenda/slide rendering, previous-talk local persistence.
- `SPEC.md`: Product and technical specification.
- `README.md`: Public project overview and run instructions.

## Provider Behavior

- xAI is the primary provider when `X_AI_API_KEY` or `XAI_API_KEY` is set.
- `X_AI_MODEL` / `XAI_MODEL`, default `grok-4.3`, is used for STT, web-search lookups, realtime fact checks, Q&A, agenda generation, and quality/manual/final slide builds.
- Cerebras is the fast-loop provider when `CEREBRAS_KEY` or `CEREBRAS_API_KEY` is set.
- `CEREBRAS_MODEL` / `CEREBRAS_FAST_MODEL`, default `gpt-oss-120b`, is used only for high-frequency simple loops. Currently that means live slide regeneration for transcript/topic/fact-check loop triggers.
- Do not route web lookups, fact-checking, agenda generation, user Q&A, or final deck synthesis to Cerebras unless the user explicitly changes that product decision.
- If Cerebras is unavailable or fails, high-frequency slide loops should fall back locally rather than calling the primary xAI/OpenAI model.
- API keys must stay server-side. Never expose provider keys in browser code.
- Realtime STT is proxied through `WS /stt`.
- Uploaded recordings are sent to xAI batch STT through `POST /api/transcribe-upload`.
- LLM/web-search calls must degrade gracefully. If provider calls fail because of quota, permission, network, or parsing issues, endpoints should return local fallback results rather than failing the UI.
- Do not assume provider credits are available during development.

## Core User Flows

### Live Talk

1. User opens the app.
2. User clicks `Start`.
3. Browser captures laptop mic audio.
4. Browser applies first-pass DSP: echo cancellation, noise suppression, auto-gain media constraints, high-pass filter, noise gate, light AGC, and 16 kHz PCM downsampling.
5. Browser streams PCM to `/stt`.
6. Server proxies audio to xAI realtime STT.
7. Transcript segments appear newest-first and update live intelligence loops.

### Previous Talk

1. User selects `Previous`.
2. User uploads audio/video recording, or selects a locally saved talk.
3. Uploads are transcribed through xAI batch STT when configured.
4. Timestamped transcript segments feed the same Q&A, lookup, fact-check, agenda, and slides pipeline.
5. Browser localStorage currently stores saved-talk snapshots so a talk can be selected again after an npm/server restart.

### Live Monitoring UI

- Main navigation is a vertical left rail.
- Active section content appears in the main screen area.
- Multi-element sections use the inner vertical menu next to the main nav/content area.
- A persistent top strip always shows the latest 3-4 transcript lines and `Ask the talk`.
- A persistent right-side “Live pulse” pane always shows newest lookup, newest fact check, current slide state, and latest transcript line.
- Newest live data should appear at the top, not the bottom.
- Main UI should avoid requiring manual scrolling to understand current state.

## Feature Requirements

### Transcript

- Show newest segments first.
- Keep latest 3-4 lines always visible in the top strip.
- Support font-size selector for reading comfort.
- Allow user to ask questions about the transcript so far.
- Answers should cite timestamps when possible.

### Lookups

- Detect new topics as the speaker changes subjects.
- Show lookups newest-first in a multi-card feed.
- Keep inner menu selection for detail navigation.
- Include why the topic matters, a brief summary, and links/assets from lookup sources when available.

### Fact Checks

- Detect fact-checkable claims without treating opinions as facts.
- Show newest claims first.
- Use statuses: `supported`, `contradicted`, `uncertain`, `needs_review`.
- Local fallback should mark claims `needs_review` with low confidence and search links.

### Slides

- Generate slides from topics, transcript quotes, fact-check context, and lookup assets.
- Slides should be engaging section-level synthesis, not headers plus quote lists.
- Each slide should have a strong title, at most one short quote, 3-5 synthesized bullets from that section of the talk, high-value fact-check callouts where available, and lookup/source assets.
- Bullets should capture decisions, implications, risks, action items, contrasts, and important claims from the current section.
- Avoid repeating transcript quotes as bullet points.
- Prioritize high-value fact checks: numerical claims, compliance/legal claims, superlatives, deadlines, pricing, medical/financial/scientific assertions, and provider/product capability claims.
- Slides can change during the talk, but should remain readable.
- Fast loop should add new bullet points/supporting notes/assets to the current slide.
- Slow loop should replace or restructure slides less frequently.
- Never remove the visible old slide until the replacement deck is fully ready.
- After the talk, generate one coherent final deck.
- Preserve previous slide versions in SQLite.

### Agenda

- Generate linked sections after the talk or on demand.
- Each agenda item should include start/end timestamps, summary, decisions, action items, and open questions where possible.
- Agenda links should jump to transcript timestamps.

### Persistence And SaaS Roadmap

- Prototype persistence:
  - Browser localStorage for saved talk snapshots.
  - SQLite under `data/meeting.sqlite` for slide versions and saved talk snapshots.
  - On startup, browser localStorage talks should merge with server SQLite talks so dev port changes do not make previous talks disappear after migration.
- SaaS target:
  - Auth, users, organizations/workspaces, memberships, roles.
  - Postgres for users, orgs, meetings, transcripts, topics, checks, decks, files, permissions, audit events.
  - Object storage for recordings, uploads, generated decks, and lookup assets.
  - Signed URLs for file access.
  - Retention policies and deletion controls.
  - Audit logs for upload, transcript view, deck view, export, share, and delete.

### Future Ingestion Sources

- Browser/mobile microphone.
- Uploaded recordings.
- Phone/SIP streams.
- Zoom/Teams/Google Meet meeting bots/connectors.
- YouTube/video-link ingestion: play video while transcribing and analyzing it like a talk, with playback-synced transcript links.

## Implementation Conventions

- Keep the app dependency-light unless a new dependency is clearly justified.
- Prefer graceful local fallbacks over hard provider failures.
- Keep `.env`, `data/`, and `node_modules/` ignored and out of git.
- Do not commit provider keys or generated SQLite data.
- Keep browser code free of secrets.
- Keep all source files ASCII unless there is a specific reason not to.
- Avoid breaking the one-command local run path:

```bash
npm run dev
```

## Verification

Run before committing:

```bash
node --check server.js
node --check public/app.js
```

When possible, also run:

```bash
npm run dev
```

Then manually verify:

- App opens at `http://127.0.0.1:5177`.
- `Start` and `Stop` remain available during a talk.
- If the provider is unavailable or out of credits, the UI continues with local fallback output.
- Transcript newest lines appear at the top and in the top strip.
- Lookups and facts update newest-first.
- Slide bullet points accumulate quickly while deck replacement is slower.
- Previous talks can be loaded before starting a meeting after a server restart.

## GitHub

Public repository:

```text
https://github.com/alauppe/live-meeting-transcriber
```

Use concise commits that describe the user-facing or architectural change.
