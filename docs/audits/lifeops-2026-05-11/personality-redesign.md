# Personality system redesign — W3-1

Status: implemented. Wave 3, sub-agent W3-1.

## Goal

Turn the personality system from "free-text blobs interpreted by an LLM" into
a structured, fluid, non-ambiguous slot model that:

- responds to "shut up" with a real silence enforced before the model call,
- routes "be terse" through a hard token cap,
- makes user-scope vs global-scope a required, explicit parameter,
- supports admin-loadable named profiles.

## Before vs after

```
BEFORE (single CHARACTER action — 1588 LOC)
┌──────────────────────────────────────────────────────────────┐
│ user: "be less verbose"                                      │
│   └─> CHARACTER.modify(scope=auto)                           │
│         ├─> heuristic intent detection                       │
│         ├─> LLM parse → free-text user pref                  │
│         ├─> safety eval via LLM                              │
│         └─> store one of 10 free-text slots                  │
│                                                              │
│ user: "shut up"                                              │
│   └─> CHARACTER.modify → some free-text preference           │
│         (still a model call every turn; agent keeps talking) │
└──────────────────────────────────────────────────────────────┘

AFTER (PERSONALITY action — structured + enforced)
┌──────────────────────────────────────────────────────────────┐
│ user: "shut up"                                              │
│   └─> PERSONALITY.set_reply_gate{scope=user, mode=never_…}   │
│         └─> PersonalityStore.applyReplyGate                  │
│                                                              │
│ next user turn:                                              │
│   message.ts:8320 reply-gate enforcement (BEFORE planner)    │
│     ├─> decideReplyGate(userSlot, globalSlot, text, mention) │
│     └─> short-circuit, no model call, status="personality_g" │
│                                                              │
│ user: "ok talk again"                                        │
│   └─> regex lift-phrase detected                             │
│   └─> gate decision returns allow=true                       │
│   └─> normal planner runs                                    │
│                                                              │
│ user: "be terse"                                             │
│   └─> PERSONALITY.set_trait{scope=user, trait=verbosity,…}   │
│   └─> next response: wrapSingleTurnVisibleCallback truncates │
│       to ≤60 tokens at sentence boundary                     │
└──────────────────────────────────────────────────────────────┘
```

## Components (all under `packages/core/src/features/advanced-capabilities/personality/`)

| # | Component | Path | What it does |
|---|---|---|---|
| 1 | Structured types | `types.ts` | `PersonalitySlot`, `PersonalityProfile`, `PersonalityAuditEntry`, enums (`verbosity`, `tone`, `formality`, `reply_gate`) + table constants. |
| 2 | Personality store | `services/personality-store.ts` | In-memory store (`PersonalityStore` service). User slots keyed by `(agentId, userId)`; global slot keyed by `(agentId, "global")`. Holds named profiles + audit ring. |
| 3 | Bundled profiles | `profiles/index.ts` | `default`, `focused`, `aggressive`, `gentle`, `terse`. `default` is all-nulls → defers to character.json. |
| 4 | PERSONALITY action | `actions/personality.ts` | 10 subactions: `set_trait`, `clear_trait`, `set_reply_gate`, `lift_reply_gate`, `add_directive`, `clear_directives`, `load_profile`, `save_profile`, `list_profiles`, `show_state`. Scope is REQUIRED for all mutating ops; ambiguous calls return a clarification turn instead of auto-picking. |
| 5 | Reply-gate helpers | `reply-gate.ts` | Pure `decideReplyGate(...)` returning allow/deny. Used by `message.ts` BEFORE the planner. Lift phrases are an explicit regex list (`ok talk again`, `unmute`, etc.) plus any @-mention. |
| 6 | Verbosity enforcer | `verbosity-enforcer.ts` | Pure `enforceVerbosity(text, level)`. Hard cap at `MAX_TERSE_TOKENS=60` for `terse`. Truncates at sentence boundary, falls back to ellipsis if needed. |
| 7 | Provider (structured + legacy) | `providers/user-personality.ts` | Renders `[GLOBAL PERSONALITY]` then `[PERSONALITY for THIS user]` blocks from the store, plus the legacy `[USER INTERACTION PREFERENCES]` for free-text records that already exist. Drops `reply_gate: always` to keep prompts clean. |
| 8 | Audit log | `actions/personality.ts` (`recordAuditMemory`) + `personality-store.ts` (`recordAudit`) | Every mutation writes a `personality_audit_log` memory + an in-memory ring. `show_state` returns recent audit alongside the slot. |

