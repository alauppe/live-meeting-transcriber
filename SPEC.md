# Live Meeting Transcriber Product And Technical Spec

## 1. Product Goal

Build a live meeting intelligence web app that listens through the user's microphone, shows the transcript in real time, lets the user query everything said so far, automatically researches new topics as speakers introduce them, performs realtime fact checking, and produces a linked agenda at the end of the talk.

The immediate MVP is browser microphone based using xAI realtime speech-to-text when `X_AI_API_KEY` is configured. It must also accept uploaded recordings of previous talks and run the same transcript, research, fact-checking, Q&A, and agenda pipeline. The architecture must evolve cleanly into a SaaS product, native/mobile app, live phone-call transcription product, and web-meeting ingestion product.

## 2. MVP User Experience

1. User opens a meeting workspace in a browser.
2. User clicks `Start meeting`.
3. Browser asks for microphone permission.
4. Browser captures audio, applies the first-pass DSP chain, converts to 16 kHz PCM, and streams it to the backend.
5. Backend proxies audio to xAI realtime STT and returns transcript events.
6. Transcript streams into the main pane with timestamps.
7. While the talk continues:
   - New topics appear automatically in a right sidebar as vertical tabs.
   - The selected topic tab shows a short explanation and useful source/search links.
   - Claims appear in a fact-check queue with status, confidence, and evidence/search links.
   - User can ask natural-language questions about the transcript to that point.
8. User clicks `Stop meeting`.
9. App generates a talk agenda with sections, summaries, and links to transcript timestamps.

## 2.1 Recorded Talk Experience

1. User uploads a recording of a previous talk.
2. Backend sends the file to xAI batch STT.
3. Returned word-level timestamps are grouped into readable transcript segments.
4. The same topic extraction, internet lookup, fact checking, Q&A, and agenda generation services run on the uploaded transcript.
5. Agenda links jump to transcript timestamps just as they do for live meetings.

## 3. Core Features

### Live Transcript

- Capture microphone audio from the browser today.
- Prefer xAI realtime STT through the backend WebSocket proxy when `X_AI_API_KEY` exists.
- Fall back to browser speech recognition only for development/no-key mode.
- Show interim text while the realtime recognizer is still updating.
- Commit final transcript segments with timestamps and stable IDs.
- Keep transcript scroll anchored to the newest segment unless the user scrolls away.
- Store segment structure:
  - `id`
  - `speakerId` or `speakerLabel`
  - `startSec`
  - `endSec`
  - `text`
  - `confidence`
  - `source`

### Recording Upload

- Accept a local audio recording from the browser.
- Send upload bytes to the backend without exposing provider credentials.
- Backend sends the audio file to xAI batch STT.
- Preserve word timestamps where available.
- Convert words into timestamped transcript segments.
- Run topic lookup, fact checking, Q&A, and agenda generation exactly as if the transcript had arrived live.

### Laptop Mic DSP

Laptop microphones in conference rooms often include room reflections, fan noise, keyboard noise, and far-field reverb. The MVP must include a practical first-pass DSP chain before audio reaches the transcription provider:

- Browser media constraints: `echoCancellation`, `noiseSuppression`, and `autoGainControl`.
- High-pass filter around 100-150 Hz to reduce rumble and HVAC noise.
- Noise gate to suppress low-energy room tail between speech bursts.
- Light automatic gain control to normalize quiet laptop-mic speech without clipping.
- Downsample to 16 kHz mono PCM16 before streaming to xAI.

Production should replace the simple browser DSP with a dedicated media worker using WebRTC Audio Processing Module, RNNoise, SpeexDSP, or a similar native/WASM pipeline. True dereverberation is harder than noise suppression; evaluate it with laptop-in-room recordings and measure word error rate before and after DSP.

### Query The Talk So Far

- User enters a question.
- App answers only from transcript content unless explicitly asked for external context.
- Answer should cite relevant timestamps.
- If transcript does not contain enough information, answer with a clear insufficiency statement.

### Live Topic Research

- Monitor recent final transcript windows every 10-20 seconds.
- Extract new named topics, products, people, standards, legal/regulatory concepts, medical/scientific terms, companies, and unfamiliar acronyms.
- Deduplicate against existing topics.
- Open each topic in a vertical tab rail on the right.
- Each topic tab includes:
  - Topic name
  - Why it matters in this talk
  - Short research brief
  - Source/search links
  - Transcript trigger quote/timestamp

### Realtime Fact Checking

