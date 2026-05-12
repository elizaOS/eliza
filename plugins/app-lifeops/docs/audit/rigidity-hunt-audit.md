# LifeOps — Rigidity Hunt + Flexibility Refactor Audit

**Scope:** `plugins/app-lifeops/src/lifeops/` (excluding `actions/`, `connectors/`, `channels/`, `registries/`, `send-policy/`, `signals/`, `default-packs/`), and `plugins/plugin-health/src/` (excluding `circadian.ts`, `health.ts`).

**Cross-references:** `plugins/app-lifeops/docs/audit/HARDCODING_AUDIT.md` (the foundational audit, partially shipped). Items in that doc's Section 5–7 ("registry candidates") are explicitly out of scope here — they're documented as risky decompositions that this safe-mechanical sweep deliberately punts.

**Method:** grep across the in-scope files for hardcoded URLs/hostnames, scenario-shaped `kind === "X"` switches, naked numeric literals (especially timeouts and retry windows), `process.env.NODE_ENV` branches, `Object.keys(SOME_CONST)` enumerations, fallback shims of the form `?? "https://..."` / `?? <magic-number>`. For each candidate, decided `fixed | punted | by_design` based on the conservative criteria laid out in CLAUDE.md / AGENTS.md.

**Date:** 2026-05-09.

---

## Summary

| Severity | Total finds | Fixed | Punted | By design |
|---|---|---|---|---|
| `hardcoded_url` | 28 | 0 | 5 | 23 |
| `scenario_switch` | 18 | 0 | 18 | 0 |
| `magic_number` | 5 | 5 | 0 | 0 |
| `locale_lock` | 0 | 0 | 0 | 0 |
| `test_branch` | 1 | 0 | 1 | 0 |
| `enum_lock` | 1 | 0 | 1 | 0 |
| `fallback_shim` | 4 | 0 | 4 | 0 |
| **Total** | **57** | **5** | **29** | **23** |

**Fixes applied (5, all magic-number → named-constant):**

