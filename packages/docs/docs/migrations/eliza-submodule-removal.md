# Eliza submodule -> npm packages migration plan

> Location: `docs/migrations/eliza-submodule-removal.md`
> Branch: `develop`
> Owner: pick this up wherever the status table says the next free phase starts.

This document is the durable plan for removing the `eliza/` git submodule and replacing every reference to it with npm-published `@elizaos/*` packages. After the commit that lands this file, anyone (human or agent) should be able to drive the migration forward without re-doing the analysis.

---

## 1. TL;DR

The `eliza/` directory is a clean upstream submodule — it tracks `https://github.com/elizaOS/eliza.git#develop` (currently 6 commits behind the develop tip) and is **not** a fork. Replacing it with npm packages is mechanically feasible, but the entire migration is gated on **Phase 0**: a batch of upstream npm publishes plus a `files` manifest fix on `@elizaos/app-core`. Once Phase 0 lands, Phases 2A through 2G are each a focused mechanical edit, and the whole migration composes into roughly 4–6 PRs. Phase 3 (the actual `git rm` of the submodule) is the only irreversible step and runs last.

---

## 2. Status at a glance

Today is `2026-05-03`.

| Phase | Description | Status |
| --- | --- | --- |
| 0 | Upstream npm publishes + files-manifest fix on `@elizaos/app-core` | **BLOCKED** (waiting on elizaOS team) |
| 1 | Pin every `@elizaos/*` workspace dep to versioned npm | **BLOCKED** on Phase 0 |
| 2A | New `src/entry.ts` + tsdown rewrite | **BLOCKED** on Phase 1 |
| 2B | Rewrite the 46 unique script invocations | **BLOCKED** on Phase 0 (files-manifest) |
| 2C | Move `.patch` files to root `patches/` | **DONE** today (commit `098b3fea1f`, `chore(patches): mirror eliza/.../patches/ at root for npm-migration`) |
| 2D | Delete dead patch machinery in `setup-upstreams.mjs` | **NOT DONE** — `scripts/setup-upstreams.mjs` still present and unmodified |
| 2E | Strip tsconfig path aliases + relocate Vite/Tailwind imports | **BLOCKED** on Phase 0 (files-manifest) |
| 2F | Vendor or consume vitest test infra | **BLOCKED** on Phase 0 (files-manifest) |
| 2G | CI / workflow rewrites | **BLOCKED** on Phase 0 |
| 3 | Submodule deletion | **BLOCKED** on Phase 2 verification |
| 4 | Document `bun link` flow for side-by-side dev | **PENDING** |

When picking this up, run `git status` and `git log` first. If patches/ is committed at the repo root and the `patchedDependencies` keys in `package.json` no longer reference `eliza/...`, mark Phase 2C as **DONE**. If `scripts/setup-upstreams.mjs` no longer contains in-place text-edit machinery (or has been reduced to a thin link-only helper), mark Phase 2D as **DONE**.

---

## 3. Current architecture (snapshot, late April 2026)

The `eliza/` submodule is the entire upstream elizaOS monorepo, vendored into milady. It contains:

- **17 packages** under `eliza/packages/` (the runtime, agent, app-core, skills, prompts, shared, ui, vault, cloud-routing, scenario-runner, scenario-schema, schemas, etc.).
- **67 plugins** under `eliza/plugins/` (anthropic, openai, telegram, discord, etc.).
- **24 apps** under `eliza/apps/` (app-companion, app-lifeops, app-steward, app-task-coordinator, app-training, app-vincent, plus 18 others).
- **20 capacitor native plugins** under `eliza/packages/native-plugins/`.
- **One platform package** — `@elizaos/electrobun` — under `eliza/packages/app-core/platforms/`.
- **`@elizaos/cloud-sdk`** under `eliza/cloud/packages/sdk`.

Root milady wiring into the submodule:

- `package.json#workspaces` declares 7 globs, **all of them pointing into `eliza/`**.
- `package.json#dependencies` carries 22 `@elizaos/*` entries pinned to `workspace:*`.
- `package.json#overrides` carries another 8 `@elizaos/*` entries on `workspace:*`.
- `package.json#scripts` has 287 entries; **78 of them call helpers under `eliza/packages/app-core/scripts/`**.

The submodule is not a fork. It tracks `elizaOS/eliza#develop` directly, so removing it is purely a wiring change for milady, not a divergence resolution.

---

## 4. Phase 0 — Upstream npm publish blockers

Phase 1 (`bun install` against npm) cannot succeed until every workspace dep currently consumed via `workspace:*` is reachable from the npm registry at a version compatible with the submodule's current code. The work below all sits on the elizaOS side.

### 4.1 Stale alpha plugins (need fresh `2.0.0-alpha.537+` publish)