- Monitor recent transcript for factual claims, numbers, dates, promises, comparisons, legal/regulatory statements, medical/scientific statements, financial claims, and product capability claims.
- Avoid treating opinions, plans, or subjective judgments as factual claims.
- Each fact-check result includes:
  - Claim text
  - Status: `supported`, `contradicted`, `uncertain`, or `needs_review`
  - Confidence
  - Evidence summary
  - Source/search links
  - Transcript timestamp
- The UI must make uncertainty explicit. The app must not overstate fact-checking confidence.

### Final Agenda

- Generated when the meeting ends or on demand.
- Groups transcript into coherent sections.
- Each section includes:
  - Title
  - Start/end timestamps
  - Summary
  - Decisions
  - Action items
  - Open questions
  - Link to transcript timestamp

### Live Slides And Slide Versions

- The live analysis loop must detect topic changes and decide when a new lookup should trigger a slide transition.
- The slide loop must continuously evaluate whether the current slide is too dense, should be reduced, should be split, or should advance to the next topic.
- Slides can change during the presentation.
- After the talk, the app must produce one coherent final slide deck.
- The app must retain previous versions of generated slides for auditability, comparison, and rollback.
- Each slide version should store `meetingId`, `version`, `reason`, `activeSlideIndex`, `transitionReason`, `slides`, and `createdAt`.

### User Management

- Every persisted meeting, recording, transcript, fact check, topic, deck, and slide version must belong to a user and organization/workspace.
- Users need roles: `owner`, `admin`, `member`, and `viewer`.
- Meeting-level permissions must support owner-only, workspace, and shared-link access.
- Uploaded recordings and generated decks inherit meeting permissions by default.
- The app needs audit events for upload, transcript view, deck view, export, share, and delete actions.

### File Storage

- Uploaded recordings, optional live recordings, generated slide exports, and source assets from lookups need durable file storage.
- MVP can use local disk for development.
- Hosted SaaS should use object storage such as S3, R2, or GCS with signed URLs.
- File records must track owner, workspace, meeting, file type, MIME type, byte size, checksum, storage key, retention/delete status, and access policy.
- Retention policies must be workspace configurable.

## 4. MVP Architecture

```text
Browser
  - Mic capture
  - First-pass DSP
  - 16 kHz PCM streaming to backend
  - Transcript state
  - Query/topic/fact-check UI
  - Recording upload UI
  - Agenda rendering

Node server
  - Static app host
  - .env loader for X_AI_API_KEY
  - /stt WebSocket proxy to xAI realtime STT
  - /api/transcribe-upload for previous-talk recordings
  - /api/ask
  - /api/topics
  - /api/fact-check
  - /api/agenda
  - /api/slides
  - /api/slide-versions
  - Local SQLite for slide versions in the prototype
  - xAI Responses API calls

xAI
  - Realtime STT over WebSocket
  - Batch STT for uploaded recordings
  - Q&A and agenda from transcript
  - Web-search-backed topic research
  - Web-search-backed fact checking
```

This MVP intentionally keeps API keys server-side and keeps all meeting state in browser memory. Production storage comes next.

## 5. Production Architecture

```text
Clients
  Web app (React/Next or similar)
  Native mobile wrapper/app
  Browser extension / meeting bot

Realtime media layer
  Browser DSP and capture worker
  WebRTC for browser/mobile mic capture
  WebSocket media workers for server-side streams
  SIP for phone calls
  Meeting connectors for Zoom/Teams/Google Meet

Realtime intelligence services
  Transcription service
  Transcript event bus
  Topic extraction service
  Research/search service
  Fact-check service
  Q&A retrieval service
  Agenda/summarization service

Persistence
  SQLite locally for prototype slide versions and development state
  Postgres for SaaS users, organizations, meetings, segments, topics, checks, agenda, decks, files, and permissions
  Object storage for recordings, uploaded files, generated decks, and lookup assets
  Vector index for transcript retrieval and semantic search
  Audit/event log for compliance and debugging

SaaS layer
  Organization/workspace model
  Auth, roles, billing, limits
  Consent/compliance controls
  Retention policies
  Observability and cost controls
```

## 6. Recommended API Strategy

### Today

- xAI realtime STT through backend WebSocket proxy when `X_AI_API_KEY` is available.
- xAI batch STT for uploaded previous-talk recordings.
- Browser SpeechRecognition only as no-key fallback.
- xAI Responses calls for transcript Q&A, topic research, fact checking, and agenda generation.
- xAI web search tool for research and fact-checking.
- Browser-side DSP before live STT.

### Production

