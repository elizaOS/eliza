# #12497 Room Feed FST Evidence

Branch: `fix/12497-room-feed-fst`

## What Was Proven

- Added deterministic room-feed FST classification for meeting audio/video feeds.
- Covered all issue states:
  - `unknown`
  - `individual_feed_likely`
  - `room_feed_suspected`
  - `room_feed_confirmed`
  - `multi_speaker_room`
  - `speaker_candidates_split`
  - `profile_bound`
- Covered confidence, reason codes, UI hints, candidate speaker provenance,
  sensitive-attribute withholding, input validation, invalid transition
  handling, and a declared room feed with multiple diarized speakers but no
  visual count staying in `multi_speaker_room` with speaker-split hints.
- Exported the FST from the voice service barrel for meeting UI/benchmark use.

## Focused Verification

```bash
bun run --cwd plugins/plugin-local-inference test src/services/voice/room-feed-fst.test.ts
```

Result:

```text
Test Files  1 passed (1)
Tests       11 passed (11)
```

```bash
bunx @biomejs/biome check \
  plugins/plugin-local-inference/src/services/voice/room-feed-fst.ts \
  plugins/plugin-local-inference/src/services/voice/room-feed-fst.test.ts \
  plugins/plugin-local-inference/src/services/voice/index.ts
```

Result:

```text
Checked 3 files in 10ms. No fixes applied.
```

```bash
bun run --cwd plugins/plugin-local-inference typecheck
```

Result:

```text
tsgo --noEmit -p tsconfig.json
```

## Full Plugin Test Status

```bash
bun run --cwd plugins/plugin-local-inference test
```

Result: failed with 14 unrelated failures in existing tests:

```text
Test Files  3 failed | 244 passed (247)
Tests       14 failed | 2490 passed | 20 skipped (2524)
```

- `src/routes/local-inference-route-contracts.fuzz.test.ts` expects an ASR
  response without the current `aec` metadata field.
- `src/services/downloader.test.ts` reports invalid Eliza-1 manifest fixtures
  missing required MTP kernel metadata.
- `__tests__/mmproj-routing.test.ts` expects a pre-cutover missing-drafter
  fallback, while current code throws `MissingMtpDrafterError`.

No `room-feed-fst` tests failed in the full run.

## Root Verify Status

```bash
bun run verify
```

Result: blocked after ratchets passed by unrelated
`@elizaos/electrobun#lint` formatting diagnostics in
`packages/app-core/platforms/electrobun/src/voice/voice-service.test.ts`.
The root verify run rewrote an unrelated core file via write-mode lint; that
side effect was restored before pushing this branch.

## Artifact / Evidence Rows

- UI screenshots/video: N/A - pure classifier module, no UI surface changed.
- Audio artifacts: N/A - deterministic classifier logic only, no audio model or
  capture path changed.
- Real LLM trajectories: N/A - no model prompt, provider, action, or evaluator
  behavior changed.
- Backend/frontend logs: N/A - no route or runtime side effect changed.
- Example classifier output: covered by the focused Vitest assertions for room
  suspected, confirmed, multi-speaker room, split candidate, profile-bound, and
  sensitive-guardrail states.
