# W4-IK — Scenario Typecheck Cleanup + Mockoon faultInjection Wiring

Sub-agent W4-IK (retry). Branch: `develop`. No push.

## Task I — Scenario Typecheck Cleanup

### Before / After Counts

Errors emitted by `bunx tsc --noEmit -p test/scenarios/tsconfig.json` that originate **inside `test/scenarios/`** (excluding upstream package errors that the scoped tsconfig surfaces transitively):

| State  | `test/scenarios/` errors |
|--------|--------------------------|
| Before | 3                        |
| After  | 0                        |

The mission brief described "~29 remaining errors" focused on 8 calendar null/string errors in three W2-1 scenario files plus 3 helper coercion errors in `_helpers/lifeops-seeds.ts`. Inspection showed those were already fixed: the three calendar scenarios already use `description: ""` / `location: ""` empty-string literals, and `_helpers/lifeops-seeds.ts` already uses `event.description ?? ""` / `event.location ?? ""` fallbacks when forwarding to `repository.upsertCalendarEvent`. No additional widening was needed.

### Actual Errors Fixed

1. `test/scenarios/lifeops.documents/documents.ocr-fail.scenario.ts:155` — `contentType: "application/pdf"` is not a member of the `ContentType` union (`"image" | "video" | "audio" | "document" | "link"`). Changed to `contentType: "document"`. PDF is a document; the field is a coarse content-class enum, not a MIME type.
2. `test/scenarios/lifeops.planner/planner.action-timeout.scenario.ts:69,75` — `AgentRuntime` referenced in `asRuntime(...)` helper but missing from the `@elizaos/core` type import list. Added `AgentRuntime` to the import.

### Full Typecheck Picture (Context, Not in Scope)

The scoped `test/scenarios/tsconfig.json` surfaces 446 total errors when run with its include patterns. The vast majority (~440) originate in:

- `packages/core/src/__tests__/**` — bad `as`-casts against `IAgentRuntime` (many `Mock` types being cast to `{ mock: { calls: unknown[][] } }`, mock runtime literals cast to `IAgentRuntime` without enough overlap, `ContextRegistry` no longer exported).
- `packages/app-core/test/helpers/**` — TS6307 "file not listed" errors because the tsconfig include array misses adjacent helper files (action-spy.ts, live-provider.ts, trajectory-harness.ts, conditional-tests.ts, live-agent-test.ts, conversation-harness.ts referenced from app-lifeops).
- `plugins/app-lifeops/src/components/**.tsx` — TS6307: the include array has `plugins/app-lifeops/src/**/*.ts` but no `*.tsx` pattern.
- `packages/agent/src/runtime/aosp-dflash-adapter.ts` — broken `never` narrowing (real bug, not scope).
- `packages/app-core/src/services/local-inference/voice/*.test.ts` — interface drift: `ElizaInferenceFfi` gained `vad*` methods, test doubles missing them.
- `packages/app-core/src/benchmark/lifeops-bench-handler.ts:188-346` — request body types not assignable to `Record<string, unknown>` (a real index-signature mismatch, not a test bug).

These are explicitly **out of scope** for W4-IK per the task brief: "DO NOT touch action handlers", "DO NOT touch scorer/bench server/adapters/judge", "DO NOT touch personality scenarios or actions", "DO NOT touch lifeops scenarios beyond the 3 calendar files". They are documented as Wave-5 followups below.

### tsconfig include misses

`test/scenarios/tsconfig.json` does not include `*.tsx` files even though it pulls `plugins/app-lifeops/src/**/*.ts` (which transitively imports `.tsx` UI). Suggested addition:

```jsonc
"include": [
  // ...existing entries...
  "../../plugins/app-lifeops/src/**/*.tsx",
  "../../packages/app-core/test/helpers/**/*.ts"
]
```

Not applied here because the typecheck noise from those files (TS6307 transitive `.tsx` resolution + `IAgentRuntime` cast issues in helpers) is the W4-IK scope-out boundary; adding the include would surface 80+ additional errors that other agents own.

## Task K — Mockoon faultInjection Wiring + seedCanonicalIdentityFixture Extension

### K.1 — faultInjection Forwarding: Wave-5 Followup

The scenarios at:

- `test/scenarios/lifeops.gmail/gmail.rate-limit-backoff.scenario.ts`
- `test/scenarios/lifeops.gmail/gmail.partial-failure-50-of-100-modified.scenario.ts`
- `test/scenarios/lifeops.inbox-triage/inbox-triage.token-expiry-mid-fetch.scenario.ts`
- `test/scenarios/lifeops.inbox-triage/inbox-triage.gmail-5xx-mid-fetch.scenario.ts`

