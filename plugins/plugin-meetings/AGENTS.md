# @elizaos/plugin-meetings

Meeting transcription for elizaOS agents — browser bots that join Google Meet /
Microsoft Teams / Zoom as guests, capture per-speaker audio, transcribe through
the runtime model layer (`ModelType.TRANSCRIPTION`), and land live, diarized
transcripts in the Transcripts view and knowledge store.

## Purpose / role

The plugin has three internal layers that meet only at `src/types.ts`:

- **platforms/** — one browser-bot adapter per platform (`MeetingPlatformAdapter`).
  Each adapter runs the full join → admission → capture → leave lifecycle and
  produces per-speaker 16 kHz mono Float32 PCM + roster events into a
  `MeetingAudioSink`.
- **pipeline/** — implements `MeetingAudioSink`: per-speaker buffering, ASR via
  `runtime.useModel(TRANSCRIPTION)`, LocalAgreement confirmation, hallucination
  filtering, and `TranscriptSegment` assembly.
- **service.ts** — the orchestration layer: session state machine, URL
  validation, single-bot-per-meeting enforcement, room/world/entity wiring,
  transcript persistence, live WebSocket fan-out, actions/routes/provider.

Cross-package shapes (session DTO, WS events, `parseMeetingUrl`) live in
`@elizaos/shared` (`meetings.ts`, `transcripts.ts`).

## Plugin surface

| Kind | Name | Description |
|---|---|---|
| Service | `meetings` (`MeetingService`) | Session state machine: `requestJoin`, `stopSession`, `getSession`, `listSessions` |
| Action | `JOIN_MEETING` (similes `INVITE_TO_MEETING`, `ATTEND_MEETING`) | Join a meeting URL from chat and transcribe it live |
| Action | `LEAVE_MEETING` | Pull the bot out of an active meeting, finalize the transcript |
| Action | `GET_MEETING_TRANSCRIPT` | Return the live/final transcript text of an attended meeting |
| Provider | `ACTIVE_MEETINGS` | Injects currently-attended meetings (platform, URL, elapsed, roster) when any are active |
| Route | `POST /api/meetings` | Start a bot for a meeting URL (400 invalid URL, 409 already joined, 422 unsupported platform) |
| Route | `GET /api/meetings[?active=1]` | List sessions (newest first), optionally only non-terminal ones |
| Route | `GET /api/meetings/:id` | One session DTO |
| Route | `DELETE /api/meetings/:id` | Request a graceful leave |

All routes are `rawPath` plugin routes (registered on `runtime.routes`,
dispatched by both the upstream agent server and app-core) and private — the
host dispatcher answers 401 for unauthenticated callers.

## Platform matrix

| Platform | URL forms | Join mode | Notes |
|---|---|---|---|
| Google Meet | `meet.google.com/xxx-xxxx-xxx` | Anonymous guest (bot name only) | Waiting-room admission handled with timeout |
| Microsoft Teams | `teams.microsoft.com/l/meetup-join/…`, `teams.live.com/meet/…`, `teams.microsoft.com/meet/<id>` | Anonymous guest | |
| Zoom | `zoom.us/j/<id>`, `app.zoom.us/wc/<id>/join` | Web client guest | `?pwd=` preserved |
| Discord | — | **Not supported here** | Discord "meetings" are voice channels owned by the Discord connector; `requestJoin` rejects with a clear `unsupported_platform` error |

## Zoom cloud/bot artifact contract

Zoom cloud recording imports and bot/raw-data captures normalize through
`src/platforms/zoom/artifacts.ts`. `buildZoomCanonicalArtifact()` maps saved Zoom
cloud meeting metadata, participant lists, recording/transcript files, transcript
entries, and live capture events into `schemaVersion:
"elizaos.meeting_artifact.v1"`. The mapper preserves native Zoom participant
ids (`zoomParticipantId`, `userId`, `userGuid`) separately from diarized speaker
ids, emits per-participant streams when Meeting SDK/raw-data capture has them,
and emits mixed-audio source-loss metadata when only a bot/web-client or
bot-free mixed stream is available.

`classifyZoomImportError()` maps credential/import/capture failures into the
same missing-artifact vocabulary used by the canonical artifact: revoked access,
permission denied, missing meeting, expired media URL, waiting-room timeout,
denied entry, host removal, muted participants, recording disabled, transcript
unavailable, network loss, and host-ended meeting. The deterministic tests use
saved response-shaped objects only; live Zoom account/API proof still belongs in
issue evidence.

## Transcript persistence

Each session creates one record in the runtime `"transcripts"` memories
partition at join time (status `"recording"`), updates it with confirmed +
pending segments throttled to one write per ~5 s, and finalizes it (status
`"ready"`, `endedAt`, `durationMs`, `speakerCount`, `source "meeting"`,
metadata `{platform, meetingUrl, nativeMeetingId, sessionId, participants,
endReason}`). The row shape is byte-compatible with
plugin-local-inference's `TranscriptStore` (`metadata.type "custom"`,
`metadata.source "transcript"`, `content.transcript` JSON,
`content.text` preview), so the existing `/api/transcripts*` routes and the
Transcripts view render meeting transcripts with zero extra wiring — a golden
test (`meeting-transcript-writer.test.ts`) parses persisted rows with the exact
reader logic those routes use. Retained session audio is written
content-addressed under `<stateDir>/media/<sha256>.wav` (served at
`/api/media/…`), and the final text is mirrored into the documents/knowledge
store (tag `"transcript"`, `clientDocumentId` = transcript id, `textBacked`).

## Live WebSocket events

`MeetingWsEvent` envelopes (`meeting-status` on every session transition,
`meeting-transcript` throttled to ≤2/s per session with a trailing flush) are
broadcast through the always-registered `connector-setup` service, whose
`broadcastWs` the agent API server injects at startup — the same relay
Signal/WhatsApp pairing events use. No changes in `packages/agent` were needed.

## Config / env vars

| Variable | Required | Purpose |
|---|---|---|
| `ELIZA_MEETINGS_BOT_NAME` | No | Bot display name (default `"<character name> Notetaker"`) |
| `ELIZA_MEETINGS_CHROMIUM_PATH` | No | Chromium executable override the platform bots launch |
| `ELIZA_MEETINGS_HEADLESS` | No | Force headless (`true`) / headed (`false`). When unset, auto-detected from the available display (macOS/Windows always headed; Linux headed only when `DISPLAY`/`WAYLAND_DISPLAY` is set) |

Enablement follows the standard feature-toggle convention (cf. plugin-shell /
plugin-browser) — there is **no bespoke on/off env flag**. Auto-enable is wired
through the runtime's manifest mechanism: `package.json`'s
`elizaos.plugin.autoEnableModule` points at the light root module
[`auto-enable.ts`](./auto-enable.ts), whose `shouldEnable(ctx)` the resolver runs
at boot (this manifest module — not the `Plugin.autoEnable` field — is what the
loader reads). It enables when the **`meetings` feature is on in config**
(`config.features.meetings`) and the host is **not mobile** (`ctx.isNativePlatform`,
i.e. `ELIZA_PLATFORM=android|ios`): browser automation cannot run in an Android/iOS
sandbox, so mobile users get meeting transcripts via a cloud-hosted agent instead.

## Platform support & deployment

`src/platform-support.ts` is the typed capability layer:

- `resolveMeetingRuntimeSupport(runtime)` → `{ supported, reason?, headless, chromiumPath? }`
  — unsupported on mobile or when no Chromium is resolvable. Use it to refuse a
  launch cleanly instead of crashing.
- `resolveHeadlessMode(env, platform)` — explicit `ELIZA_MEETINGS_HEADLESS` else
  display auto-detect. Headless uses `--headless=new` (getUserMedia/WebAudio
  intact).
- `chromiumExecutable(channel, env)` — the single Chromium resolver shared with
  `platforms/shared/launch.ts` (override → bundled → system channel).

**Meet needs a real X server** for humanized XTEST admission clicks, so the
recommended server topology is **headed Chromium under Xvfb**
(`ELIZA_MEETINGS_HEADLESS=false` + `DISPLAY=:99`), not pure headless (which is
best-effort for Meet, reliable for Teams/Zoom). Full deployment matrix — local
desktop, Linux server / Eliza Cloud container (Xvfb + PulseAudio + apt packages +
Dockerfile), and why mobile is unsupported — is in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Commands

```bash
bun run --cwd plugins/plugin-meetings build       # tsup + declarations
bun run --cwd plugins/plugin-meetings test        # vitest run
bun run --cwd plugins/plugin-meetings typecheck   # tsgo --noEmit
```

## Conventions / gotchas

- `service.ts` never imports concrete adapters or the pipeline — they are
  injected via `MeetingServiceDependencies`; the real wiring is assigned to
  `MeetingService.dependencyFactory` in `src/index.ts`. Tests use the scripted
  seams in `src/test-support.ts`.
- Adapter `run()` resolves with a `MeetingEndReason` for expected outcomes and
  throws only for unexpected failures; the service maps a throw to status
  `"failed"` + `errorMessage` — errors are never swallowed.
- One bot per meeting: `requestJoin` rejects (`already_joined`) while a
  non-terminal session exists for the same platform + native meeting id
  (canonicalized, so URL spelling variants collide correctly).
- Sessions hang off one reused "Meetings" world; each meeting gets its own
  room with `source` = platform. Roster participants are wired to entities via
  `createUniqueUuid(runtime, "meeting-participant:<platform>:<name>")`.
- See the root `AGENTS.md` for repo-wide rules (ESM, logger-only, evidence).

## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — meeting bots:**
- A real bot join against a live Google Meet / Teams / Zoom meeting: browser video/screenshots
  of the bot in the roster, the waiting-room admission, and the graceful leave.
- The **domain artifacts**: the transcript row in the `"transcripts"` partition, the record
  rendered in the Transcripts view (screenshot), the knowledge mirror in the documents store,
  and the retained WAV playing back with word-synced highlighting.
- Live `meeting-status` / `meeting-transcript` WebSocket frames captured from the dashboard
  network log while the bot is in the call.
- Backend `[MeetingService]` structured logs covering the whole lifecycle, and a live-LLM
  trajectory for JOIN_MEETING / LEAVE_MEETING / GET_MEETING_TRANSCRIPT action changes.
