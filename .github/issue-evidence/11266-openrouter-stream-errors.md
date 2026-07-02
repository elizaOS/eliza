# Issue #11266 - OpenRouter live stream error propagation

Date: 2026-07-02
Branch: `fix/11266-openrouter-stream-errors`
Base: `origin/develop` at `3a2ea84f818d`

## What Changed

- Added `onError` capture to the OpenRouter live `streamText` path.
- After the primary `textStream` drains, the generator now awaits the terminal
  `finishReason` and rethrows any provider error captured by `onError` or
  `finishReason`.
- This prevents an OpenRouter provider failure from resolving as a successful
  empty stream and lets upstream retry/failover logic see the thrown error.

## Regression

Added a unit regression in `plugins/plugin-openrouter/__tests__/native-plumbing.shape.test.ts`:

- mock `streamText` invokes the supplied `onError` with `Error("provider stream failed")`;
- mock `textStream` yields no chunks, matching the AI SDK failure shape;
- consuming the returned primary `textStream` rejects with `provider stream failed`;
- the test also asserts OpenRouter passed an `onError` callback into `streamText`.

## Verification

Commands run from `/private/tmp/eliza-11266-openrouter-stream` after rebasing onto
current `origin/develop`:

```bash
bun run --cwd plugins/plugin-openrouter test -- __tests__/native-plumbing.shape.test.ts --testTimeout 60000
```

Result: pass. `1 passed (1)`, `10 passed (10)`.

```bash
bun run --cwd plugins/plugin-openrouter test
```

Result: pass. `5 passed (5)`, `29 passed (29)`.

```bash
bun run --cwd plugins/plugin-openrouter typecheck
```

Result: pass.

```bash
bunx @biomejs/biome@2.5.2 check \
  plugins/plugin-openrouter/models/text.ts \
  plugins/plugin-openrouter/__tests__/native-plumbing.shape.test.ts
```

Result: pass. `Checked 2 files`.

```bash
bun run --cwd plugins/plugin-openrouter build
```

Result: pass. Node ESM, browser ESM, and CJS builds completed.

## Repo-Level Verify

```bash
bun run verify
```

Result: failed before typecheck/lint at `audit:type-safety-ratchet` on current
`origin/develop`, unrelated to this OpenRouter change:

- `as unknown as`: `80 current > 77 baseline`
- ``?? {}``: `379 current > 377 baseline`

The changed OpenRouter production source adds neither pattern.

## Evidence Applicability

- Live LLM trajectory: N/A for this patch. The failure mode is deterministic at
  the AI SDK contract seam: `streamText` reports the provider failure through
  `onError` and yields an empty text stream. The unit regression directly drives
  that seam.
- Screenshots/video/audio: N/A; no UI, native, audio, or visual surface changed.