declare `faultInjection: { mode: "rate_limit", method: "GET" }` on `gmailInbox` seed steps. The receiving type in `packages/scenario-runner/src/seeds.ts` (`GmailInboxSeed`) has no `faultInjection` member, and `seedGmailInbox` does not forward anything. The fault declaration is currently a no-op.

The Mockoon environments **do** honor faults via two routes per response rule:

- header rule `X-Mockoon-Fault: <mode>` (preferred for in-flight injection)
- query rule `_fault=<mode>` (preferred for sticky/server-side injection)

Verified in `test/mocks/mockoon/signal.json`, `test/mocks/mockoon/anthropic.json`, and (per W1-4b verification, referenced in mission brief) every other Mockoon env.

**Why this is a Wave-5 followup and not a W4-IK fix:**

Wiring the fault requires choosing one of two paths, both of which cross W4-IK scope-out lines:

1. **Per-request header forwarding** — requires modifying the Google API client's `fetch` wrapper to inspect a runtime-scoped fault state and inject `X-Mockoon-Fault` on every outbound request. That client lives in `packages/scenario-runner` or further in the gmail connector (an adapter — explicitly out of scope: "DO NOT touch ... adapters").
2. **Sticky server-side fault** — requires adding a `/__mock/fault` admin endpoint in `test/mocks/scripts/start-mocks.ts` that stores a per-env fault mode and a corresponding Mockoon rule that reads it. This requires modifying the mock bench server (out of scope: "DO NOT touch scorer/bench server").

The clean wiring (recommended for Wave-5):

```ts
// In packages/scenario-runner/src/seeds.ts
type GmailInboxSeed = {
  type: "gmailInbox";
  account?: unknown;
  fixture?: unknown;
  fixtures?: unknown;
  requiredMessageIds?: unknown;
  clearLedger?: unknown;
  faultInjection?: { mode: string; method?: string }; // ADD
};

async function seedGmailInbox(seed: GmailInboxSeed): Promise<string | undefined> {
  // ... existing logic ...
  const fault = readFaultInjection(seed.faultInjection);
  if (fault) {
    // POST to a new admin endpoint exposed by start-mocks.ts that stores
    // sticky fault state per Mockoon env. Mock servers' existing response
    // rules already match against X-Mockoon-Fault; the start-mocks.ts
    // proxy layer needs to inject that header on inbound requests when
    // sticky fault is set.
    await fetch(`${mockBaseUrl}/__mock/fault`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: fault.mode, method: fault.method ?? "*" }),
    });
  }
  return undefined;
}
```

This requires two changes (both outside W4-IK scope):
- `start-mocks.ts`: add `/__mock/fault` POST handler and request-time `X-Mockoon-Fault` injection.
- `seeds.ts`: extend type + invoke admin endpoint.

### K.2 — `seedCanonicalIdentityFixture` Extension (applied)

Extended `plugins/app-lifeops/test/helpers/lifeops-identity-merge-fixtures.ts` to:

1. **Add Discord** to `CANONICAL_IDENTITY_PLATFORMS` and `PLATFORM_FIXTURES`. The Discord fixture seeds handle `priyarao#4242` and a thematic inbound/outbound exchange.
2. **Add `priorNames` parameter and field.** The fixture now accepts `priorNames?: readonly string[]` and writes them into the entity's `names` array (after the canonical `personName`), so consumers can model "Priya Rao → Priya Smith" rename scenarios against the same canonical entity.
3. The fixture return type gains a `priorNames: string[]` field reflecting the seeded history.

`ensureEntity` was updated to take an optional `priorNames` array and merge it into the `names` field at entity creation time. Existing callers continue to pass no `priorNames` and get unchanged behavior.

**Knock-on effects:**

- `acceptCanonicalIdentityMerge` and `assertCanonicalIdentityMerged` default to `CANONICAL_IDENTITY_PLATFORMS` for their loops. With Discord added, scenarios using the default now seed and assert across **five** platforms (gmail, signal, telegram, whatsapp, discord) instead of four. This is actually a fix for `lifeops.cross-channel/cross-channel.same-person-4-platforms.scenario.ts`, which prompts the agent for "Gmail, Signal, Telegram, Discord" but previously seeded whatsapp instead of discord — the assertion will now match the prompt.
- Scenarios that pass an explicit `expectedPlatforms` to `assertCanonicalIdentityMerged` are unaffected.
- `cross-channel.identity-rename-survives.scenario.ts` does not yet pass `priorNames`. The hook is now available; adding `priorNames: ["Priya Rao"]` to that scenario's call (with `personName: "Priya Smith"`) is a follow-up the scenario author can apply when actually exercising the rename flow.

