# Issue 12256 Echo AEC Evidence

Branch: `fix/12256-echo-aec`

## Implemented in this chunk

- Local ASR uploads now carry monotonic capture timing so desktop mic WAVs can
  align with playback-frame timestamps.
- `/api/voice/playback-frames` feeds a process-local far-end reference even
  when live diarization is not active, so batch local ASR can consume the same
  TTS reference stream.
- `POST /api/asr/local-inference` applies NLMS echo cancellation to timed JSON
  uploads before transcription and exposes AEC counters on the status endpoint.
- Browser local-ASR capture and Electrobun `VoiceService` both hold low-RMS ASR
  starts during active TTS/post-TTS cooldown while allowing loud barge-in.
- Small typecheck blockers fixed in `downloader.ts`, Electrobun proxy API-base
  nullability, and the UI fixture Tailwind/PostCSS typing boundary.

## Verification run locally

- `bunx @biomejs/biome check ...touched files` passed.
- Final post-rebase focused tests:
  - `bun run --cwd plugins/plugin-local-inference test -- src/services/voice/far-end-echo-reference.test.ts src/routes/local-inference-asr-route.test.ts` passed: 2 files, 8 tests.
  - `bun run --cwd packages/ui test -- src/hooks/useVoiceChat.local-asr.test.tsx src/voice/voice-capture-factory.test.ts src/voice/local-asr-capture.test.ts` passed: 3 files, 17 tests.
  - `bun run --cwd packages/app-core/platforms/electrobun test src/voice/voice-service.test.ts` passed: 1 file, 18 tests.
- `bun run --cwd plugins/plugin-local-inference typecheck` passed.
- Before the root verify cleanup removed generated package artifacts,
  `bun run --cwd packages/ui typecheck` passed and
  `bun run --cwd packages/app-core/platforms/electrobun typecheck` passed.
- `git diff --check` passed.
- `bun install` passed after syncing with `origin/develop`.
- `bun run verify` was attempted. It failed outside this change on
  `@elizaos/cloud-ui#lint` import ordering in `packages/cloud-ui/src/approvals/*`
  and also surfaced an unrelated `@elizaos/cloud-shared#lint` formatting error
  in `packages/cloud/shared/src/lib/types/cloud-api.ts`. The run generated enough
  build output to fill the local disk; generated artifacts were cleaned and the
  focused tests above were rerun afterward.

## Evidence status

- Deterministic ERLE evidence: covered by `far-end-echo-reference.test.ts`,
  which pushes synthetic playback frames, uploads a timestamp-aligned echo WAV,
  asserts NLMS is applied, and verifies ERLE is greater than 3 dB.
- Screenshots: N/A for this chunk; no visual layout or pixel surface changed.
- Screen recording: pending real desktop voice loop capture.
- Audio artifact: pending real TTS-to-mic loopback capture with before/after ASR
  transcript and ERLE telemetry.
- Real-LLM trajectories: N/A for this chunk; no prompt/model behavior changed.
- Backend/frontend logs: pending real desktop run.

This evidence file supports a draft PR. The issue is not ready to close until
real audio/device evidence is captured and manually reviewed.