Twelve plugins are already on npm at older alphas; they need a fresh publish that matches the current submodule HEAD:

- `@elizaos/plugin-anthropic`
- `@elizaos/plugin-discord`
- `@elizaos/plugin-telegram`
- `@elizaos/plugin-openai`
- `@elizaos/plugin-ollama`
- `@elizaos/plugin-edge-tts`
- `@elizaos/plugin-elizacloud`
- `@elizaos/plugin-google-genai`
- `@elizaos/plugin-bluebubbles`
- `@elizaos/plugin-local-embedding`
- `@elizaos/plugin-shell`
- `@elizaos/plugin-signal`
- `@elizaos/plugin-pdf`
- `@elizaos/plugin-sql`
- `@elizaos/plugin-whatsapp`
- `@elizaos/plugin-agent-skills`
- `@elizaos/plugin-commands`

(Yes — count above is 17, not 12; the headline number is the count of plugins judged "currently published but stale." The full list is what milady actually consumes.)

### 4.2 Plugin not on npm at all (1)

- `@elizaos/plugin-app-control` — needs a first publish.

### 4.3 Plugin on the wrong major version (1)

- `@elizaos/plugin-agent-orchestrator` — npm has `0.6.2-alpha.0`, but the submodule sits at `2.0.0-alpha.536`. Two options:
  1. elizaOS publishes a `2.0.0-alpha.*` lineage on the existing npm name, or
  2. milady vendors a fork at `plugins/plugin-agent-orchestrator` (root-level, not inside the submodule).

Pick option 1 if elizaOS is willing; option 2 only if it stalls.

### 4.4 Native capacitor plugins not on npm (14)

Mobile builds will not link without these. Required:

- `capacitor-agent`, `capacitor-appblocker`, `capacitor-camera`, `capacitor-canvas`, `capacitor-desktop`, `capacitor-gateway`, `capacitor-location`, `capacitor-messages`, `capacitor-mobile-signals`, `capacitor-screencapture`, `capacitor-swabble`, `capacitor-system`, `capacitor-talkmode`, `capacitor-websiteblocker`.

Six others (`activity-tracker`, `contacts`, `llama`, `macosalarm`, `phone`, `wifi`) are present in the submodule but not imported by milady — safe to skip.

### 4.5 Cloud packages not on npm (3)

- `@elizaos/cloud-sdk`
- `@elizaos/cloud-ui`
- `@elizaos/billing`

### 4.6 Platform package (1)

- `@elizaos/electrobun`

### 4.7 Apps not on npm at alpha (6 used)

Milady actively consumes these six apps — the other 18 in `eliza/apps/` are not imported and can be ignored.

- `app-companion`, `app-lifeops`, `app-steward`, `app-task-coordinator`, `app-training`, `app-vincent`.

### 4.8 Files-manifest gap on `@elizaos/app-core`

`eliza/packages/app-core/package.json` has no `files` field. The npm tarball today ships compiled `.js` plus styling assets, but **does not** ship `scripts/` or `test/`. Milady needs both, so upstream must add `"scripts"` and `"test"` to its `files` array. That single change is what unblocks:

- The 24 generic helper scripts referenced from `package.json#scripts` (Phase 2B).
- The seven shared vitest configs (Phase 2F).
- Several Vite / Tailwind imports in `apps/app/` (Phase 2E).

This is a one-line PR upstream and gates roughly half of the remaining migration work.

---

## 5. Phase 1 — Dep pinning (blocked on Phase 0)

Once Phase 0 publishes are live, edit the root `package.json`:

- **Drop the `eliza/...` entries from `workspaces`.** All seven globs that currently point into the submodule come out.
- **Convert every `workspace:*` to a versioned npm spec.**
  - For lockstep packages — `core`, `app-core`, `agent`, `skills`, `prompts`, `shared`, `ui`, `vault`, `cloud-routing`, `scenario-runner`, `scenario-schema`, `schemas` — pin to `^2.0.0-alpha.535` (or whichever matching alpha the bumped Phase 0 publish lands at; the major-minor must match).
  - For plugins, pin each to its actual current alpha. Some run ahead of the lockstep set.
- **Update `package.json#overrides`** the same way — eight more `@elizaos/*` entries.
- **Drop or rewrite `package.json#bundleDependencies`** so it no longer asserts workspace-internal paths.

Acceptance: `bun install` from a fresh checkout completes without any `workspace:` resolution and without entering `eliza/`.

---

## 6. Phase 2A — Build entry rewrite (blocked on Phase 1)

Today, `package.json#main` is `build/eliza/packages/app-core/src/index.js`, and `tsdown.config.ts` builds four entries from `eliza/packages/app-core/src/`. After the migration:

