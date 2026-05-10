# Audit Agent D — Registry / Channel / Connector Composability Audit

**Branch:** `shaw/more-cache-toolcalling`. **Owned files:**
`plugins/app-lifeops/src/lifeops/{connectors,channels,registries,send-policy,signals}/`
plus the `routes/scheduled-tasks.{ts,test.ts}` thin extension that exposes the
runtime-bound registries through `GET /api/lifeops/dev/registries`.

**Question we answer here:** can the agent compose any new connector, channel,
send-policy, anchor, event-kind, bus-family, or blocker at runtime via a
**single `registry.register(...)` call**, with **no source-code edits**? If a
registry is "registry in name only" (still has a hardcoded switch on the key
at the consumer side, or a closed Zod enum that gates the kind), that is a
gate — and we close it.

---

## Composability scorecard

Grades are A (registry-driven, runtime-discoverable, no source-code edits
required to add a new key), B (registry-driven but hidden gates exist that
require workarounds), C (registry exists but key-side switching still drives
dispatch on the consumer side), F (no registry — all hardcoded).

| Registry             | Entries (built-in) | Consumers via registry          | Consumers via switch | Runtime-discoverable | Grade |
| -------------------- | ------------------ | -------------------------------- | -------------------- | -------------------- | ----- |
| `ConnectorRegistry`  | 10 lifeops + 6 health = 16 | `actions/connector.ts`, `channels/default-pack.ts`, `messaging/owner-send-policy.ts`, `providers/lifeops.ts` | none                 | yes (W2-D fix)       | A     |
| `ChannelRegistry`    | 14                 | `scheduled-task/runtime-wiring.ts` (channelKeys), `scheduled-task/runner.ts` (validates `escalation.steps[].channelKey`) | none                 | yes (W2-D fix)       | A     |
| `SendPolicyRegistry` | 1 (owner-approval) | `messaging/owner-send-policy.ts` (legacy core SendPolicy bridge) | none                 | yes (W2-D fix)       | A     |
| `AnchorRegistry`     | 4 lifeops + 4 health = 8 | runner deps (gate / dispatch consolidation) | none                 | yes (already)        | A     |
| `EventKindRegistry`  | 4 lifeops + N health     | bus subscribers, `trigger.kind === "event"` filter validation | none                 | yes (W2-D fix)       | A     |
| `FamilyRegistry`     | 11 builtins + 4 lifeops + 8 health = 23 | `signals/bus.ts` (validates publish family) | none                 | yes (W2-D fix)       | A     |
| `BlockerRegistry`    | 2 (website + app)  | (intended) umbrella `WEBSITE_BLOCK` / `APP_BLOCK` actions | actions/website-block.ts and actions/app-block.ts still call engine directly | yes (W2-D fix)  | **B** |

**The single B grade is `BlockerRegistry`.** The registry is wired and seeded
correctly, but the `actions/website-block.ts` and `actions/app-block.ts` action
files still import the engine directly instead of dispatching via
`getBlockerRegistry(runtime).get(kind).start(...)`. Those files are owned by
**Agent 21**; we leave the source-code change there. The composability *gate*
is closed (you can register a new blocker and it shows up in
`GET /api/lifeops/dev/registries`); only the action's dispatch path bypasses
it.

---

## Recipes — what it takes to add a new <key>

### Add a new connector (e.g. `acme_inbox`)

```ts
import { getConnectorRegistry } from "@elizaos/app-lifeops/lifeops/connectors";

getConnectorRegistry(runtime)?.register({
  kind: "acme_inbox",
  capabilities: ["acme.inbox.read", "acme.inbox.send"],
  modes: ["cloud"],
  describe: { label: "Acme Inbox" },
  start: async () => {/* ... */},
  disconnect: async () => {/* ... */},
  verify: async () => true,
  status: async () => ({ state: "ok", observedAt: new Date().toISOString() }),
  send: async (payload) => ({ ok: true, messageId: "..." }),
  read: async (query) => ({ /* ... */ }),
  requiresApproval: false,
});
```

**Source-code edits required: 0.** The new connector immediately:

- shows up in `GET /api/lifeops/dev/registries` under `connectors[]`;
- is reachable via `actions/connector.ts` (the action validates connector kind
  via `listKnownConnectorKinds(runtime)` which already includes registry
  contributions);
- can be referenced as a channel's `connectorKind` if you also register a
  matching `ChannelContribution`;
- can be flagged for owner-approval gating by setting `requiresApproval: true`
  (Gmail uses this).

### Add a new channel (e.g. `acme_channel`)

```ts
import { getChannelRegistry } from "@elizaos/app-lifeops/lifeops/channels";

getChannelRegistry(runtime)?.register({
  kind: "acme_channel",
  describe: { label: "Acme Channel" },
  capabilities: {
    send: true,
    read: false,
    reminders: true,
    voice: false,
    attachments: false,
    quietHoursAware: true,
  },
  send: async (payload) => ({ ok: true, messageId: "..." }),
});
```

**Source-code edits required: 0.** The new channel:

