# Issue #13617 — Harden the develop merge gate

## F1 — advisory `changes` classifiers still hang on the self-hosted SPOF (FIXED here)

`test.yml`'s `changes` classifier and `codeql.yml` were already reverted to
GitHub-hosted on develop, but six sibling classifier jobs were still pinned to
`runs-on: [self-hosted, hetzner-robot]` with **no `timeout-minutes`**. When the
`hetzner-robot` fleet is offline these jobs sit `queued` indefinitely (the exact
gridlock documented in `.github/workflows/README.md` "Linux Runner Policy" and
reverted for other jobs in #8501), piling up zombie runs.

Each of these `changes` jobs is a lightweight git-diff + `node ci-path-gate.mjs`
path classifier — identical in shape to `test.yml`'s classifier, which already
runs on `ubuntu-24.04`. They need **no** self-hosted resources. This change moves
all six to `ubuntu-24.04` and adds `timeout-minutes: 10`, bringing them into
compliance with the documented Linux Runner Policy ("Linux CI jobs run on
GitHub-hosted Ubuntu").

Jobs swept (each: `runs-on: [self-hosted, hetzner-robot]` → `ubuntu-24.04` + `timeout-minutes: 10`):

| Workflow | Classifier job | line (develop) |
|---|---|---|
| `dev-smoke.yml` | `changes` | 52 |
| `docker-ci-smoke.yml` | `changes` | 23 |
| `mobile-build-smoke.yml` | `changes` | 25 |
| `windows-dev-smoke.yml` | `changes` | 23 |
| `windows-desktop-preload-smoke.yml` | `changes` | 20 |
| `scenario-pr.yml` | `changes` | 44 |

**Downstream jobs are unchanged** — they already run on hosted runners
(`ubuntu-24.04` / `macos-15` / `windows-latest`). Only the classifier gate moves.

### Verification (F1)

- Each file had exactly one `runs-on: [self-hosted, hetzner-robot]` occurrence
  (the classifier); post-edit each file has **zero** remaining self-hosted-hetzner
  references.
- Each edited workflow parses as valid YAML (`yaml.safe_load`).
- Behavioral equivalence: the classifier steps (`actions/checkout` with
  `submodules: false`, `actions/setup-node`, `node packages/scripts/ci-path-gate.mjs`)
  are runner-agnostic and match `test.yml`'s already-merged hosted classifier —
  no `sudo`-only install/cleanup, no self-hosted-only tooling.

## F2 — develop's required gate enforces far less than main (RUNBOOK for maintainer)

`ci-ok` (test.yml, the single required context in ruleset 18511845) gates
develop but runs **no repo-wide lint, `format:check`, repo-wide typecheck,
gitleaks, or stale-base guard** — all of which are required on `main`. Two safe
ways to close this; both need a step I cannot perform in this environment (a
live merge-queue dry-run and/or an admin ruleset edit on the busiest branch,
~200 PRs/day — a wrong required check wedges every develop merge):

**Option A (no ruleset change — preferred): fold the gates into `ci-ok`.**
Because a job can only `needs:` jobs in its own workflow, add jobs to
`test.yml` mirroring `quality.yml`'s lint/format/typecheck steps and
`gitleaks.yml` verbatim, then add them to `ci-ok`'s `needs:` list and both
result-check blocks (lines ~1260 and ~1294). The existing required `ci-ok`
context then transitively enforces them — no ruleset edit.
*Risk:* the new jobs must be proven green on a real merge_group run first, or
`ci-ok` goes red for every develop PR. Requires a build-capable environment.

**Option B: add `merge_group` triggers + ruleset contexts.**
Add `merge_group: { branches: [develop], types: [checks_requested] }` to
`quality.yml`, `gitleaks.yml`, `stale-base-guard.yml`, then add their contexts
(`Format + Type Safety Ratchet`, `gitleaks`, `stale-base guard`, `Develop Gate
(lint)`) to ruleset 18511845's `required_status_checks`. Must be done together:
adding a required context that never posts on merge_group wedges the queue.

## Acceptance criteria mapping

- ✅ "With the `hetzner-robot` fleet unavailable, a develop PR still reaches an
  `ci-ok` conclusion" — F1 removes the last self-hosted classifiers from the PR
  path (the gating classifiers were already hosted; this finishes the sweep so
  no advisory job piles queued runs that mask the gate).
- ⏳ "A develop PR with a lint + type error + committed secret is refused by the
  merge queue" — requires F2 (Option A or B) + a live merge-queue proof run,
  which needs a build-capable, ruleset-admin environment. Runbook above.

## N/A with reason

- Live `gh run view` / red-PR merge-queue screenshots — **N/A here**: requires
  triggering real merge-queue runs against a drained fleet and (for F2) editing
  production branch protection, neither of which is safe/possible from this
  disk-full, build-less worktree. The F1 change is proven by YAML validation +
  behavioral equivalence to the already-merged `test.yml` classifier precedent.