- Keep xAI and any other provider credentials server-side.
- Use a backend STT gateway so browser/mobile/phone/meeting-bot sources all emit the same transcript events.
- Use Realtime WebSockets when a server already receives raw audio from a phone/media worker.
- Use SIP where phone-call voice-agent or call transcription flows need telephony integration.
- Use ephemeral client auth to connect browsers/mobile apps to the app backend, not directly to provider STT.
- Keep final meeting intelligence server-side so Q&A, source links, fact checks, and agenda are persisted and auditable.

## 7. Data Model

### Organization

- `id`
- `name`
- `plan`
- `settings`

### User

- `id`
- `organizationId`
- `email`
- `name`
- `role`
- `createdAt`
- `lastLoginAt`

### Membership

- `id`
- `organizationId`
- `userId`
- `role`
- `createdAt`

### Meeting

- `id`
- `organizationId`
- `createdByUserId`
- `title`
- `status`: `live`, `ended`, `processing`, `complete`
- `source`: `browser_mic`, `phone`, `meeting_bot`, `upload`
- `startedAt`
- `endedAt`
- `language`
- `retentionPolicy`
- `visibility`: `private`, `workspace`, `shared_link`

### TranscriptSegment

- `id`
- `meetingId`
- `speakerId`
- `startMs`
- `endMs`
- `text`
- `confidence`
- `isFinal`
- `rawProviderPayload`

### Topic

- `id`
- `meetingId`
- `title`
- `slug`
- `triggerSegmentId`
- `summary`
- `whyRelevant`
- `sources`
- `createdAt`

### FactCheck

- `id`
- `meetingId`
- `claim`
- `triggerSegmentId`
- `status`
- `confidence`
- `evidenceSummary`
- `sources`
- `createdAt`

### AgendaItem

- `id`
- `meetingId`
- `title`
- `startMs`
- `endMs`
- `summary`
- `decisions`
- `actionItems`
- `openQuestions`

### FileAsset

- `id`
- `organizationId`
- `meetingId`
- `uploadedByUserId`
- `kind`: `recording`, `upload`, `slide_export`, `lookup_asset`
- `storageProvider`
- `storageKey`
- `originalFilename`
- `mimeType`
- `byteSize`
- `checksum`
- `retentionExpiresAt`
- `deletedAt`
- `createdAt`

### SlideDeck

- `id`
- `meetingId`
- `title`
- `finalVersionId`
- `createdAt`
- `updatedAt`

### SlideVersion

- `id`
- `deckId`
- `meetingId`
- `version`
- `reason`
- `activeSlideIndex`
- `transitionReason`
- `slidesJson`
- `createdAt`

### AuditEvent

- `id`
- `organizationId`
- `userId`
- `meetingId`
- `eventType`
- `metadata`
- `createdAt`

## 8. Service Contracts

### `WS /stt`

Browser sends 16 kHz mono PCM16 binary frames after browser DSP. Server proxies to xAI realtime STT and forwards provider transcript events back to the browser.

Provider event types:

- `transcript.created`
- `transcript.partial`
- `transcript.done`
- `error`

### `POST /api/transcribe-upload`

Input:

- Raw uploaded audio bytes as the request body.
- Query params: `filename`, `type`, optional `language`.

Output:

```json
{
  "text": "Full transcript",
  "duration": 3600,
  "segments": [
    { "id": "upload-0", "startSec": 0, "endSec": 12.4, "text": "..." }
  ]
}
```

### `POST /api/ask`

Input:

```json
{
  "question": "What did the speaker say about pricing?",
  "transcript": [{ "startSec": 4, "endSec": 12, "text": "..." }]
}
```

Output:

```json
{
  "answer": "...",
  "citations": [{ "startSec": 4, "text": "..." }]
}
```

### `POST /api/topics`

Input:

```json
{
  "recentText": "...",
  "transcript": [{ "startSec": 4, "endSec": 12, "text": "..." }],
  "existingTopics": ["WebRTC"]
}
```

Output:

```json
{
  "topics": [
    {
      "title": "WebRTC",
      "summary": "...",
      "whyRelevant": "...",
      "searchQuery": "WebRTC realtime audio browser mobile",
      "links": [{ "title": "Search WebRTC", "url": "..." }]
    }
  ]
}
```

### `POST /api/fact-check`

Input:

```json
{
  "recentText": "...",
  "transcript": [{ "startSec": 4, "endSec": 12, "text": "..." }]
}
```

Output:

```json
{
  "checks": [
    {
      "claim": "...",
      "status": "needs_review",
      "confidence": 0.4,
      "evidence": "...",
      "links": [{ "title": "Search claim", "url": "..." }]
    }
  ]
}
```