### Test fixture diff summary

```diff
- export const CANONICAL_IDENTITY_PLATFORMS = ["gmail", "signal", "telegram", "whatsapp"] as const;
+ export const CANONICAL_IDENTITY_PLATFORMS = ["gmail", "signal", "telegram", "whatsapp", "discord"] as const;

+ priorNames: string[];   // on SeededCanonicalIdentityFixture
+ priorNames?: readonly string[];   // on seedCanonicalIdentityFixture args
+ priorNames: readonly string[] = []   // on ensureEntity
+ PLATFORM_FIXTURES.discord = { handle: "priyarao#4242", ... }
```

## Wave-5 Followups

1. **`faultInjection` admin wiring** (K.1). Two-file change in `start-mocks.ts` + `packages/scenario-runner/src/seeds.ts`. Owner: a `W5-mocks` agent that has scope to touch the bench mock server. Scenarios already exist that expect the wiring; until then they exercise the non-fault path silently.
2. **`packages/core/src/__tests__/` cast cleanups.** ~30+ files use `{ ... } as IAgentRuntime` against mock literals that lack enough overlap. The correct fix is `as unknown as IAgentRuntime` *with comment justifying the test-double boundary*, OR introducing a proper `createMockRuntime()` helper. Owner: `W5-core-test-mocks`.
3. **`ContextRegistry` re-export.** `packages/core/src/__tests__/planner-happy-path.test.ts:14` and `packages/core/src/__tests__/stress-compaction.test.ts:22` import `ContextRegistry` from `"../types/contexts"` but the export was removed. Either re-export it or update the tests to import from `../runtime/context-registry`.
4. **`ProviderCacheEntry.providerName`.** `packages/core/src/__tests__/message-runtime-stage1.test.ts:205-214` and `stress-compaction.test.ts:70-74` write `providerName` into `ProviderCacheEntry` literals; the type no longer accepts that field. Pick: either re-add `providerName` to the type (if planner caches need it) or drop the field from the test setup.
5. **`ElizaInferenceFfi` test-double gap.** Three voice tests (`engine.voice.test.ts:166`, `pipeline-impls.test.ts:51`, `transcriber.test.ts:435`) provide test doubles missing the new VAD methods. Either add no-op `vadSupported/vadOpen/vadProcess/vadReset/vadClose` to the test doubles or expose a `createMockInferenceFfi()` helper.
6. **`aosp-dflash-adapter.ts:289` `never` narrowing.** `code` and `signal` accessed on a `never` type — real bug in the adapter.
7. **`lifeops-bench-handler.ts:188-346` request body coercion.** Three handler types (`ResetBody`, `MessageBody`, `TeardownBody`) are not assignable to `Record<string, unknown>` due to optional/required field shape. Either index-signature the body types or accept `unknown` and validate inside.
8. **`should-respond.live.test.ts:129` readonly tuple.** `as const` schema rows can't be assigned to mutable `SchemaRow[]`. Either type the call site as `readonly SchemaRow[]` or drop the `as const`.
9. **`streaming-runtime-hooks.test.ts`** — `Mock<() => number>` assigned to event handlers typed `(payload) => MaybePromise<void>` and `IAgentRuntime` used where `PlannerRuntime` is required (5 sites). The PlannerRuntime supertype set needs the runtime fixture extended.
10. **tsconfig include misses** for `*.tsx` and a half-dozen test helpers. Documented in Task I above; defer to a `W5-tsconfig` pass that also re-runs the full typecheck so it can confirm the actual surface.

## Verification

```bash
bunx tsc --noEmit -p test/scenarios/tsconfig.json 2>&1 | grep "error TS" | grep "^test/scenarios"
# (empty — 0 errors from inside test/scenarios)
```

The full 446-error scoped typecheck output is the residual surface for Wave-5 owners listed above.

## Files Touched

- `test/scenarios/lifeops.documents/documents.ocr-fail.scenario.ts` (1 line — `contentType`)
- `test/scenarios/lifeops.planner/planner.action-timeout.scenario.ts` (1 line — import)
- `plugins/app-lifeops/test/helpers/lifeops-identity-merge-fixtures.ts` (Discord platform + priorNames hook)
- `docs/audits/lifeops-2026-05-11/scenario-cleanup-typecheck-faultinjection.md` (this file)
