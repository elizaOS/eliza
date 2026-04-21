# Onboarding unit tests

Vitest picks up `*.test.ts` under `packages/app-core/src/` (see repo root `vitest.config.ts`).

**Why a `tests/` folder:** keeps implementation files (`flow.ts`, `connection-flow.ts`, `types.ts`) free of colocated test noise; one place to look for onboarding coverage.

| File | Covers |
|------|--------|
| `flow.test.ts` | Wizard step order, back/next resolution, nav metas, Flamina topics. |
| `connection-flow.test.ts` | Connection subflow screens, UI spec invariants, transitions. |

Run from repo root: `bun test packages/app-core/src/onboarding/tests`
