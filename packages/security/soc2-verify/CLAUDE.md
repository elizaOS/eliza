# @elizaos/soc2-verify

SOC2 control-verification harness: runs static and dynamic checks against the elizaOS monorepo and emits a JSON + Markdown evidence report for auditor sampling.

## Purpose / role

This is a private developer tool (not published to npm). It is run directly via `bun run src/cli.ts` from the monorepo root, or via the `verify` / `verify:strict` scripts. It consumes `@elizaos/security` (workspace package) for its dynamic KMS and audit-dispatcher checks, and reads the filesystem and git metadata of the elizaOS monorepo root. Nothing imports from this package at runtime.

## Layout

```
packages/security/soc2-verify/
  src/
    index.ts          Public API: re-exports types, ALL_CHECKS, runVerification, report helpers
    cli.ts            Entry point for the CLI (bun run src/cli.ts)
    types.ts          Core types: Check, CheckContext, CheckResult, CheckSeverity,
                        CheckStatus, EvidenceReport, ReportControlBlock, VerificationConfig
    controls/
      index.ts        Assembles ALL_CHECKS (all 27 checks ordered by TSC category)
      audit-actions.ts  CC4 — audit action comprehensiveness check
      codeowners.ts   CC6/CC9 — CODEOWNERS, branch-protection, SECURITY.md checks
      db-and-pii.ts   CC6.7/C1 — DB SSL, KMS adoption, PII/soft-delete columns, log retention
      dynamic.ts      C1/CC4/PI1 — live round-trip tests using @elizaos/security adapters
      k8s.ts          CC6.6 — k8s securityContext + NetworkPolicy checks
      observability.ts CC7 — monitoring config + alert rules checks
      plugins.ts      CC6.8 — plugin signature verify, subagent env allowlist, firmware signing
      supply-chain.ts CC8 — gitleaks workflow, no committed secrets, workflow permissions,
                        actions pinned by SHA
      training.ts     PI1 — model artifact signing + training consent basis
    evidence/
      report.ts       renderMarkdown, writeReport, defaultOutDir — emit JSON + Markdown
    runners/
      run.ts          runVerification (runs all checks in parallel), hasCriticalFailures
    util/
      fs.ts           fileExists, dirExists, readUtf8, readUtf8Safe, walk
  src/__tests__/
    dynamic.test.ts   Unit tests for KMS + audit round-trip checks
    report.test.ts    Unit tests for Markdown rendering
    runner.test.ts    Unit tests for runVerification / hasCriticalFailures
  vitest.config.ts
```

## Key exports

Importable from the package root (`.`):

| Export | Source |
| --- | --- |
| `Check`, `CheckContext`, `CheckResult`, `CheckSeverity`, `CheckStatus`, `EvidenceReport`, `ReportControlBlock`, `VerificationConfig` | `src/types.ts` |
| `ALL_CHECKS` | `src/controls/index.ts` |
| `runVerification`, `hasCriticalFailures` | `src/runners/run.ts` |
| `renderMarkdown`, `writeReport`, `defaultOutDir` | `src/evidence/report.ts` |

CLI entry is `src/cli.ts` (also exported at `./cli`).

## Commands

```bash
bun run --cwd packages/security/soc2-verify verify           # run all checks, write report
bun run --cwd packages/security/soc2-verify verify:strict    # exit 1 if any critical check fails
bun run --cwd packages/security/soc2-verify lint:check       # Biome check (read-only)
bun run --cwd packages/security/soc2-verify format:check     # Biome format (read-only)
bun run --cwd packages/security/soc2-verify test             # vitest run (unit suite)
bun run --cwd packages/security/soc2-verify test:watch       # vitest watch
bun run --cwd packages/security/soc2-verify typecheck        # tsgo --noEmit
```

Or run the CLI directly with flags:

```bash
bun run packages/security/soc2-verify/src/cli.ts \
  --out .soc2-evidence/run-1 \
  --strict-fail \
  --include CC8.1          # only run checks whose id contains "CC8.1"
```

## Config / env vars

| Variable | Effect |
| --- | --- |
| `SOC2_OUTER_ROOT` | Override the workspace root used for outer-repo checks (`.github/workflows`, etc.). Default: parent of the elizaOS monorepo root. |
| `SOC2_GITLEAKS_LOG_OPTS` | git log range passed to `gitleaks detect --log-opts`. Default: `--all`. |

Root discovery walks upward from `src/cli.ts` looking for a directory containing both `packages/security/` and `packages/core/`. Falls back to `process.cwd()`.

## Output

Each run writes two files into the output directory (default `.soc2-evidence/<iso-timestamp>/`):

- `evidence-report.json` — machine-readable, GRC-tool friendly.
- `evidence-report.md` — human-readable, for auditor sampling.

Readiness score = `pass / (pass + fail)`, excludes `warn` and `skip`.

## Adding a new check

1. Create or extend a file in `src/controls/` that implements the `Check` interface from `src/types.ts`:
   ```ts
   import type { Check, CheckResult } from "../types.js";
   export const myCheck: Check = {
     id: "CC6.1-my-check",          // TSC prefix + unique slug
     title: "Short human description",
     tsc: ["CC6.1"],                 // one or more Trust Service Criteria IDs
     severity: "high",              // "critical" | "high" | "medium" | "low"
     async run(ctx): Promise<CheckResult> {
       // ctx.elizaRoot — monorepo root
       // ctx.outerRoot — outer workspace root
       return { status: "pass", evidence: "…", files: [] };
     },
   };
   ```
2. Import and add the new check to `ALL_CHECKS` in `src/controls/index.ts` under the appropriate TSC comment block.
3. Add a unit test in `src/__tests__/` if the check involves non-trivial logic.

## Conventions / gotchas

- All checks run in parallel via `Promise.all`. Checks must not share mutable state.
- Dynamic checks in `src/controls/dynamic.ts` instantiate real `@elizaos/security` adapters (`MemoryKmsAdapter`, `AuditDispatcher`, `InMemorySink`). This is intentional: the harness proves the security package actually works.
- Static checks inspect the filesystem (and optionally invoke CLI tools like `gitleaks`). A check that requires a missing tool must return `{ status: "skip", ... }`, not throw.
- `CheckResult.files` is optional; populate it when the check inspects specific file paths so the report can list them for auditor sampling.
- `severity: "critical"` checks are the only ones that trigger a non-zero exit under `--strict-fail`.
- The package is `"private": true` — it is never published to npm and has no build step (source files run directly under Bun).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../../PR_EVIDENCE.md)**. Read it.
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

**Capture & manually review for this package — cloud backend / security:**
- Real request → response traces against the local cloud stack (`bun run cloud:mock`) hitting real endpoints, plus the structured backend logs.
- The **DB state** the change produced/changed (Drizzle rows), billing/usage records, and migration up **and** down.
- Auth/role-gating and multi-tenant isolation proven by test, including the denied-access paths (see #9853/#9948) — not assumed.
- The agent trajectory for any model-backed endpoint.
<!-- END: evidence-and-e2e-mandate -->
