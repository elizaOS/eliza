# LifeOps Remediation Log

This file turns the review into explicit TODOs. Each item records the problem, the fix options considered, the selected approach, and the risk checks that must hold after implementation.

## 1. Route registry drift between `lifeops-routes.ts` and plugin route registration

- [x] Register every exact-path LifeOps route in the plugin bridge and add a test that compares the handler source against the plugin route table.
- Why this was broken: `src/routes/plugin.ts` carried a second hand-maintained route list and missed live endpoints.
- Options considered:
  - Keep the duplicate list and patch the missing routes only.
  - Extract a shared route manifest and refactor both modules onto it.
  - Patch the missing routes now and add a source-driven invariant test so future drift fails immediately.
- Selected approach: Patch the missing routes and add the invariant test. It fixes the current breakage without a risky refactor of the monolithic route handler.
- Risk checks:
  - `/api/lifeops/gmail/batch-reply-drafts` must be registered.
  - `/api/lifeops/browser/companions/pair` must be registered.
  - `/api/lifeops/browser/companions/sync` must be registered.
  - The test must fail if any future `pathname === "/api/..."` handler is missing from the plugin route table.

## 2. Package-local Vitest config is not discovering LifeOps tests

- [x] Make `eliza/apps/app-lifeops/vitest.config.ts` resolve from repo root instead of accidentally matching the repo-root helper tests only.
- Why this was broken: the config extended a repo-root base config but kept package-relative include globs, so `vitest --config eliza/apps/app-lifeops/vitest.config.ts` matched the wrong files.
- Options considered:
  - Change only the include globs to repo-root-relative paths.
  - Set `root` explicitly to repo root and compute LifeOps include globs from the config location.
  - Drop the package-local config and force all runs through the repo-root config.
- Selected approach: set `root` explicitly and compute package globs relative to it. That keeps the package-local command working regardless of the current shell cwd.
- Risk checks:
  - `vitest list --config eliza/apps/app-lifeops/vitest.config.ts` must enumerate LifeOps tests under `src/`, `test/`, and `extensions/`.
  - The package-local route test must still run under that config.

## 3. `GET /api/lifeops/definitions/:id` returns a broken `performance` payload

- [x] Remove the local stubbed `computeDefinitionPerformance()` from `service-mixin-reminders.ts` and use the real helper from `service-helpers-occurrence.ts`.
- Why this was broken: the single-definition path used a local stub that always returned `{}`, while list/update flows already used the real implementation.
- Options considered:
  - Reimplement the helper inline inside the reminders mixin.
  - Import the existing helper used by the definitions mixin.
  - Move the single-definition code into the definitions mixin.
- Selected approach: import the existing helper. It removes the drift with the smallest change and keeps one implementation of the performance contract.
- Risk checks:
  - `getDefinitionRecord()` must return the same performance shape as `listDefinitions()`.
  - No local stub or placeholder should remain.

## 4. Native activity tracking is still wired to a stub package

- [x] Replace the local stub imports with the real `@elizaos/native-activity-tracker` package and remove the stub file if nothing references it.
- Why this was broken: the package dependency already exists, but the app still imported a local file that always disabled itself.
- Options considered:
  - Keep the stub and gate it behind an env toggle.
  - Swap imports to the real package and let non-Darwin platforms degrade via the package's `isSupportedPlatform()`.
  - Inline the native package code into LifeOps.
- Selected approach: use the real package directly. The dependency already exists and already exposes the platform check and collector entrypoint.
- Risk checks:
  - Non-Darwin platforms must still return `disabled-non-darwin`.
  - Darwin startup failures must surface as a real `failed` mode, not a fake “disabled” mode.

## 5. `GET_TIME_ON_SITE` is still a shipped placeholder

- [x] Replace the hardcoded zero-return path with actual reads from the browser activity store and remove the “until T8e ships” placeholder language.
- Why this was broken: the action returned a fake zero result even though browser-domain report types and a store already existed in the repo.
- Options considered:
  - Leave the action as a placeholder and only update the copy.
  - Read the most recent browser activity report only.
  - Keep a bounded in-memory history of browser activity reports and feed it from the existing browser companion sync stream, then aggregate the requested domain across the requested window.
- Selected approach: aggregate from a bounded report history and derive focus windows from the existing browser companion sync deltas. That keeps the existing extension contract intact while making `GET_TIME_ON_SITE` work end-to-end instead of reading from an unwired store.
- Risk checks:
  - No hardcoded zero path should remain.
  - NoData responses must distinguish “no reports received” from “reports exist but this domain had no time”.
  - Browser companion sync must record bounded focus windows so the action has a live writer path.

## 6. Cross-channel send advertises unsupported channels and uses fake method lookups

- [x] Remove `x_dm` from the supported matrix and route supported non-email/Twilio channels through real dispatch paths.
- Why this was broken: the action claimed support for channels that either had no implementation or depended on runtime send handlers it never used.
- Options considered:
  - Keep the current matrix and keep returning “not implemented”.
  - Shrink the matrix to channels with proven dispatch paths only.
  - Use real runtime send handlers where available and keep only channels with an actual dispatch path.
- Selected approach: drop `x_dm`, keep the channels that have a real send path, and dispatch through runtime send handlers where that is the real integration seam.
- Risk checks:
  - The action must no longer advertise `x_dm`.
  - Runtime-handler failures must return a truthful error, not a fake “not implemented” branch.

## 7. Multi-step auth/session flows are restart-fragile

- [x] Persist recoverable pending-session state for Google OAuth and the Telegram/Signal connector flows, and restore it on status/complete paths when safe.
- Why this was broken: pending state lived in process maps, so a restart or crash invalidated in-flight connector flows.
- Options considered:
  - Leave them in memory and document the limitation.
  - Persist only Google OAuth because it is trivial to serialize.
  - Persist all serializable wrapper state and restore it when the underlying connector can safely resume.
- Selected approach: persist all serializable wrapper state that can be recovered without inventing fake sessions, starting with Google and then the Telegram/Signal wrapper metadata.
- Risk checks:
  - Google callback must succeed after process restart if the state file is still within TTL.
  - Telegram pending auth status must recover from the persisted wrapper metadata plus the plugin-telegram persisted auth state.
  - Signal pending status must recover or transparently regenerate a fresh QR instead of failing with “session not found”.

## 8. Plugin startup hides critical failures and continues half-broken

- [x] Fail plugin init when schema bootstrap or required worker/task initialization fails after retries.
- Why this was broken: plugin init logged critical failures but kept running, producing ambiguous “loaded but not working” states.
- Options considered:
  - Keep log-and-continue behavior.
  - Fail only schema bootstrap and keep worker init best-effort.
  - Fail schema bootstrap and required worker/task initialization after bounded retries.
- Selected approach: make critical init failures fatal after bounded retries. A broken plugin should fail loudly instead of pretending to be healthy.
- Risk checks:
  - Schema bootstrap failure must abort init.
  - Scheduler task init failure after retries must abort init.
  - Proactive-task init must either be disabled explicitly or succeed.

## 9. Dead duplicate UI file for `WebsiteBlockerSettingsCard`

- [x] Delete the unused root-level `src/WebsiteBlockerSettingsCard.tsx` duplicate.
- Why this was broken: the live exports point at `src/components/WebsiteBlockerSettingsCard.tsx`, leaving the root file as stale dead code.
- Options considered:
  - Keep both and document which one is live.
  - Re-export one from the other.
  - Delete the dead duplicate.
- Selected approach: delete the dead duplicate. There is no value in keeping a second divergent implementation that nothing imports.
- Risk checks:
  - No remaining imports should reference the deleted file.