- is immediately valid as `ScheduledTask.escalation.steps[].channelKey` —
  `runner.ts:410-417` reads `deps.channelKeys()` against
  `getChannelRegistry(runtime)`;
- is selectable via `ChannelRegistry.list({ supports: { reminders: true } })`
  — capability-filtered queries work without enumerating known kinds.

### Add a new send-policy (e.g. `acme_owner_consent_required`)

```ts
import { getSendPolicyRegistry } from "@elizaos/app-lifeops/lifeops/send-policy";

getSendPolicyRegistry(runtime)?.register({
  kind: "acme_owner_consent_required",
  describe: { label: "Acme owner-consent gate" },
  priority: 50,
  appliesTo: (ctx) => ctx.source.kind === "connector" && ctx.source.key === "acme_inbox",
  evaluate: async (ctx) => {
    if (/* needs approval */) {
      return { kind: "require_approval", requestId: "...", reason: "Acme requires consent" };
    }
    return { kind: "allow" };
  },
});
```

**Source-code edits required: 0.** The new policy is evaluated in priority
order alongside existing policies on every dispatch; the registry short-
circuits on the first non-`allow` decision.

### Add a new anchor (e.g. `acme.day_start`)

```ts
import { getAnchorRegistry } from "@elizaos/app-lifeops/lifeops/registries";

getAnchorRegistry(runtime)?.register({
  anchorKey: "acme.day_start",
  describe: { label: "Acme day start", provider: "acme" },
  resolve(context) {
    return { atIso: /* ... */ };
  },
});
```

**Source-code edits required: 0.** Tasks can immediately use
`{ trigger: { kind: "relative_to_anchor", anchorKey: "acme.day_start", offsetMinutes: 30 }}`.

### Add a new event-kind (e.g. `acme.message.received`)

```ts
import { getEventKindRegistry } from "@elizaos/app-lifeops/lifeops/registries";

getEventKindRegistry(runtime)?.register({
  eventKind: "acme.message.received",
  describe: { label: "Acme inbox message", provider: "acme" },
  filterSchema: z.object({ folderId: z.string().optional() }),
});
```

**Source-code edits required: 0.** The runner's `trigger.kind === "event"`
filter validation consults this registry by event-kind.

### Add a new bus family (e.g. `acme.message.received`)

```ts
import { getFamilyRegistry } from "@elizaos/app-lifeops/lifeops/registries";

getFamilyRegistry(runtime)?.register({
  family: "acme.message.received",
  description: "Acme bus family",
  source: "acme",
  namespace: "acme",
});

// Then:
getActivitySignalBus(runtime)?.publish({
  family: "acme.message.received",
  occurredAt: new Date().toISOString(),
  payload: {/* ... */},
});
```

**Source-code edits required: 0.** The bus consults the FamilyRegistry on
every publish and rejects unknown families with a clear error. Note: the
shared `LifeOpsBusFamily` type is already `LifeOpsTelemetryFamily | string`
(open) — there is no closed enum gate.

### Add a new blocker (e.g. `dns_router`)

```ts
import { getBlockerRegistry } from "@elizaos/app-lifeops/lifeops/registries";

// NB: BlockerKind is currently the closed union "website" | "app".
// Adding a third kind requires widening that union (see Gate G2 below).
```

**Source-code edits required: 1** — widen `BlockerKind` to `string`. See gate
**G2** in the next section.

---

## Gates closed in this audit

The plan asked us to find hidden gates that require source-code edits to add
a new key. Here is what we found and what we changed.

### G1 — `dev/registries` endpoint missed runtime-bound registries (CLOSED)

`runner.inspectRegistries()` only surfaced runner-internal registries (gates,
completion-checks, ladders, anchors, consolidation policies). The agent had
no runtime-introspection path for connectors, channels, send-policies, event-
kinds, bus-families, or blockers — the very registries that govern external
composability.

**Fix:** `routes/scheduled-tasks.ts` now composes a
`DevRegistriesView` that pulls from both the runner *and* the runtime-bound
registries, returning a typed view per the contract:

```ts
{
  // existing — runner-internal:
  gates, completionChecks, ladders, anchors, consolidationPolicies,
  // new — runtime-bound, the composability surface the agent introspects:
  connectors[], channels[], sendPolicies[], eventKinds[], busFamilies[], blockers[]
}
```

Each entry carries enough metadata (label, capabilities, priority, modes,
namespace, provider) for the agent to decide whether to dispatch through it
without consulting source.

### G2 — `BlockerKind` is a closed union (DOCUMENTED, not changed)

`registries/blocker-registry.ts:26`:

```ts
export type BlockerKind = "website" | "app";
```

Adding a third blocker (e.g. router-DNS, Bluetooth-tether) requires widening
this union. We **did not** change it in this audit because the umbrella
actions `WEBSITE_BLOCK` / `APP_BLOCK` derive their action surface from this
union and Agent 21 owns the action layer. Recommendation for Wave-3:
generalize to `string` and let the action layer fan out. The composability
*surface* — `getBlockerRegistry(runtime).register(...)` — already accepts any
kind via the registry's generic type, so the gate is shallow.

