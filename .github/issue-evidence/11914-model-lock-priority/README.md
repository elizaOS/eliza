# #11914 — on-device model-lock starvation: interactive priority + self-queue suppression + device-class background budget

Host-level evidence for the #11914 fix (the issue explicitly marks device
evidence optional: "host-level test with the lock instrumented; device
evidence optional").

## What shipped

1. **Interactive priority at the model-lock seam** — `InferencePriorityGate`
   (`packages/core/src/utils/inference-priority-gate.ts`), a process-wide
   two-lane lock in front of every single-lane local text path:
   - AOSP fused text handlers (`plugins/plugin-aosp-local-inference`,
     `generateOnPriorityLane`),
   - the bionic-host / device-bridge loader branch
     (`plugins/plugin-local-inference` `ensure-local-inference-handler.ts`)
     and the static plugin-object text handlers that hit the same loader
     services (`plugins/plugin-local-inference/src/provider.ts`
     `createTextHandler`),
   - the mobile device-bridge handlers (`plugins/plugin-capacitor-bridge`
     `makeGenerateHandler`, both the bionic UDS and renderer-bridge paths).
   Interactive turns dispatch ahead of queued background jobs; background jobs
   start only when the lane is idle and wait at most the RAM-class bound
   before failing typed (`InferenceBackgroundWaitTimeoutError`) **without
   ever reaching the host** — closing the abandoned-request pileup on the
   Java `residentLock`.
2. **Self-queue suppression** — background producers are now marked
   (`GenerateTextParams.priority: "background"` from `promptRunnerTaskWorker`
   and the prompt-batcher `PromptDispatcher` for non-immediate plans), and the
   bounded-wait failure hands the re-fire back to the existing structural
   rule: `TaskService`'s blocking skip + failure backoff (test added:
   `skips a repeat task whose previous run is still executing`). No second
   scheduler was added.
3. **Constrained-device budget (#11760 seam)** — background jobs are clamped
   by `resolveBackgroundInferenceBudget(ramClass)`:
   constrained → maxTokens 192 / prompt ≤ 4 000 chars / 120 s bounded wait;
   standard → 1 024 / 24 000 / 300 s. RAM class resolves through the #11760
   probe (`classifyInferenceRamClass`, which now delegates its env step to the
   shared `inferenceRamClassFromEnv` contract). Interactive turns are never
   clamped.

## Artifacts

| File | What it shows |
|---|---|
| `starvation-repro.mjs` / `starvation-repro.out` | **Fail-without-fix proof.** Simulates the observed on-device timeline (5-min background job + its self-queued next firing + a chat turn, 60 ms = 1 device-minute) against (a) the pre-fix arrival-order lock and (b) the real `InferencePriorityGate` from the built core dist. BEFORE: chat waits 9.1 device-minutes behind the backlog. AFTER: 4.0 (holder remainder + own decode) and the self-queued firing fails typed without running. |
| `core-tests.out` | 33/33: gate lock-priority envelope (interactive completes ahead of the queued background job with the lock instrumented), FIFO-within-lane, bounded background wait, abort-dequeue, throw-releases-lane, budget clamps incl. the observed 11 169-char / 8 192-token poison job, `TaskService` self-queue skip, dispatcher + prompt-runner background marking. |
| `core-full-suite.out` | Full `packages/core` suite: 307/308 files, 2 692 passed / 11 skipped / **1 pre-existing env-dependent failure** — `evaluators/__tests__/link-extraction.test.ts` ("prepare extracts a URL…"). Root cause: since develop commit `a45337a4c2` the evaluator fetches through `fetchWithSsrfGuard`, which bypasses the test's `globalThis.fetch` mock and performs a REAL request to `https://example.com/article` (live 404 → empty title). The file and its implementation are byte-identical to `origin/develop` in this branch (`git diff origin/develop -- …/evaluators/ …/network …/media` is empty) — unrelated to #11914. |
| `aosp-plugin-tests.out` | 104/104 (7 files) including `inference-priority-lane.test.ts`, which drives the real `generateOnPriorityLane` seam: interactive-ahead-of-queued-background at the loader, constrained clamp applied to background only, bounded-wait typed failure never reaching the loader. The run shows the production clamp log line firing: `background generate clamped to the device-class budget: prompt 11169→4000 chars (cap 4000), maxTokens 8192→192 (#11914)`. |
| `plugin-local-inference-tests.out` | Full suite after gating the mobile loader branch: 230 files, 2 389 passed / 2 skipped. |
| `plugin-capacitor-bridge-tests.out` | Full suite after gating both mobile handler paths: 8 files, 50 passed. |

## N/A evidence types

- **On-device capture** — N/A per the issue text ("device evidence
  optional"); the regression test is the host-level lock-instrumented lane
  test above. The device-visible log lines to look for on a Pixel run are
  `[InferencePriorityGate] interactive … waiting on a background job` and
  `background generate clamped to the device-class budget`.
- **Real-LLM trajectory** — N/A: the change routes/schedules and clamps
  requests on single-lane local backends; it adds no prompt/action/provider
  behavior a cloud-model trajectory would exercise. The lane ordering proof
  is the deterministic host tests + repro above.
- **Screenshots / video / frontend logs** — N/A: no UI change; no view is
  touched.

## Typecheck

`bun run typecheck` green in all four touched packages: `packages/core`,
`plugins/plugin-aosp-local-inference`, `plugins/plugin-local-inference`,
`plugins/plugin-capacitor-bridge`.
