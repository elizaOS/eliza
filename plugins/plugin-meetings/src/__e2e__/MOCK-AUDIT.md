# plugin-meetings — external-boundary mock audit

Every place the plugin touches something outside its own process (runtime API,
model layer, browser, filesystem, network). For each: where it is exercised in
tests, how it is mocked, and whether any test reaches a real service by accident.

Verdict: **no unit test hits a real network, model, or browser.** The single
headless e2e (`headless-capture-e2e.ts`) launches a *real* local Chromium but
against a *local file://* page with a *scripted* ASR backend — no external
network, no real Meet, no real model.

| Boundary (caller) | Real target | Where exercised | How mocked / isolated | Gap? |
|---|---|---|---|---|
| `runtime.useModel(ModelType.TRANSCRIPTION)` (`RuntimeModelAsrBackend.transcribe`) | LLM/ASR provider | `pipeline/__tests__/transcriber.test.ts` | `vi.fn()` returning canned strings / rejections (retry/backoff paths) | none |
| ASR backend seam (`AsrBackend`) inside the pipeline | model layer | `pipeline/__tests__/pipeline.test.ts`, `headless-capture-e2e.ts` | scripted `AsrBackend` injected as `createMeetingTranscriptionPipeline(opts, backend)` — deterministic text, records WAV bytes | none |
| `runtime.getService("documents").addDocument` (knowledge mirror) | documents/knowledge store | `service.test.ts`, `meeting-transcript-writer.test.ts`, `headless-capture-e2e.ts` | `documentsService` stub in `makeFakeRuntime` pushes to `fake.documents`; a "missing documents service" test forces `getService("documents") → null` | none |
| media-store WAV write (`persistMeetingAudioWav` → `fs.writeFileSync` under `resolveStateDir()/media`) | filesystem / served media dir | `meeting-transcript-writer.test.ts` (`persistMeetingAudioWav`) | real `fs` into a `mkdtempSync` temp dir via `ELIZA_STATE_DIR`; content-addressed + idempotent asserted | none |
| `runtime.createEntity` (participant → entity) | DB | `service.test.ts` | `makeFakeRuntime` pushes to `fake.entities` | none |
| `runtime.ensureRoomExists` / `ensureWorldExists` | DB | `service.test.ts` | `makeFakeRuntime` pushes to `fake.rooms` / `fake.worlds`; world-retry-after-transient-failure covered (see below) | none |
| `runtime.getService("connector-setup").broadcastWs` (live WS fan-out) | agent API WS relay | `service.test.ts`, `events.test.ts` | `connectorSetup` stub in `makeFakeRuntime` pushes to `fake.broadcasts` | none |
| `runtime.getMemoryById` / `createMemory` / `updateMemory` (transcript row lifecycle) | memories partition | `meeting-transcript-writer.test.ts`, `service.test.ts`, `actions/actions.test.ts` | in-memory `Map` in `makeFakeRuntime` (partition-aware via `tables`) | none |
| Playwright browser audio capture (`startSpeakerAudioCapture`) | Chromium page | `headless-capture-e2e.ts` | **REAL** headless Chromium against a **local** `fake-meeting.html` (WebAudio per-participant MediaStreams) — no network | none |
| Chromium executable resolution (`chromiumExecutable`) | playwright/system chrome | `platform-support.test.ts` | `vi.spyOn(chromium, "executablePath")` + fs stat; never launches | none |
| Platform adapter `run()` (real join/leave) | live Meet/Teams/Zoom | `service.test.ts` | `ScriptedAdapter` seam — lifecycle resolved/rejected by the test; never opens a browser | none |

## Gaps found & closed

- **World-retry after a transient `ensureWorldExists` failure** was described in
  `service.ts` (`worldReady` reset on rejection) but not covered. Added a
  `service.test.ts` case that makes the first `ensureWorldExists` reject, asserts
  the join surfaces the error, then a second join succeeds (`worldReady` reset,
  world created). See `service.test.ts` → "resets worldReady after a transient
  ensureWorld failure so a later join succeeds".
- **writer.finalize throwing** (row vanished before finalize) was not asserted at
  the service level → added "fails the session when transcript finalize throws".
- **Empty-segment finalize** and **audioWav null vs present** (media write
  skipped vs performed) were not covered in the writer suite → added.