### `POST /api/agenda`

Input:

```json
{
  "segments": [{ "startSec": 4, "endSec": 12, "text": "..." }]
}
```

### `POST /api/slides`

Input:

```json
{
  "meetingId": "uuid",
  "reason": "topic-change",
  "segments": [{ "startSec": 4, "endSec": 12, "text": "..." }],
  "topics": [{ "title": "WebRTC", "links": [] }],
  "checks": [{ "claim": "...", "status": "needs_review" }],
  "currentSlides": [],
  "activeSlideIndex": 0
}
```

Output:

```json
{
  "meetingId": "uuid",
  "version": 7,
  "activeSlideIndex": 2,
  "transitionReason": "Speaker moved from compliance to pricing.",
  "slides": [
    {
      "title": "Pricing model",
      "kicker": "New topic",
      "quote": "Next we need a pricing model...",
      "startSec": 180,
      "bullets": ["..."],
      "assets": [{ "title": "Lookup asset", "url": "...", "type": "link" }]
    }
  ]
}
```

### `GET /api/slide-versions`

Input:

- Query param: `meetingId`.

Output:

```json
{
  "versions": [
    {
      "meetingId": "uuid",
      "version": 7,
      "reason": "topic-change",
      "activeSlideIndex": 2,
      "transitionReason": "...",
      "slides": [],
      "createdAt": "..."
    }
  ]
}
```

Output:

```json
{
  "agenda": [
    {
      "title": "Opening context",
      "startSec": 0,
      "endSec": 120,
      "summary": "...",
      "decisions": [],
      "actionItems": [],
      "openQuestions": []
    }
  ]
}
```

## 9. Security, Privacy, And Compliance

- Always request explicit user action before recording/transcribing.
- Show visible recording/transcription status.
- Add organization-level retention defaults.
- Allow meeting owner to delete transcripts.
- Encrypt recordings and transcripts at rest.
- Keep provider API keys server-side.
- Enforce user/workspace authorization on every meeting, file, transcript, deck, and slide-version route.
- Store files outside the web root and serve through signed, expiring URLs.
- Add consent prompts and configurable compliance language for regulated users.
- Add audit logs for transcript access, export, and sharing.
- Allow external web research and fact-checking to be disabled per workspace.

## 10. SaaS Roadmap

### Phase 1: Browser MVP

- Single-user local app.
- Browser microphone with DSP and xAI STT proxy.
- Previous-talk recording upload through xAI batch STT.
- Transcript, Q&A, topics, fact-checks, agenda.
- On-screen generated slides with local SQLite slide-version history.

### Phase 2: Hosted SaaS Alpha

- Auth, users, memberships, and workspaces.
- Persist meetings and transcript segments.
- Durable object storage for recordings, uploads, exports, and lookup assets.
- Server-side realtime transcription.
- Export agenda to Markdown/PDF.
- Export final coherent slide deck.
- Shareable read-only meeting view.

### Phase 3: Realtime Production

- Hardened xAI realtime STT gateway and optional provider abstraction.
- Speaker diarization strategy.
- Robust reconnection.
- Cost controls and provider failover.
- Observability and traces for every intelligence job.

### Phase 4: Multi-Source Capture

- Phone/SIP ingest.
- Zoom/Teams/Meet connectors or meeting bot.
- Upload/recording ingestion.
- YouTube/video-link ingestion: play the video while transcribing its audio, synchronize transcript timestamps to playback, and run topic lookup, fact checking, slide generation, and agenda generation as if it were a talk.
- Calendar integration.

### Phase 5: Mobile

- React Native or native shell using the same backend.
- Mobile microphone capture.
- Push notifications for action items.
- Offline capture fallback with later sync.

## 11. Non-Goals For The First Prototype

- Multi-user collaborative editing.
- Perfect diarization.
- Enterprise compliance certification.
- Persistent storage.
- Billing.
- Native mobile app package.
- Full phone-call ingestion.

## 12. Acceptance Criteria For This Prototype

- User can start and stop a microphone-based session.
- User can upload a previous talk recording and get timestamped transcript segments.
- Transcript updates live.
- User can ask a question and get an answer based on transcript text.
- New topics appear as vertical tabs.
- Fact-check queue updates as transcript grows.
- Agenda is generated and links back to transcript rows.
- Slides are generated from topics, transcript quotes, fact-check context, and lookup assets.
- Slides can update during the talk and prior versions are persisted.
- App runs locally with one command and without requiring API keys.