1. `service-mixin-reminders.ts:3984` `setTimeout(r, 2_000)` → `REMINDER_DELIVERY_RETRY_DELAY_MS` named constant.
2. `notifications-push.ts:104` Ntfy span `timeoutMs: 10_000` → `NTFY_PUBLISH_TIMEOUT_MS`.
3. `notifications-push.ts:113` `AbortSignal.timeout(10_000)` → `NTFY_PUBLISH_TIMEOUT_MS` (same constant).
4. `service-mixin-goals.ts:473–476` three goal-staleness ms literals (`2 * 24 * 60 * 60 * 1000`, `10 * …`, `7 * …`) → `GOAL_STALE_DAYS_FREQUENT`, `GOAL_STALE_DAYS_WEEKLY`, `GOAL_STALE_DAYS_DEFAULT` × `ONE_DAY_MS`.
5. (Bundled with #4 — three constants and a shared `ONE_DAY_MS` helper added in one spot.)

No URL / scenario-switch / locale / fallback-shim refactors were applied. Each was assessed and deliberately punted because the change is either (a) high-risk (planner-sensitive switching), (b) already documented as a registry candidate by `HARDCODING_AUDIT.md`, or (c) the literal is correct vendor data with appropriate env-override pattern.

---

## Inventory

### Severity: `hardcoded_url` — 28 finds

#### By design (23) — vendor URLs that are correct as literals

| File | Line | Literal | Rationale |
|---|---|---|---|
| `service-mixin-drive.ts` | 18–21 | Google Drive OAuth scope strings | OAuth scopes are vendor-protocol identifiers, not configuration. |
| `google-scopes.ts` | 8–20 | Google Calendar / Gmail OAuth scopes | Same. |
| `google-plugin-delegates.ts` | 195–218 | Google OAuth scope strings | Same. |
| `service-normalize-calendar.ts` | 219–245 | Gmail scope membership checks | Verifying scopes against canonical Google identifiers; literal must match Google's spec. |
| `subscriptions-playbooks.ts` | 223–947 | ~80 vendor management URLs (Netflix, Hulu, Apple, etc.) | Static playbook data — these URLs are user-redirect targets, not service endpoints. Catalog data, not config. |
| `cross-channel-search.ts` | 756–757 | `https://x.com/...` permalink template | Permalink URL pattern published by X. |
| `social-taxonomy.ts` | 199 | `https://${trimmed}` URL prepender | Generic URL parsing helper, not a hardcoded host. |
| `password-manager-bridge.ts` | 73, 82, 91 | `github.com/login`, `mail.google.com`, `signin.aws.amazon.com` | Mock/fixture data for password-manager benchmark. |
| `x402-payment-handler.ts` | 4 | `https://www.x402.org` (in comment) | Spec reference comment. |
| `checkin/checkin-service.ts` | 796 | `https://x.com/i/web/status/...` | X tweet permalink template. |
| `health-bridge/health-bridge.ts` | 425 | `https://www.googleapis.com/fitness/...` | Google Fit aggregate API endpoint. |

#### Punted (5) — vendor base URLs with appropriate env-override pattern

| File | Line | Literal | Severity | Disposition |
|---|---|---|---|---|
| `twilio.ts` | 95 | `process.env.ELIZA_MOCK_TWILIO_BASE ?? "https://api.twilio.com"` | `hardcoded_url` | **punt — by design.** The fallback is the canonical Twilio API base; the env var is for mock override. Pattern is correct per AGENTS.md (vendor URL with explicit env override). |
| `travel-adapters/duffel.ts` | 35 | `DUFFEL_API_BASE_DEFAULT = "https://api.duffel.com"` | `hardcoded_url` | **punt — by design.** Same pattern as Twilio: vendor base URL with `LIFEOPS_DUFFEL_API_BASE` env override. |
| `health-bridge/health-oauth.ts` | 146–200 | Per-provider OAuth URLs (Strava, Fitbit, Withings, Oura) | `hardcoded_url` | **punt.** Already documented as registry candidate in HARDCODING_AUDIT §5.1 (ConnectorRegistry). High-risk to refactor — these URLs are part of OAuth provider definitions; should migrate together with capability registry. |
| `health-bridge/health-connectors.ts` | 182–188 | `switch (provider) → return "https://www.strava.com/..."` | `hardcoded_url` + `scenario_switch` | **punt.** Same as above — per-provider URLs in a switch belong to the connector-registry refactor. |
| `service-mixin-workflows.ts` | 842 | `internalUrl = new URL("http://127.0.0.1/")` | `hardcoded_url` | **punt.** Code smell: a placeholder URL passed to internal feed-getters to satisfy a parameter signature. Refactoring requires changing the feed-getter signatures across `service-mixin-{calendar,gmail,health}.ts`. Out of scope for safe sweep. |

### Severity: `scenario_switch` — 18 finds

All punted. Each is one of: (a) discriminated-union exhaustion (necessary type narrowing); (b) a documented registry candidate from HARDCODING_AUDIT; or (c) a planner-sensitive switch the audit flagged as risky.

| File | Line | Switch axis | Disposition |
|---|---|---|---|
| `service-mixin-discord.ts` | 389–421 | Browser action result union (`open`/`navigate`/`read_page`/`extract_links`/`extract_forms`) | **punt — by design.** Discriminated union exhaustion. A registry would over-engineer a 5-variant browser action result reader. |
| `service-mixin-reminders.ts` | 3400, 3417 | Reminder review transition `kind` (`resolve`/`clarify`) | **punt — by design.** Two-variant union narrowing. |
| `email-curation.ts` | 747, 1322, 1368, 1375 | Email curation effect kinds | **punt — by design.** Discriminated union of policy effects; same pattern as engine cadence dispatch. |
| `relative-schedule-resolver.ts` | 101 | Schedule kind `during_morning` | **punt.** Already documented (HARDCODING_AUDIT §5.4) as anchor-registry candidate; risky planner-sensitive change. |
| `engine.ts` | 34, 37, 44, 47, 50, 87, 437, 464, 504, 537 | Cadence kind dispatch (`once`/`weekly`/`times_per_day`/`interval`/...) | **punt — by design.** Core engine semantics. Each branch has deeply different behavior; a registry would scatter cadence logic across ~10 files. |
| `enforcement-windows.ts` | 70, 103, 120 | Window `kind === "none"` early-out | **punt — by design.** Two-variant union (`none` vs everything else); not a scenario lock. |
| `service-normalize-task.ts` | 142–303, 613 | Workflow step kinds + browser-task validation | **punt.** Workflow step kinds are a registry candidate (HARDCODING_AUDIT §5.4 / §6 #14); risky. |
| `service-normalize-connector.ts` | 183–259 | Connector schedule kind dispatch (`once`/`interval`/`relative_to_*`/`during_*`) | **punt.** Anchor-registry candidate. |
| `service-helpers-reminder.ts` | 486 | `state.window.kind === "none"` | **punt — by design.** Single early-out; not a scenario switch. |
| `service-mixin-workflows.ts` | 272–353, 850–915 | Workflow schedule + step dispatch | **punt.** Largest registry candidate (9 step kinds). High-risk; requires planner re-training. |
| `scheduled-task/runner.ts` | 356, 797, 807 | Gate decision `kind === "allow"`/`deny`/`defer` | **punt — by design.** Three-variant decision union narrowing. |
| `handoff/store.ts` | 56 | `cand.kind === "mention"` | **punt — by design.** Two-variant union narrowing. |

### Severity: `magic_number` — 5 finds, all fixed

| File | Line | Original literal | New named constant |
|---|---|---|---|
| `service-mixin-reminders.ts` | 3984 | `setTimeout(r, 2_000)` | `REMINDER_DELIVERY_RETRY_DELAY_MS = 2_000` |
| `notifications-push.ts` | 104, 113 | `timeoutMs: 10_000` / `AbortSignal.timeout(10_000)` (×2) | `NTFY_PUBLISH_TIMEOUT_MS = 10_000` |
| `service-mixin-goals.ts` | 473 | `2 * 24 * 60 * 60 * 1000` | `GOAL_STALE_DAYS_FREQUENT * ONE_DAY_MS` |
| `service-mixin-goals.ts` | 475 | `10 * 24 * 60 * 60 * 1000` | `GOAL_STALE_DAYS_WEEKLY * ONE_DAY_MS` |
| `service-mixin-goals.ts` | 476 | `7 * 24 * 60 * 60 * 1000` | `GOAL_STALE_DAYS_DEFAULT * ONE_DAY_MS` |

All other naked-ms literals encountered (in `service-mixin-relationships.ts`, `service-helpers-occurrence.ts`, `relative-time.ts`, `scheduled-task/runner.ts`, `checkin-service.ts`, `relationships/store.ts`, etc.) are either already bound to file-local named constants (e.g. `CONTINUITY_LOOKBACK_MS`, `ACK_WINDOW_MS`, `LIFEOPS_TASK_INTERVAL_MS`) or are inline arithmetic where naming would obscure the calculation (e.g. `Math.floor(diffMs / (24 * 60 * 60 * 1000))` for "ms-to-days" conversion).

### Severity: `locale_lock` — 0 finds in scope

The `i18n/prompt-registry.ts` and `MultilingualPromptRegistry` infrastructure is in scope but already correctly designed: 4-locale registry with explicit `PromptLocale = "en" | "es" | "fr" | "ja"`, registered example pairs keyed by `exampleKey`, no English-only branch. No locale-lock smells observed in the in-scope files. (HARDCODING_AUDIT identified hardcoded Spanish in `actions/life.ts:3509-3517`, but that file is owned by Agent 21.)

### Severity: `test_branch` — 1 find, punted

| File | Line | Branch | Disposition |
|---|---|---|---|
| `repository.ts` | 2414 | `verbose: process.env.NODE_ENV !== "production"` | **punt — by design.** This is a sql-builder verbose-logging toggle, not a runtime behavior carve-out. The `NODE_ENV !== "production"` axis is a legitimate prod-vs-non-prod log-noise switch. |

No `process.env.NODE_ENV === "test"` branches found in the in-scope files (the audit specifically called out test-shaped hacks; none present).

### Severity: `enum_lock` — 1 find, punted

| File | Line | Enumeration | Disposition |
|---|---|---|---|
| `feature-flags.types.ts` | 194 | `ALL_FEATURE_KEYS = Object.keys(BASE_FEATURE_DEFAULTS)` (closed `LifeOpsFeatureKey` literal union) | **punt.** Documented as `FeatureFlagRegistry` candidate (HARDCODING_AUDIT §5.6). Adding a new feature requires editing the closed union. Refactor is medium-risk — touches the gate API used by every feature-gated action. Out of scope for safe sweep. |

Other `Object.keys(...)` uses in scope are over runtime data (incoming records, headers, attributes), not over closed source-code enumerations. Not rigidity smells.

### Severity: `fallback_shim` — 4 finds, punted (all by design or already-documented)

| File | Line | Pattern | Disposition |
|---|---|---|---|
| `notifications-push.ts` | 33 | `defaultTopic ?? "eliza"` | **punt — by design.** `NTFY_DEFAULT_TOPIC` is optional; falling back to `"eliza"` is documented behavior, not a hidden failure mode. Pattern: env-with-default for non-load-bearing config. |
| `engine.ts` | 35, 38, 40, 45, 48, 55 | `cadence.visibilityLeadMinutes ?? 15` / `?? 6 * 60` / `?? 0` etc. | **punt — by design.** These are cadence-kind-dependent visibility-window defaults at the primitive level. Each branch's default reflects the cadence semantics (once: 15 min lead, 6 h lag; times_per_day: 4 h lag; interval: min(everyMinutes, 4h)). Not fallback shims; they're the canonical defaults for under-specified cadences. |
| `service-helpers-misc.ts` | 300 | `request.minutes ?? 30` | **punt — by design.** Snooze-default of 30 minutes when caller omits `minutes`. Tightly scoped to one helper. |
| `relative-schedule-resolver.ts` | 105 | `?? 120` (window-minutes-before-sleep-target) | **punt — by design.** Single anchor-resolver default. |

No `?? "https://..."` fallback shims found. The Twilio + Duffel patterns (`?? "https://api.twilio.com"`, `|| DUFFEL_API_BASE_DEFAULT`) are env-with-default for vendor URLs, which is the correct pattern.

---

## Top 3 Punted Items (ranked by impact)

1. **`enum_lock` — `LifeOpsFeatureKey` closed union + `BASE_FEATURE_DEFAULTS`** (`feature-flags.types.ts:33-43, 71-194`). Severity: high. Adding any new feature toggle requires editing the source-code union. The agent cannot extend its own feature surface without a code change. Documented as `FeatureFlagRegistry` candidate in HARDCODING_AUDIT §5.6. Punted because the refactor touches every feature-gated action's gate-call sites; planner-sensitive. **Recommendation: prioritize next sweep.**

2. **`scenario_switch` — workflow step dispatch in `service-mixin-workflows.ts:850–915`** (9 hardcoded `step.kind` branches: `create_task`, `relock_website_access`, `resolve_website_access_callback`, `get_calendar_feed`, `get_gmail_triage`, `get_gmail_unresponded`, `get_health_summary`, `dispatch_workflow`, `summarize`). Severity: high. The set of workflow primitives is locked to whatever this dispatcher knows. The matching closed union lives in `service-normalize-task.ts:205-303` and the contract enum in `packages/shared/src/contracts/`. Documented as registry candidate (HARDCODING_AUDIT §5.4 / §6 #14). Punted because the refactor requires three-file coordination and planner re-training.

3. **`hardcoded_url` + `scenario_switch` — health-connector OAuth + base URL switches** (`plugin-health/src/health-bridge/health-oauth.ts:146-200`, `health-connectors.ts:180-189`). Severity: medium. Strava / Fitbit / Withings / Oura URLs are baked into per-provider switch arms. Adding a fifth provider requires editing both files. Documented as part of the broader connector-registry candidate (HARDCODING_AUDIT §5.1). Punted because the connector registry is a coordinated cross-package change owned by Agent 23 / future cycle.

---

## Files modified

- `plugins/app-lifeops/src/lifeops/service-mixin-reminders.ts` — added `REMINDER_DELIVERY_RETRY_DELAY_MS` constant; replaced `setTimeout(r, 2_000)` magic literal with the constant.
- `plugins/app-lifeops/src/lifeops/notifications-push.ts` — added `NTFY_PUBLISH_TIMEOUT_MS` constant; replaced two `10_000` magic literals (telemetry span timeoutMs + fetch AbortSignal timeout) with the constant.
- `plugins/app-lifeops/src/lifeops/service-mixin-goals.ts` — added `ONE_DAY_MS` + `GOAL_STALE_DAYS_FREQUENT` / `GOAL_STALE_DAYS_WEEKLY` / `GOAL_STALE_DAYS_DEFAULT` constants; replaced three naked `N * 24 * 60 * 60 * 1000` ms literals with the named constants.

## Verification

- `bun --cwd plugins/app-lifeops test` — 411/411 pass.
- `bun --cwd plugins/plugin-health test` — 10/10 pass.
- `journey-domain-coverage` — 40/40 pass.
- `npx tsc -p tsconfig.build.json --noEmit` (in `plugins/app-lifeops`) — clean.
- `biome check` on edited files — pre-existing import-sort warning in `service-mixin-reminders.ts` (unchanged from baseline; not introduced by this sweep).

*End of audit. This document does not modify code beyond the five magic-number renames listed above.*
