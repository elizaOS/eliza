# Onboarding flow (app-core)

## What this folder is

| File | What it does |
|------|----------------|
| **`flow.ts`** | Pure helpers for **wizard step** order: next/previous step id, step nav rows, Flamina topic, backward jump rules. Scope: `deployment` → `providers` → `features`. |
| **`types.ts`** | Types for the **connection** subflow (`ConnectionScreen`, `ConnectionEvent`, snapshots, patches, UI spec). **Why separate:** import types without transition logic. |
| **`connection-flow.ts`** | Pure nested **deployment/provider** subflow inside the providers step: `deriveConnectionScreen`, `applyConnectionTransition`, `resolveConnectionUiSpec`, constants. Re-exports types from `types.ts`. |
| **`tests/`** | Vitest specs: `flow.test.ts`, `connection-flow.test.ts`. **Why a folder:** keeps source files uncluttered. See [`tests/README.md`](tests/README.md). |

## Why two modules (`flow` vs `connection-flow`)?

They answer **different questions**:

- **`flow.ts`** — “What is the **next wizard step** after `deployment`?” — one linear order for the current three-step wizard. It must not know about local vs remote vs Eliza Cloud selection details; that is orthogonal.
- **`connection-flow.ts`** — “Given onboarding **connection** fields, which **panel** should render, and what **state patch** does this button imply?” — many branches, still one wizard step id (`providers`).

**Why not one file:** merging them would couple outer wizard order to inner connection state and encourage importing React into step-order logic. **Why not put connection in `onboarding-config.ts`:** that file builds the **HTTP submit payload** for the API — a different output contract than “which UI to show.”

## Why is `connection-flow.ts` React-free?

So you can run **fast unit tests** without jsdom, and so **dynamic imports / circular deps** do not pull `components/` into pure logic. Side effects (`handleOnboardingUseLocalBackend`, `handleCloudLogin`, `retryStartup`) stay in **`AppProvider`** / screen components; the reducer only returns **data** (`patch` or `effect`).

## Imports

- **`@elizaos/app-core/onboarding/flow`** — Wizard step order (see `package.json` `"exports"`).
- **`@elizaos/app-core/onboarding/types`** — Connection subflow types only.
- **`@elizaos/app-core/onboarding/connection-flow`** — Connection subflow logic + re-exported types.
- **`@elizaos/app-core/state/internal`** — Re-exports `flow` symbols for code that already uses `internal`.

## UI entry points

- Wizard shell: `components/onboarding/ConnectionStep.tsx` (builds snapshot, dispatches transitions, renders `connection/ConnectionUiRoot.tsx`).
- Screen components: `components/onboarding/connection/README.md`.
- **Product name in copy:** `config/branding.ts` exports **`appNameInterpolationVars`** for locale strings that use `{{appName}}`. **Why here:** branding defaults and i18n vars stay in one module shells already import.

## Full narrative

[docs/guides/onboarding-ui-flow.md](../../../../docs/guides/onboarding-ui-flow.md) in the repo root.
