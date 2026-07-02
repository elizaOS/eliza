# Issue #11336: Browser voice-workbench de-larp rescope

## What changed

The browser Playwright voice workbench lane now describes the mocked browser
wiring it actually proves instead of advertising model-quality scenario classes.

Old browser spec names and `classes` labels for `diarization`,
`entity-extraction`, `voice-recognition`, `multi-voice`, `multi-speaker`,
`transcription-mode`, `respond-no-respond`, `eot`, `multi-agent-room`, and
`pauses` were renamed/rescoped to wiring/metadata labels:

- `agent-room-metadata`
- `attribution-unavailable`
- `fragmented-turn-wiring`
- `participant-sequence`
- `participant-voice-metadata`
- `response-state-sse`
- `speaker-label-metadata`
- `transcript-propagation`
- `turn-detail-metadata`
- `turn-pause-wiring`

The shared browser helper also now asserts the honest browser-lane outputs:
report class labels match the wiring labels, mocked transcripts propagate,
expected entity hints appear only as report metadata, response/no-response state
matches the mocked SSE stream, and speaker attribution remains unavailable.

## Tier-2 coverage cited

No browser spec was deleted. Model-quality scoring remains outside this mocked
browser lane:

- `packages/ui/src/voice/voice-selftest/voice-workbench-diarization.test.ts`
  covers real scoring behavior for matching labels, misattribution failures, and
  skipped null attribution.
- `packages/ui/src/voice/voice-selftest/voice-workbench-player.test.ts` covers
  `runVoiceWorkbench` reporting skipped attribution when no resolver exists and
  failing DER when a resolver supplies a wrong prediction.

## Verification

Run from `packages/app` so the shell expands `test/ui-smoke/voice-*.spec.ts`
against the package-local test directory:

```bash
bun run test:e2e test/ui-smoke/voice-*.spec.ts
```

Result:

```text
14 passed (29.1s)
```

The run included:

- `voice-desktop-selftest.spec.ts`
- `voice-selftest-e2e.spec.ts`
- all 10 renamed `voice-workbench-*` browser wiring specs
- both `voice-realaudio.spec.ts` tests under `chromium-voice-mic`

Biome formatting/check was run on the touched files:

```bash
bunx @biomejs/biome check --write \
  packages/app/test/ui-smoke/voice-workbench-*.spec.ts \
  packages/app/test/ui-smoke/voice-workbench-cases.ts \
  packages/scripts/voice-matrix.mjs
```

It exited 0. `packages/scripts/voice-matrix.mjs` still emits pre-existing
`noUndeclaredEnvVars` warnings unrelated to this path-only edit.

Repo-wide verify was run after syncing with `origin/develop`:

```bash
bun run verify
```

It stopped at the existing type-safety ratchet before typecheck/lint:

```text
[type-safety-ratchet] as unknown as: 80 / 77
[type-safety-ratchet] `?? {}` (core/agent/app-core): 379 / 377
[type-safety-ratchet] unsafe cast baseline exceeded
```

## Evidence rows

- Real LLM trajectory: N/A - no agent/model/prompt behavior changed.
- Backend logs: N/A - no runtime/backend code changed.
- Frontend logs/network: N/A - browser tests were renamed/rescoped; no app UI
  behavior changed.
- Screenshots/video/app audit: N/A - this is a Playwright test metadata/helper
  rescope only. No renderer UI, route, visual state, or interaction behavior was
  changed.
- Audio walkthrough: N/A - no voice pipeline behavior changed. The acceptance
  lane still ran the existing real injected-audio browser tests and passed.
- Domain artifacts: N/A - no persistent domain state is produced by this
  test-only change.
