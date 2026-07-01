# #10104 — fail-safe CI path-gating (no code change can skip every test lane)

Descends from #10104 Tier-2, bullet 1 of the 2026-07-01 reopen comment:
_"fail-safe path-gating for unmapped diffs such as `packages/elizaos/**` and
`packages/cloud/api/**`."_

## Root cause (confirmed on `origin/develop`)

`packages/scripts/ci-path-gate.mjs` narrows CI test lanes by changed path on
`pull_request` events. For every changed file it adds the file's matching rule
lanes; **a file that matches no rule contributes to no lane.** If *every* changed
file matches no rule, *every* lane resolves to `false` and `test.yml` skips all
test jobs — the PR is green having run **zero** substantive tests.

Two concrete holes were verified:

1. **`packages/elizaos/**` (the `elizaos` CLI) was unmapped.** Its unit suite
   (`scaffold.test.ts`, `migrate/migrate.test.ts`, `remove-path-recursive.test.ts`)
   is meant to run under `test:server` — the `test:server` package filter already
   lists `packages/elizaos`. But no `test.yml` path-gate rule enabled the `server`
   lane for a CLI-only diff, `windows-ci.yml`'s PR `paths:` filter excludes
   `packages/elizaos/**`, and `test-packaging.yml` tests the *Python* `elizaos_app`
   package, not the TS CLI. Net: **a CLI-only PR ran the elizaos suite on no lane.**
2. **`packages/skills/**` had the same hole** — listed in the `test:server` filter,
   but no path-gate rule; a skills-only PR skipped every lane.

More generally, any *new* package nobody remembered to map would silently
skip-all-green.

## Fix (`packages/scripts/ci-path-gate.mjs`)

- **Explicit mapping** for the two named holes: `packages/elizaos/**` and
  `packages/skills/**` → `server` lane (whose `test:server` filter already runs
  them, so the lane genuinely executes their suites).
- **Generic fail-safe:** any changed file under a code root (`packages/**` /
  `plugins/**`) that matched no rule and is not an exempt docs/marketing path
  (`packages/docs/**`, `packages/homepage/**`, `packages/cloud/docs-redirect/**`)
  enables the `server` lane. This is the "default unmapped diffs to a minimal
  test lane instead of skip-all-green" the issue asks for — it makes it
  structurally impossible for a code change to skip every lane again.
- Pure docs/marketing and non-code (top-level) changes still skip cleanly.
- Configs without a `failSafe` block (`scenario-pr`, `docker`, `mobile`, …) are
  unaffected.

No `test.yml` edit is needed: the fail-safe flips the existing `server` output,
and `server-tests` already gates on `needs.changes.outputs.server == 'true'`.

## Before / after (same input, develop gate vs this PR)

| Changed file (PR diff) | develop (BEFORE) | this PR (AFTER) |
| --- | --- | --- |
| `packages/elizaos/src/scaffold.ts` | all lanes `false` — **skip-all-green** | `server=true` (explicit rule) |
| `packages/skills/src/index.ts` | all lanes `false` — **skip-all-green** | `server=true` (explicit rule) |
| `packages/inference/src/router.ts` (novel pkg) | all lanes `false` — **skip-all-green** | `server=true` (fail-safe) |
| `packages/cloud/routing/src/resolve.ts` | all lanes `false` — **skip-all-green** | `server=true` (fail-safe) |
| `packages/docs/pages/intro.mdx` (docs only) | all lanes `false` | all lanes `false` (correctly skips) |
| `README.md` (top-level) | all lanes `false` | all lanes `false` (correctly skips) |

Reproduce: `node packages/scripts/ci-path-gate.mjs --config test --event pull_request --changed-files <file>`.
Full captured output: `before-after-gate.txt`.

## Validation

- `node packages/scripts/ci-path-gate.self-test.mjs` → `ci-path-gate self-test passed`
  (existing cases + 7 new: elizaos, skills, novel-pkg fail-safe, registry fail-safe,
  docs-skip, top-level-skip, mixed-docs+orphan). Output: `self-test.txt`.
- `node --check` clean on both files.
- `bunx @biomejs/biome@2.5.1 check` → exit 0 (the 4 warnings are pre-existing
  `process.env` accesses on untouched lines).
- This PR touches `packages/scripts/ci-path-gate.mjs`, which is itself a path-gate
  rule (`.github/workflows/test.yml` + shared CI setup) → the PR enables **all**
  test lanes, so CI runs the full matrix against the change.

Screenshots/video/native capture: **N/A** — this is a CI path-gating script with
no UI, runtime, or device surface. Evidence is the deterministic before/after gate
output above.

## Follow-up finding (out of scope here, filed separately)

While tracing where cloud tests run, `packages/scripts/test-cloud-run.mjs`
(`bun run test:cloud`) executes only `packages/cloud/shared/src`,
`packages/cloud/api/__tests__`, and `packages/scripts/cloud`. It does **not** run
`packages/cloud/services/**` (15 test files), `packages/cloud/routing/**`
(1), `packages/cloud/infra/**` (6), or the colocated `packages/cloud/api/v1/**` /
`webhooks/**` route tests (~26) — and `cloud-tests.yml`'s `paths:` filter omits
`routing`/`infra` entirely. That is a separate false-green needing the cloud test
env (pglite/staging) to fix and validate; documented here so it is not lost.
