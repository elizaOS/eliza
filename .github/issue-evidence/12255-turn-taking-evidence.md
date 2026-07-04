# Issue 12255 Turn-Taking Evidence

Branch: `fix/12255-turn-taking`

Commit: branch commit amended after the July 3, 2026 rebase onto
`origin/develop`.

## What Changed

- Removed the retired GGUF/ONNX turn-detector runtime path and the public exports for the deleted detector module.
- Kept heuristic EOT commit conservative at `0.9`, while fused semantic EOT signals can commit at `0.7`.
- Added filler/tail-off scoring for thinking pauses and capped repeated mid-clause hangover extension at 1500 ms.
- Added speaker-gated barge-in hard-stop policy:
  - wake word always allows interruption;
  - agent self-voice similarity above the agent threshold denies hard-stop and resumes TTS;
  - unknown bystander interruption is configurable and defaults open.
- Updated two rebased `Downloader` warning calls to match the current structured
  logger argument order, keeping `plugins/plugin-local-inference` typecheck
  green on the latest `develop`.

## Commands Run

```bash
bun run --cwd packages/shared test -- src/voice-eot.test.ts
```

Result: passed, 1 file / 11 tests.

```bash
bun run --cwd plugins/plugin-local-inference test -- src/services/voice/barge-in.test.ts src/services/voice/turn-controller.test.ts src/services/voice/eot-classifier.test.ts src/services/voice/__tests__/eot-classifier.test.ts src/services/voice/__tests__/turn-detector-resolver.test.ts
```

Result: passed, 5 files / 86 tests.

```bash
bun run --cwd packages/core test -- src/__tests__/message-runtime-stage1.test.ts
```

Result: passed, 1 file / 81 tests.

```bash
bun run --cwd plugins/plugin-local-inference typecheck
bun run --cwd packages/shared typecheck
bun run --cwd packages/core typecheck
bun run --cwd packages/cloud/api typecheck
```

Result: all passed.

These package checks were rerun after rebasing onto `origin/develop` on July 3,
2026. The cloud-api typecheck is included because it had blocked an earlier
full-verify run before `fix(cloud-api): restore cloud API typecheck (#12600)`
landed upstream.

```bash
rg -n "LiveKitGgmlTurnDetector|eot-classifier-ggml|createBundledLiveKitGgmlTurnDetector|turnDetectorRevisionForTier|livekit-turn-detector"
```

Result: no matches.

```bash
bun run verify
```

Result after the latest rebase: failed outside this change in
`@elizaos/cloud-ui#lint`:

```text
packages/cloud-ui/src/approvals/ApprovalsRoute.tsx
packages/cloud-ui/src/approvals/components/approvals-tab.tsx
packages/cloud-ui/src/approvals/components/ballots-tab.tsx
packages/cloud-ui/src/approvals/components/sensitive-tab.tsx
packages/cloud-ui/src/approvals/index.ts
packages/cloud-ui/src/approvals/lib/approvals.ts
packages/cloud-ui/src/index.ts

Biome reported import/export ordering fixes for those files.
```

An initial verify run also exposed missing `@elizaos/auth/*` dist subpaths on a
fresh install; explicitly building `packages/auth` cleared those
auth-resolution errors. A later run exposed cloud-api typecheck errors, which
were cleared by rebasing onto upstream commit `bbc806be3af` / PR `#12600`. The
remaining full-verify failure is the unrelated cloud-ui import ordering listed
above.

## Evidence Rows

- Real LLM trajectory: N/A - this change does not alter prompts, model calls, providers, or agent action selection.
- Backend logs: N/A - no server process was started; behavior is covered by deterministic unit tests over the controller/state-machine boundary.
- Frontend screenshots/video: N/A - no UI surface changed.
- Real audio walkthrough: not captured in this environment; draft PR only. The unit coverage proves policy decisions, but final ready-for-review evidence still needs a provisioned voice session recording for tail-off, allowed human barge-in, wake-word allow, and self-voice denied hard-stop.
- Domain artifacts: N/A - no DB, memory, profile, wallet, or generated runtime artifacts are produced by this chunk.