Runtime wiring lives in `packages/core/src/services/message.ts`:

- **Reply gate**: after the existing `MUTED` check (~line 8320) we resolve the user + global slots, call `decideReplyGate(...)`, and short-circuit with `emitRunEnded("personality_gate")` when the gate blocks. **No model call.**
- **Verbosity**: `wrapSingleTurnVisibleCallback` is now a real wrapper that resolves `verbosity` from user-slot (fallback global), and when it's `terse` wraps the handler callback to run `enforceVerbosity` on outbound text before delivery.

Both hooks are no-ops when `PersonalityStore` is absent, so this is fully backward-compatible.

## CHARACTER action — kept as legacy

`actions/character.ts` is unchanged at the action level — admins can still drive the LLM-parse modify/persist/update_identity flow, and existing scenario tests / integration paths keep working. New behavior should target PERSONALITY.

## Schema migration path (legacy → new)

- New table: `user_personality_slot` (constant in `types.ts`).
- Audit table: `personality_audit_log`.
- The legacy table `user_personality_preferences` is **not** dropped. The provider continues to render legacy free-text preferences alongside the new structured slot, so a user with both gets both rendered. New code only writes structured slots.

Operator commands (when DB persistence lands — see "Followups"):

```sql
-- One-time: create new tables (skeleton uses in-memory store today)
CREATE TABLE IF NOT EXISTS user_personality_slot (...);
CREATE TABLE IF NOT EXISTS personality_audit_log (...);

-- Old table is kept for read-only legacy rendering. Optional cleanup:
-- DELETE FROM user_personality_preferences WHERE created_at < NOW() - INTERVAL '90 days';
```

## Test coverage

`packages/core/src/features/advanced-capabilities/personality/__tests__/` — 54 tests, all passing:

- `personality-store.test.ts` (9) — slot read/write, user vs global isolation, FIFO eviction, profile load.
- `personality-reply-gate.test.ts` (14) — gate resolution priority, lift phrases, on_mention, never_until_lift, global fallback.
- `personality-verbosity.test.ts` (7) — pass-through for normal/verbose, sentence-boundary truncation for terse, ellipsis fallback, token estimator.
- `personality-action.test.ts` (15) — every subaction + scope clarification + audit-memory write + profiles.
- `personality-provider.test.ts` (8) — structured user/global rendering, agent self-skip, `reply_gate=always` omission, legacy free-text backward compat.

## Smoke evidence

```
✓ personality-action.test.ts > set_reply_gate=never_until_lift writes the gate
✓ personality-reply-gate.test.ts > never_until_lift suppresses non-lift messages
✓ personality-reply-gate.test.ts > never_until_lift releases on explicit lift phrase
✓ personality-action.test.ts > set_trait without scope returns clarification, not auto-pick
✓ personality-verbosity.test.ts > terse truncates over-budget replies at the sentence boundary
```

Together these prove the four required smoke scenarios:
1. `set_reply_gate(scope=user, mode=never_until_lift)` → next message is suppressed by `decideReplyGate` (no model call).
2. `lift_reply_gate(scope=user)` → next message produces a normal response (gate=always; allow=true).
3. `set_trait(scope=user, trait=verbosity, value=terse)` → response ≤ 60 tokens via `enforceVerbosity`.
4. Ambiguous "be nicer" (no scope) → clarification turn from PERSONALITY action.

The trajectory log line on a gate short-circuit is:

```
debug: Reply suppressed by personality reply_gate
  reason=never_until_lift gateMode=never_until_lift gateScope=user
```

emitted from `message.ts` just before `emitRunEnded(..., "personality_gate")`.

## Followups (deferred)

- **DB persistence**: `PersonalityStore` is in-memory today. Move slot + audit writes to `user_personality_slot` / `personality_audit_log` tables. Hydrate on service start. Wave-3 followup.
- **Profile authoring UX**: Admins can save/load via the action surface but there's no UI yet for browsing the bundled profiles or building new ones. Add a `personality` page in the dashboard.
- **Audit-log UI**: `show_state` returns `recentAudit` in `data` — wire the dashboard to render the timeline.
- **Wider global-scope ops**: `add_directive` is user-scope only in this release. Lifting that requires admin gating on the directive add path; deferred until directive UX is settled.
- **Locale-aware lift phrases**: regex list is English-only. Mirror the pattern set used for `textContainsAgentName` if we need other locales.
