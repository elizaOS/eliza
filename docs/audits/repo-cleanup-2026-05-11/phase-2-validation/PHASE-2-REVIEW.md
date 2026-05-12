# Phase 2 Validation Review

Status: complete for validation/research. No cleanup implementation was performed.

## What Ran

Phase 2 used two passes:

1. Broad validation/research workers for lint/build, typecheck, tests, targeted verify, Knip/Madge/type tooling, and gap research.
2. Focused deep dives on the blockers found by pass 1.

All worker output is under:

```text
docs/audits/repo-cleanup-2026-05-11/phase-2-validation/
```

The only local validation rerun after the workers was a final root lint check:

```bash
PATH=/Users/shawwalters/.bun/bin:$PATH /Users/shawwalters/.bun/bin/bun run lint:check
```

It failed with one remaining formatter issue in `packages/core/src/services/message.ts` around line 5161.

## Validation Matrix

| Gate | Status | Primary blocker |
| --- | --- | --- |
| Root `bun run build` | PASS | None. Root build completed 189 Turbo build tasks plus examples/benchmarks build sweep. |
| Root `bun run typecheck` | PASS | None. Root typecheck passed 163 Turbo tasks plus examples/benchmarks typecheck. |
| Root `bun run lint:check` | FAIL | `@elizaos/core`: Biome formatter wants `packages/core/src/services/message.ts` planned-reply result object wrapped differently. |
| `packages/ui typecheck` | PASS | None. |
| `packages/app typecheck` | PASS | None. |
| `cloud/apps/frontend typecheck` | FAIL | Drizzle type identity conflict from two physical `drizzle-orm@0.45.2` installs. |
| Root `bun run test:ci` | FAIL | `packages/app#test:e2e`: game launch smoke failures, plus one intermittent Vincent artifact/disk failure. |
| Root `bun run test:e2e` | FAIL | `packages/app#test:e2e`: Defense of the Agents and ClawVille launch buttons not visible. |
| `bun run test:launch-qa` | FAIL | Stale required test file references; downstream docs/mobile/model-data gate drift. |
| `plugins/app-lifeops verify` | FAIL in Codex Node | `sharp` native addon rejected by Codex hardened bundled Node; selected suites pass under Homebrew Node. |
| `plugins/app-lifeops verify:live-schedule` | ENV FAIL | Needs local API at `127.0.0.1:31337` and populated LifeOps schedule/activity tables. |
| `cloud/apps/frontend verify` | FAIL | Biome formatting on `cloud/apps/frontend/src/pages/payment/[paymentRequestId]/page.tsx`. |
| `cloud verify` | FAIL | Biome formatting on 14 files, 15 diagnostics; local Biome binary/schema mismatch. |
| `packages/inference verify:contract` | PASS | None. |
| `packages/inference verify:reference` | PASS | None. |
| Knip | BLOCKED | `oxc-resolver` native binding/codesign load failure. No current Knip deletion signals are safe. |
| Madge source cycles | FAIL | 4 cycles: LifeOps scheduled-task service/runtime-wiring, UI branding React split, computeruse route registration, GitHub route registration. |
| Package barrel audit check | FAIL | 22 package subpath refs, 266 published subpath exports, 630 re-export markers. |
| Type audit | ACTIONABLE | 16,593 type definitions, 2,696 duplicate names; strongest candidate is byte-identical UI/shared type mirror. |

## Highest-Priority Implementation Order

1. **Fix root lint proof**
   - Apply the single Biome formatter change in `packages/core/src/services/message.ts`.
   - Rerun `bun run lint:check`.

2. **Fix cloud validation blockers**
   - Coordinate Biome formatting for the 14 cloud files listed in `triage-cloud-typecheck-biome.md`.
   - Add frontend Drizzle path aliases to `cloud/apps/frontend/tsconfig.json`, matching the API app strategy, so frontend typecheck uses one physical Drizzle install.
   - Rerun frontend lint/typecheck and `cloud verify`.

