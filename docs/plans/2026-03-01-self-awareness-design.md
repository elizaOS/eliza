# Agent Self-Awareness System — Design Document

> **Status:** Approved
> **Date:** 2026-03-01
> **Schema Version:** 1
> **Pattern:** Layered lazy-load + declarative registration

---

## Problem

The Milady agent has full API access to wallet, permissions, plugins, cloud, and connector state — but none of this is injected into the LLM context. The agent cannot perceive its own capabilities unless it explicitly makes API calls. This creates a "fragmented" experience where the UI shows system state but the agent is blind to it.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Token strategy | Layered lazy-load | ~300 tokens always-on summary + on-demand detail |
| Registration model | Declarative | Plugins declare `AwarenessContributor` interface. Zero core code changes for new modules |
| Documentation | CLAUDE.md + contracts | Mirrors the agent's own layered lazy-load pattern for AI-assisted development |

## Architecture: Three-Layer Perception

```
Layer 1: Always-On Summary (~300 tokens)
  Provider: src/providers/self-status.ts
  Composed from AwarenessContributor.summary() via AwarenessRegistry
  Injected into every LLM turn automatically

Layer 2: On-Demand Detail (agent calls GET_SELF_STATUS action)
  Action: src/actions/get-self-status.ts
  Calls AwarenessContributor.detail(level: 'brief' | 'full')
  Supports module: 'all' | specific module ID

Layer 3: Deep Introspection (existing /api/runtime endpoint)
  Only for special debugging scenarios
  Not part of this system
```

## Core Interface: AwarenessContributor

```typescript
// src/contracts/awareness.ts

export const SELF_STATUS_SCHEMA_VERSION = 1;

export type AwarenessInvalidationEvent =
  | 'permission-changed'
  | 'plugin-changed'
  | 'wallet-updated'
  | 'provider-changed'
  | 'config-changed'
  | 'runtime-restarted';

export interface AwarenessContributor {
  /** Unique identifier, e.g. 'wallet', 'permissions' */
  id: string;

  /** Sort priority (lower = higher in output).
   *  10=runtime, 20=permissions, 30=wallet, 40=provider,
   *  50=pluginHealth, 60=connectors, 70=cloud, 80=features */
  position: number;

  /** Layer 1 summary — injected every turn.
   *  MUST: return plain text, never secrets/keys/tokens.
   *  MUST: ≤ 80 chars. Return '' if nothing to show. */
  summary: (runtime: IAgentRuntime) => Promise<string>;

  /** Layer 2 detail — called via GET_SELF_STATUS action.
   *  Supports brief (~200 tokens) and full (~2000 tokens) levels. */
  detail?: (runtime: IAgentRuntime, level: 'brief' | 'full') => Promise<string>;

  /** Cache TTL in ms. Default 60000. Static info = longer, dynamic = shorter. */
  cacheTtl?: number;

  /** Events that proactively clear the cache (don't wait for TTL). */
  invalidateOn?: AwarenessInvalidationEvent[];

  /** Only built-in contributors are trusted=true.
   *  Third-party plugin output is sanitized before injection. */
  trusted?: boolean;
}
```

## AwarenessRegistry Behavior

Located at `src/awareness/registry.ts`.

### composeSummary() flow:
1. Sort contributors by position (ascending)
2. For each contributor, try-catch:
   - Success → enforce ≤ 80 chars, truncate if needed
   - Error → log, output `[{id}: unavailable]`
   - Untrusted → sanitize output (strip URLs, long strings, potential prompt injection)
3. Concatenate all summaries, check total length
   - ≤ 1200 chars (~300 tokens) → output all
   - \> 1200 chars → keep highest priority, truncate tail + `[+N more]`
4. Wrap with version header: `[Self Status v1]`

### invalidate(event) flow:
1. Iterate all contributors
2. If contributor.invalidateOn includes the event, clear its cache entry
3. Called by API routes (permissions-routes, plugin install, wallet import, etc.)

## Built-in Contributors (v1)

| pos | id | summary example | invalidateOn | cacheTtl |
|-----|-----|------|------|------|
| 10 | runtime | `Model: claude-opus-4-7 via anthropic \| OS: darwin \| pending restart: shell enabled` | config-changed, runtime-restarted | 300s |
| 20 | permissions | `Perms: shell✓ a11y✓ camera✗ mic✗ screen✗` | permission-changed | 120s |
| 30 | wallet | `Wallet: 0x12..ab (local-signer) \| SOL: none` | wallet-updated | 60s |
| 40 | provider | `Provider: anthropic (fallback: openai)` | provider-changed | 300s |
| 50 | pluginHealth | `Plugins: 12 loaded, 1 error (retake)` | plugin-changed | 120s |
| 60 | connectors | `Channels: discord✓ telegram✓ twitch✓` | config-changed | 120s |
| 70 | cloud | `Cloud: connected ($4.20) \| sub: pro` | config-changed | 60s |
| 80 | features | `Features: coding✓ vision✗ voice✗ CUA✓` | config-changed | 300s |

## GET_SELF_STATUS Action

```typescript
// src/actions/get-self-status.ts
{
  name: "GET_SELF_STATUS",
  parameters: {
    module: { enum: ["all", "runtime", "permissions", "wallet", "provider",
                     "pluginHealth", "connectors", "cloud", "features"] },
    detailLevel: { enum: ["brief", "full"], default: "brief" }
  }
}
```

## P0 Guardrails

| # | Guardrail | Implementation |
|---|-----------|---------------|
| 1 | Strict sanitization | summary/detail never expose secrets. Reuses `isEnvKeyAllowedForForwarding()` pattern. Untrusted contributors are sanitized. |
| 2 | Token hard budget | Layer 1 global cap: 1200 chars (~300 tokens). Per-contributor cap: 80 chars. Overflow truncates by priority. |
| 3 | Failure isolation | Each contributor.summary() wrapped in try-catch. Error → `[{id}: unavailable]`. Never blocks other contributors. |
| 4 | Event-driven invalidation | `invalidateOn` field + `registry.invalidate()` calls from API routes. Supplements TTL-based expiry. |
| 5 | Versioned contract | `SELF_STATUS_SCHEMA_VERSION = 1`. Breaking changes increment version. |
| 6 | Trusted sources only | `trusted` field. Built-in = true. Plugin contributors = false by default, output sanitized before prompt injection. |

## New Module Onboarding Checklist

1. Create `src/awareness/contributors/{module-name}.ts`
2. Implement `AwarenessContributor` interface (summary + optional detail)
3. Register in plugin: `plugin.awarenessContributors = [myContributor]`
4. If event-driven invalidation needed, call `awarenessRegistry.invalidate('event')` from relevant API route
5. Done — no core provider/registry/CLAUDE.md changes needed

## File Map

```
src/contracts/awareness.ts          — Core TypeScript interface
src/awareness/registry.ts           — AwarenessRegistry (compose + guardrails)
src/awareness/contributors/
  runtime.ts                         — Model, OS, pending restarts
  permissions.ts                     — Permission states
  wallet.ts                          — Addresses, signer mode
  provider.ts                        — AI provider + fallback
  plugin-health.ts                   — Load count + errors
  connectors.ts                      — Channel status
  cloud.ts                           — Cloud connection + credits
  features.ts                        — Feature flags
src/providers/self-status.ts         — elizaOS provider (calls registry.composeSummary)
src/actions/get-self-status.ts       — GET_SELF_STATUS action (calls registry.getDetail)
```
