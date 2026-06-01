# @elizaos/soc2-verify

SOC2 control-verification harness: runs static and dynamic checks against the elizaOS monorepo and emits a JSON + Markdown evidence report for auditor sampling.

## Purpose / role

This is a private developer tool (not published to npm). It is run directly via `bun run src/cli.ts` from the monorepo root, or via the `verify` / `verify:strict` scripts. It consumes `@elizaos/security` (workspace package) for its dynamic KMS and audit-dispatcher checks, and reads the filesystem and git metadata of the elizaOS monorepo root. Nothing imports from this package at runtime.

## Layout

```
packages/soc2-verify/
  src/
    index.ts          Public API: re-exports types, ALL_CHECKS, runVerification, report helpers
    cli.ts            Entry point for the CLI (bun run src/cli.ts)
    types.ts          Core types: Check, CheckContext, CheckResult, CheckSeverity,
                        CheckStatus, EvidenceReport, ReportControlBlock, VerificationConfig
    controls/
      index.ts        Assembles ALL_CHECKS (all 27 checks ordered by TSC category)
      audit-actions.ts  CC4 — audit action comprehensiveness check
      codeowners.ts   CC6 — CODEOWNERS, branch-protection, SECURITY.md checks
      db-and-pii.ts   C1 — DB SSL, KMS adoption, PII/soft-delete columns, log retention
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
bun run --cwd packages/soc2-verify verify           # run all checks, write report
bun run --cwd packages/soc2-verify verify:strict    # exit 1 if any critical check fails
bun run --cwd packages/soc2-verify test             # vitest run (unit suite)
bun run --cwd packages/soc2-verify test:watch       # vitest watch
bun run --cwd packages/soc2-verify typecheck        # tsgo --noEmit
```

Or run the CLI directly with flags:

```bash
bun run packages/soc2-verify/src/cli.ts \
  --out .soc2-evidence/run-1 \
  --strict-fail \
  --include CC8.1          # only run checks whose id contains "CC8.1"
```

## Config / env vars

| Variable | Effect |
| --- | --- |
| `SOC2_OUTER_ROOT` | Override the workspace root used for outer-repo checks (`.github/workflows`, etc.). Default: parent of the elizaOS monorepo root. |
| `SOC2_GITLEAKS_LOG_OPTS` | git log range passed to `gitleaks detect --log-opts`. Default: `--all`. |

Root discovery walks upward from `src/cli.ts` looking for a directory containing both `packages/security/` and `packages/soc2-verify/`. Falls back to `process.cwd()`.

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
- Dynamic checks in `src/controls/dynamic.ts` instantiate real `@elizaos/security` adapters (`MemoryKmsAdapter`, `AuditDispatcher`, `InMemorySink`) — they do not mock. This is intentional: the harness proves the security package actually works.
- Static checks inspect the filesystem (and optionally invoke CLI tools like `gitleaks`). A check that requires a missing tool must return `{ status: "skip", ... }`, not throw.
- `CheckResult.files` is optional; populate it when the check inspects specific file paths so the report can list them for auditor sampling.
- `severity: "critical"` checks are the only ones that trigger a non-zero exit under `--strict-fail`.
- The package is `"private": true` — it is never published to npm and has no build step (source files run directly under Bun).