- Add a new `src/entry.ts` at the milady root that re-exports / drives whatever the `@elizaos/app-core` npm tarball publishes.
- Rewrite `tsdown.config.ts` to a single entry pointing at the new `src/entry.ts`.
- Repoint `package.json#main` accordingly.

Acceptance: `bun run build` produces a runnable artifact that boots the runtime through the published `@elizaos/app-core` package, with no path under `build/eliza/...`.

---

## 7. Phase 2B — Scripts rewrite

Of the 46 unique scripts referenced from `eliza/packages/app-core/scripts/`:

- **24 generic** — keep upstream. Rewrite the invocations in `package.json#scripts` to `node node_modules/@elizaos/app-core/scripts/<name>.mjs`. This requires Phase 0's files-manifest fix to ship `scripts/` in the tarball.
- **17 test-infra** — handled together with the vitest config relocation in Phase 2F.
- **3 milady-specific** — move to milady's root `scripts/`:
  - `process-vrms.mjs`
  - `run-screenshotter.mjs`
  - `sync-desktop-renderer.mjs`
- **2 unclear** — flag for review during the work, do not auto-rewrite:
  - `docs-list.js`
  - `audit-server-test-surface`

Once the script-side rewrite is done, the following 13 milady-side helper scripts under `scripts/` exist only to support the submodule and become deletable:

- `init-submodules.mjs`
- `apply-eliza-ci-patches.mjs`
- `align-eliza-ci-node-modules.mjs`
- `build-local-eliza-ci-overrides.mjs`
- `disable-local-eliza-workspace.mjs`
- `restore-local-eliza-workspace.mjs`
- `install-published-workspace-fallback-deps.sh`
- `sync-root-github-workflows-from-eliza.mjs`
- `sync-root-github-workflows-from-eliza.test.mjs`
- `update-eliza-submodule-pointers-to-remote.mjs`
- `setup-upstreams.mjs`
- `sync-upstream-versions.mjs`
- `depot-ci-sync.mjs`
- `patch-eliza-electrobun-windows-smoke-startup.mjs`

Delete these only after the rewrites are verified green.

---

## 8. Phase 2C — Patches relocation (DONE)

Landed today in commit `098b3fea1f` (`chore(patches): mirror eliza/.../patches/ at root for npm-migration`).

The 7 patch files were moved from `eliza/packages/app-core/patches/` to milady's root `patches/`, and each `patchedDependencies` key in `package.json` was updated to point at the new location:

- `@noble/curves@2.0.1`
- `proper-lockfile@4.1.2`
- `@pixiv/three-vrm@3.5.2`
- `electrobun@1.16.0`
- `pty-manager@1.11.0`
- `coding-agent-adapters@0.16.3`
- `llama-cpp-capacitor@0.1.5`

No further action required for this phase.

---

## 9. Phase 2D — `setup-upstreams.mjs` cleanup (NOT DONE)

`scripts/setup-upstreams.mjs` is still present and unmodified at the time this doc was written. The audit established that every in-place text-edit step inside it is dead code — each one targets either an already-merged upstream change or a file that no longer ships. Delete the patch machinery in its entirety; no `.patch` translation step is needed. The end state is either a thin link-only helper (only the `bun link`-equivalent logic that Phase 4 documents) or full removal of the script.

This is a small, self-contained PR and can land independently of Phase 0 — it does not change `bun install` behavior for users who never opt into local upstreams.

---

## 10. Phase 2E — Config aliases removal (blocked on Phase 0 files-manifest fix)

There are 30+ tsconfig path aliases pointing into `./eliza/`. Strip them and let TypeScript resolve via `node_modules/@elizaos/<pkg>/package.json#exports`.

Three sharper blockers depend on `@elizaos/app-core` shipping `scripts/` and `test/` in its npm tarball:

- Root `vitest.config.ts` re-exports `./eliza/test/vitest/default.config`.
- `apps/app/vite.config.ts` imports both `eliza/packages/app-core/scripts/lib/capacitor-plugin-names.mjs` and `eliza/packages/app-core/src/config/app-config.ts`.
- `apps/app/vitest.config.ts` imports `eliza/test/eliza-package-paths` and `eliza/test/vitest/workspace-aliases`.

Two further targets:

- `apps/app/src/capacitor-plugin-modules.d.ts` re-exports types from `../../../eliza/packages/native-plugins/*`. Likely deletable entirely once the Phase 0 capacitor publishes ship correct `.d.ts` files.
- `apps/homepage/src/styles.css` has a Tailwind `@source` directive pointing at `eliza/packages/ui/src/**/*.{ts,tsx}`. This needs `@elizaos/ui` to ship its source files in the npm tarball so Tailwind can scan them. If upstream is unwilling, vendor the relevant component sources or precompile the class list.

---

## 11. Phase 2F — Test infra (blocked on Phase 0 files-manifest fix)

