# CI circular-bootstrap integration receipt

Date: 2026-07-19
Branch: `sol/ci-bootstrap-integration-20260719`
Base: `develop` at `f2b1c6ed3e906bd5dc18f89e9d91eb6b2ac99420`
Merge policy: manual maintainer review and merge only

## Why one integration PR is required

The three reviewed CI proposals cannot independently produce a fully green, policy-compliant run:

- PR #16633 removes the retired Anthropic-backed blockers, but its Quality run needs the cache/typecheck repair from #16614 and the unprivileged Playwright setup from #16593.
- PR #16614 proves the complete Type Check graph in 10m07s, but its Build reaches the Playwright sudo defect repaired by #16593 and its old base still requires the Anthropic checks retired by #16633.
- PR #16593 removes Playwright's sudo path while preserving the real homepage E2E, but its Type Check and Build need #16614's cache/budget repair and its old base still requires the checks retired by #16633.

No required check is bypassed and no old run is rerun. This branch combines only the already-reviewed source heads so one fresh full CI run can validate the complete bootstrap.

## Exact reviewed sources

- PR #16633: `5049058b52d40d6ef3bdd7e8e63106028fd3b5d0`
  - deterministic no-cost `claude-review` and `security` stubs;
  - no Anthropic action, credential, checkout, or PR-code execution in those stubs;
  - fail-closed Security Advisory Gate based only on deterministic `gitleaks`;
  - focused tests and `CI-REVIEW-16633-BOOTSTRAP-2026-07-18.md`.
- PR #16614: `c50f0d2718dae7c6bdc2e453750be9f704c41151`
  - direct pinned cache action instead of the double-composite save boundary;
  - lane-scoped immutable primary keys with deterministic cross-lane restore prefixes;
  - complete unfiltered `bun run typecheck` graph;
  - measured, finite 18-minute cold allowance and eight fail-closed contracts.
- PR #16593: `ed3e9fb04b1d484f386c56930d3eff41799d7ceb`
  - unprivileged Chromium installation on the provisioned self-hosted fleet;
  - preserved real homepage `bun run test:e2e` step;
  - fail-closed browser and realness contracts.

Before the corrective fresh-run work below, every non-overlapping integrated file was byte-compared with its source head. The initial shared `.github/workflows/quality-fork.yml` contained the exact #16614 Type Check/cache changes plus the exact #16593 one-line Playwright change. The same integration PR then received the narrowly measured cold-path correction documented next.

## Fresh Quality attempt 1 and corrective work

Fresh synchronize attempt 1, Quality run `29676942860`, proved the static integration but exposed that the original ceilings were still below measured cold work:

- Type Check job `88165928175`: checkout/tool setup began at `06:45:02Z`; workspace setup took **4m15s**, including an exact Turbo miss and **2m50s restoring a stale 1.6 GiB Bun fallback cache**; core dist took 17s; the complete unfiltered typecheck remained active for **13m28s** until the 18-minute job ceiling canceled it.
- Build job `88165928164`: workspace setup took **2m44s**, including the same exact Turbo miss and **2m04s stale 1.6 GiB Bun fallback restore**; all **175/175** build tasks completed cold in **13m45.122s** with `0 cached`; homepage build took 4s; unprivileged Chromium install completed immediately; the real **48-test** Playwright suite started at `07:01:56Z` and was still executing when the 20-minute ceiling canceled it.

The stale broad Bun-cache restore was measurable negative value: each lane transferred 1.6 GiB before a sub-minute lockfile install. The corrective change therefore:

- adds a default-on `cache-bun-install` setup input, preserving existing callers;
- disables that global Bun-cache transfer only for the two long Quality cold lanes while retaining exact dependency installation, the full Type Check graph, and the real Playwright suite;
- sets measured finite cold ceilings of **25 minutes** for Type Check and **30 minutes** for Build, rather than filtering work or weakening failure behavior;
- extends the cache contract to pin the opt-out, full graph, real E2E, and both bounded ceilings.

The corrective edit changes `.github/actions/setup-bun-workspace/action.yml`, `.github/workflows/quality-fork.yml`, and the Turbo cache contract beyond the three source snapshots. No product code, typecheck filtering, E2E skipping, or advisory bypass was added.

## Deterministic validation

- `node --test scripts/security/security-advisory-gate.test.mjs scripts/security/advisory-workflow-stubs.test.mjs`: **12 passed, 0 failed**.
- Five gate canaries, `bypass`, `protected`, `waiting`, `success`, and `failure`: **all passed**.
- `node --check` on the gate and both focused test files: **passed**.
- Initial `bun test packages/scripts/__tests__/ci-turbo-cache-contract.test.ts`: **8 passed, 0 failed**.
- Corrective cold-path contract after attempt 1: **9 passed, 0 failed**.
- `bun test packages/scripts/__tests__/quality-fork-browser-contract.test.ts`: **4 passed, 0 failed**.
- `actionlint v1.7.12` with `.github/actionlint.yaml` on all three modified workflows: **passed**.
- PyYAML `BaseLoader` parse of all three workflows, including exact `claude-review` and `security` job IDs: **passed**.
- `git diff --check origin/develop...HEAD`: **passed**.

## Fresh full-CI acceptance criteria

Manual merge review should require all of the following on this integration PR:

- legacy `claude-review` and `security` stub checks succeed;
- Security Advisory Gate and `gitleaks` succeed fail-closed;
- Quality Type Check runs the full graph and completes under its measured 25-minute cold ceiling;
- Build completes all 175 build tasks, installs Chromium without sudo, and completes the real 48-test homepage E2E under its measured 30-minute cold ceiling;
- evidence, coverage, lint, and build gates are green.

This receipt authorizes no auto-merge, admin merge, ruleset bypass, or self-merge.

[sol-orch]