3. **Fix app e2e determinism**
   - In `game-apps.spec.ts`, control `/api/catalog/apps` alongside `/api/apps`, or navigate directly to `/apps/<slug>/details` if the test intends to validate the details launch panel.
   - Product hardening: unify duplicate app descriptor precedence between `loadAppsCatalog()` and `useRegistryCatalog()`.
   - Rerun `bun run test:e2e`, then `bun run test:ci`.

4. **Fix launch QA drift**
   - Update stale task references in `scripts/launch-qa/run.mjs`.
   - Decide canonical launchdocs root and align docs links, checker roots, and workflow filters.
   - Fix or intentionally update mobile app-group expectation and model-data schema checker for `eliza_native_v1`.
   - Rerun `bun run test:launch-qa`.

5. **Harden LifeOps validation**
   - Validation env: use non-hardened Node for Vitest on macOS Codex, or run in CI/Linux.
   - Code hardening: lazy-load `sharp` in `screen-context.ts` so unrelated LifeOps tests do not import native image tooling.
   - Treat `verify:live-schedule` as a live environment/data gate, not a unit CI gate.

6. **Unblock Knip before deletion work**
   - Repair local `oxc-resolver` binding/codesign or run Knip on CI/Linux.
   - Do not delete from historical Knip baselines until current Knip runs with framework-aware config.

7. **Resolve Madge cycles**
   - Remove scheduled-task service re-export from LifeOps runtime wiring.
   - Split UI branding base types/defaults from React context.
   - Stop exporting route-registration side-effect modules from computeruse/GitHub plugin public barrels.

8. **Start safe type/barrel consolidation**
   - First candidate: convert byte-identical `packages/ui/src/types/index.ts` to a compatibility re-export from `packages/shared/src/types/index.ts`, after dependency-direction review.
   - Define explicit allowed subpath exports before deleting wildcard exports.
   - Do not blindly consolidate semantically divergent types such as `TradePermissionMode`.

9. **Address high-risk LifeOps gaps**
   - Collapse stale `ScheduledTask` contract stubs.
   - Remove or production-gate first-run fallback scheduling.
   - Unskip and fix duplicate-dispatch concurrency test.
   - Wire plugin-health registry connectors or clearly mark them as non-live registry placeholders.

10. **Only then proceed to artifact/docs deletion**
    - Owner decisions are still required for large assets, generated reports, benchmark outputs, datasets, native binaries, and audit markdown retention.

## Deep-Dive Reports

- `deep-dives/triage-core-lint.md`
- `deep-dives/triage-cloud-typecheck-biome.md`
- `deep-dives/triage-app-e2e-game-launch.md`
- `deep-dives/triage-lifeops-launchqa-sharp.md`
- `deep-dives/triage-tooling-madge-types-barrels.md`

## First-Pass Reports

- `validation-lint-build.md`
- `validation-typecheck.md`
- `validation-tests.md`
- `validation-targeted-verify.md`
- `research-knip-madge-types.md`
- `research-gaps-weaknesses-optimization.md`

## Current Do-Not-Delete List

Do not delete or rename these based on current evidence alone:

- Files flagged only by stale Knip baselines.
- LifeOps/Health `contract-stubs` before canonical contract import direction is decided.
- plugin-health connector placeholders before the real registry bridge is wired or explicitly deferred.
- Fallback/shim/legacy route files before route ownership and compatibility windows are documented.
- App/game launch surfaces before e2e determinism is fixed.
- Generated action/prompt/spec files before generator sources are changed.
- Cloud DB/repository types before Drizzle physical identity is fixed.
- Any tracked assets, model/data artifacts, native binaries, or historical audit docs without owner signoff.

## Ready For Review

The repo is not currently green, but the blockers are now classified and actionable. The next review should decide which implementation batch to approve first. The recommended first batch is small and low-risk:

1. Root core Biome formatter fix.
2. Cloud Biome formatting plus frontend Drizzle path aliases.
3. Game-app e2e route-stub determinism.
4. Launch-QA stale reference fixes.

Those changes would make the validation baseline materially more reliable before any cleanup deletion wave begins.

