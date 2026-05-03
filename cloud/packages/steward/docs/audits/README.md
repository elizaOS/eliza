# Code Quality Audits

Eight parallel cleanup sweeps ran against `develop` on 2026-04-17. Each worker produced an audit documenting findings, what was applied, and what was deferred.

## Scope

| Task | Applied | Deferred | LOC delta |
|------|--------:|---------:|----------:|
| dedup | sha256 helper extracted | 4 items (see audit) | +45 / -6 |
| types | `StewardAuthExchangeResponse` centralized, duplicate React types removed | shared↔sdk/react unification (requires dep wiring) | +18 / -36 |
| deadcode | 6 files deleted (~515 LOC) | package.json deps, SDK/React public exports, scripts | +31 / -515 |
| circular | none needed | none | no code changes |
| weaktypes | 5 sdk/react casts hardened, `erc8004.ts` + `pglite.ts` catch types | broader Drizzle result-shape typing | +28 / -41 |
| trycatch | 3 redundant wrappers removed | 9 kept (JWT parse, third-party fallback, user input) | +17 / -35 |
| legacy | none (worker audited and deferred all) | backward-compat shims for published npm surface | 0 |
| slop | boilerplate/stub comments trimmed in 8 files | inline TODOs with intent | +6 / -25 |

## Notes

- **circular:** `madge` reported zero circular dependencies monorepo-wide.
- **legacy:** no high-confidence legacy removals found. Steward is young enough that migration fallbacks are still load-bearing.
- **deadcode:** `waifu-bridge.ts` delete resolved a modify-delete conflict with the trycatch worker (both agreed the file was unused).
- All workers ran in isolated worktrees. Full typecheck was gated by worktree env limits; verification is completed against the sweep branch before merge.

## Deferred work

Each audit lists deferred items with reasoning. Notable ones worth picking up later:
- Wire `packages/shared` into SDK + React so their types can unify.
- Drizzle result-shape generics (weaktypes worker deferred).
- `packages/eliza-plugin` and `packages/webhooks/persistent-queue.ts` weak types (high-ripple).