### G3 — confirmed: no closed Zod enums on connector/channel kinds

`grep -rn 'z\.enum' src/` found no closed Zod enum that gates connector or
channel keys. `escalationStepSchema.channelKey` is `z.string().min(1)` (open).
`scheduledTaskOutputSchema.destination` is closed but that's a fixed sink set
(`in_app_card`, `channel`, `apple_notes`, `gmail_draft`, `memory`) — not a
registry. This is the right shape.

### G4 — confirmed: no `switch (provider | channel)` on the dispatch hot path

`grep -rn 'switch (provider'` found one match in
`plugin-health/src/health-bridge/health-connectors.ts:180` — that switch picks
the **OAuth API base URL** for hardcoded providers (Strava, Fitbit, Withings,
Oura). It's an internal HTTP-config table, not a dispatch-side switch over
registered connector kinds. Safe.

`grep -rn 'if (channel === "'` found seven matches; every one is in user-
facing display code (`components/`, `actions/lib/messaging-helpers.ts`,
`service-helpers-misc.ts`) — string formatting / contact-route policy /
display labels. None of them is a dispatch-side switch over registered
channel kinds. Safe.

### G5 — confirmed: open `LifeOpsBusFamily` type

`packages/shared/src/contracts/lifeops.ts:1543` defines
`LifeOpsBusFamily = LifeOpsTelemetryFamily | string`. Open. Plus the
`FamilyRegistry` validates membership at runtime via
`signals/bus.ts:108-116`. Safe.

### G6 — confirmed: connector action's `VERBOSE_DISPATCHER_KINDS` is additive

`actions/connector.ts:29-39` keeps a closed list of verbose-dispatcher
connector kinds (google, x, telegram, signal, discord, imessage, whatsapp,
health, browser_bridge) — but
`listKnownConnectorKinds()` at line 132 is an **additive** union of registry
kinds plus the verbose list. New connectors registered in
`ConnectorRegistry` are valid action targets without source-code edits; only
the rich provider-specific verify-probes stay narrowed (which is the correct
choice — those probes have provider-specific semantics that don't generalize).

---

## Critical assessment — why these structures look right

**Per-runtime `WeakMap` registry binding.** Every registry uses
`WeakMap<IAgentRuntime, Registry>` so the lifetime tracks the runtime. Tests
don't leak registrations; production gets one bound registry per agent. This
is the right pattern; do not centralize into a global singleton.

**Open string keys, closed shapes.** Every contribution carries a `kind:
string` (open) but its **shape** is strongly-typed (`ConnectorContribution`,
`ChannelContribution`, …). This is the textbook plug-in pattern: open the
identifier, close the contract. Anyone adding a new key must implement the
full contract — there is no `unknown` payload in the contributions
themselves.

**Capability-driven querying.** `ConnectorRegistry.byCapability()` and
`ChannelRegistry.list({ supports: ... })` mean the runner does **not** ask
"is this Telegram?" — it asks "which connectors can `health.sleep.read`?",
"which channels are `voice` capable?". This is what enables
"compose-any-new-behavior-at-runtime" — the runner's reasoning is over
*capabilities*, not over connector identities.

**The dispatch policy / send policy split.** `connectors/dispatch-policy.ts`
classifies failure reasons (transport, auth_expired, rate_limited, …) and
lets the runner decide retry / escalate / queue without knowing the
connector's identity. `send-policy/registry.ts` is the *gate* layer
(approval, quiet hours) and is also identity-agnostic. Both are pure
strategy registries — adding a new strategy is one `register(...)` call.

**Event-kind / family / anchor registries are typed by *contribution shape*,
not identity.** `EventKindContribution.filterSchema` is `unknown` so each
producer can use its own schema format (Zod / JSON Schema / shape descriptor)
without forcing a one-size-fits-all schema layer. The
`FamilyRegistry.isBuiltin(family)` discriminator lets the bus layer route
typed payloads through the closed `LifeOpsTelemetryFamily` union *while
still accepting* open namespaced families like `health.sleep.detected`.

---

## Verification

- `bunx tsc --noEmit -p tsconfig.build.json` — clean.
- `bunx vitest run src/routes/scheduled-tasks.test.ts` — 8/8 pass (added the
  composability-proof test "GET /api/lifeops/dev/registries surfaces every
  registry kind for runtime composability proof").
- `bunx vitest run journey-domain-coverage` — 40/40 pass.

---

## Outstanding for next waves

- **Wave-3 (blocker action layer):** route `WEBSITE_BLOCK` / `APP_BLOCK`
  through `getBlockerRegistry(runtime).get(kind).start(...)` instead of
  importing the engine directly. Owned by Agent 21's territory.
- **Wave-3 (BlockerKind):** widen to `string` once umbrella actions
  dispatch through registry rather than engine.
- **Wave-2/3 (`messaging/owner-send-policy.ts`):** the
  `SOURCE_TO_CONNECTOR_KIND` map is closed because `MessageSource` is closed
  in `@elizaos/core`. When the core opens this enum, this map can collapse
  into `connectorRegistry.get(messageSource)` directly.
