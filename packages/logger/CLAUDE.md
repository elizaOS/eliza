# @elizaos/logger — Agent Guide

Standalone structured logger extracted from `@elizaos/core` so renderer/UI code
can import logging without pulling the ~2 MB core runtime bundle. `@elizaos/core`
re-exports this package from `./logger`, so `import { logger } from "@elizaos/core"`
still works everywhere.

## Layout

```
src/
  index.ts    Public barrel: re-exports ./logger (+ default). Does NOT export getEnv
              (core has its own getEnv; re-exporting would clash in core's barrels).
  logger.ts   The logger implementation (adze + fast-redact). Moved verbatim from core.
  env.ts      Tiny inlined getEnv (node process.env / browser window.ENV) — keeps this
              package a leaf with no @elizaos/* dependency.
```

## Commands

```bash
bun run --cwd packages/logger build       # tsc --noCheck -p tsconfig.build.json → dist
bun run --cwd packages/logger typecheck   # tsgo --noEmit
bun run --cwd packages/logger test
```

## Gotchas

- Leaf package: depends only on `adze` + `fast-redact`. Do NOT add an `@elizaos/*`
  dependency — that would re-introduce the bundle-coupling this split removed.
- Consumers that only need logging should import `@elizaos/logger`, not
  `@elizaos/core`, to stay off the core runtime's module graph.
- The renderer resolves `@elizaos/logger` to source via a vite alias in
  `packages/app/vite.config.ts`; rebuild `dist` (`bun run build`) when the public
  `.d.ts` surface changes so packages-mode + core's typecheck see it.
- Repo-wide rules (logger-only, ESM, naming) live in the root AGENTS.md.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
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

**Capture & manually review for this package — runtime / framework:**
- A **live-LLM** scenario trajectory for the runtime path you touched — provider → model → action → evaluator — with the raw `<response>` XML and every tool/action call visible and **read**.
- Backend `[ClassName]` logs proving the message loop, task scheduler, or service actually fired end to end.
- The memory/state artifacts produced — rows written, embeddings, room/world/entity records, scheduled-task rows — inspected, not assumed.
- For shared modules: `build:node` vs full `build` so the browser/edge bundles still compile.
<!-- END: evidence-and-e2e-mandate -->