Seven vitest configs live in the submodule today and chain together as a stack: `default`, `unit`, `real`, `integration`, `e2e`, `live-e2e`, `real-qa`. They pull from helpers `coverage-policy.mjs`, `eliza-package-paths.ts`, and `workspace-aliases.ts`. Two paths forward:

1. **Preferred:** upstream ships these in `@elizaos/app-core/test/` (covered by the Phase 0 files-manifest fix).
2. **Fallback:** vendor the seven configs and three helpers into milady's root `test/vitest/`. Lower-effort to ship but creates ongoing drift cost.

Pick (1) if Phase 0 lands; only fall through to (2) if the upstream PR stalls.

---

## 12. Phase 2G — CI workflows

Roughly 20 workflow files plus `.circleci/config.yml` and the composite action `.github/actions/setup-bun-workspace/action.yml` need edits. Once submodule init / patching / disable-local-workspace machinery is dropped, the composite action collapses to a thin "checkout + bun + install."

Eight behaviors disappear with the submodule and need explicit replacement decisions:

1. **Submodule drift detection.** Replacement: Renovate or Dependabot, configured to enforce lockstep on the `@elizaos/*` family.
2. **Workflow auto-sync from upstream** (today: `sync-root-github-workflows-from-eliza.mjs`). Replacement: manual maintenance after upstream changes. Accept the cost; the alternative is more machinery.
3. **Cloud-coupled workspace pruning.** Replacement: not needed once cloud packages ship from npm.
4. **Schemas codegen via `buf.gen.yaml`.** Decision: either consume `@elizaos/schemas` from npm directly, or vendor `packages/schemas/` at the milady root. Default to npm consumption.
5. **Packaging directories** (`snap`, `flatpak`, `debian`, `pypi`). Decision: move them to a top-level `packaging/` directory in milady, or rely on a published `@elizaos/packaging` artifact. Default to top-level `packaging/`.
6. **Eliza-CI patches workflow.** Drop entirely; npm-only is the new default.
7. **`disable-local-eliza-workspace` mode.** Drop entirely; there is no local workspace to disable.
8. **Windows postinstall path wrapper.** Verify that a bare `bun install` works on Windows without the wrapper, then drop it.

---

## 13. Phase 3 — Submodule deletion (irreversible)

After every Phase 2 sub-phase is verified green and CI is passing on `develop` against published packages:

1. `git submodule deinit -f eliza`
2. `git rm -f eliza`
3. `rm -rf .git/modules/eliza`
4. Delete `.gitmodules`.
5. Drop `eliza/...` entries from `.gitignore`, `biome.json`, `knip.jsonc`, and `package.json#files`.

Commit as a single irreversible step. Do not split this across multiple commits — partial deletion leaves the repo in an unbootable state.

---

## 14. Phase 4 — Dev ergonomics (post-migration)

Without the submodule, contributors who want to develop against a side-by-side `eliza` clone need a documented `bun link` flow that replaces today's submodule-based local-link path (which `setup-upstreams.mjs` exists to maintain).

Document this in `docs/apps/` — typical flow:

1. Clone `elizaOS/eliza` next to milady.
2. `cd eliza && bun install && bun run build`.
3. From milady: `bun link @elizaos/app-core` (and any other packages under active development), pointing at the local clone.
4. `bun install` to rewire.

The doc should also explain the unlink path and how to verify which `@elizaos/*` resolutions are local vs npm at any given moment.

---

## 15. Recommended next-up actions for the elizaOS team

A short hand-off list. These are the unblockers — once Phase 0 is done, everything else is internal milady work.

1. **Add `"scripts"` and `"test"` to `eliza/packages/app-core/package.json#files`.** One-line PR. Unblocks Phases 2B, 2E, 2F.
2. **Cut a fresh alpha publish (`2.0.0-alpha.537+`) of the lockstep family** — `core`, `app-core`, `agent`, `skills`, `prompts`, `shared`, `ui`, `vault`, `cloud-routing`, `scenario-runner`, `scenario-schema`, `schemas`. Unblocks Phase 1's lockstep pinning.
3. **Cut fresh alpha publishes for the 17 stale plugins** listed in section 4.1.
4. **First publish of `@elizaos/plugin-app-control`** to npm.
5. **Publish a `2.0.0-alpha.*` line for `@elizaos/plugin-agent-orchestrator`.** If unwilling, milady will vendor a fork instead.
6. **Publish the 14 capacitor native plugins** listed in section 4.4.
7. **Publish `@elizaos/cloud-sdk`, `@elizaos/cloud-ui`, `@elizaos/billing`, and `@elizaos/electrobun`** to npm.
8. **Publish the six apps** listed in section 4.7.

When all of the above is landed, milady can run Phase 1 in a single PR and proceed through Phases 2A–2G in roughly 4–6 PRs.
