# Phase 3 Backend Types And Routes Duplication

Dry-run only. No implementation files were deleted or modified for this audit.

## Guardrails

- Preserve the LifeOps architecture in `AGENTS.md`: one `ScheduledTask` primitive, one runner, structural behavior, health as a separate plugin, typed connector/channel dispatch results, and auditable identity merge.
- Do not delete routes or shared contracts from Knip output until Knip runs successfully. Local Knip is blocked by the `oxc-resolver` native binding/code-signature failure.
- Treat this as a consolidation queue. Each item needs a small PR with targeted tests, not a broad sweep.

## Highest-Confidence Consolidations

### 1. Trigger DTOs Are Duplicated Across Agent And UI

Evidence:

- `packages/agent/src/triggers/types.ts` defines `TriggerTaskMetadata`, `TriggerSummary`, `TriggerHealthSnapshot`, `CreateTriggerRequest`, and `UpdateTriggerRequest`.
- `packages/ui/src/api/client-types-core.ts` repeats the same interface shapes.
- `packages/ui/src/api/agent-client-type-shim.ts` repeats the same shapes again while aliasing core trigger primitives.

Dry-run change:

- Move the trigger HTTP DTOs into a shared contract module, likely `packages/shared/src/contracts/triggers.ts`.
- Export the shared DTOs from `@elizaos/shared/contracts`.
- Replace the agent and UI copies with type imports from the shared contract.
- Delete `packages/ui/src/api/agent-client-type-shim.ts` if usage drops to zero.

Validation:

```sh
rg -n "interface (TriggerTaskMetadata|TriggerSummary|TriggerHealthSnapshot|CreateTriggerRequest|UpdateTriggerRequest)" packages plugins
bun run --cwd packages/shared typecheck
bun run --cwd packages/agent typecheck
bun run --cwd packages/ui typecheck
bun run --cwd plugins/app-trajectory-logger typecheck
```

Risk:

- Medium. These DTOs are public API/client shapes. Keep names stable and add a schema-vs-type or compile-only test that imports the DTOs from agent and UI callers.

### 2. Conversation Metadata Has Three Sources Of Truth

Evidence:

- `packages/shared/src/contracts/conversation-routes.ts` defines `ConversationScopeSchema`, `ConversationAutomationTypeSchema`, and `ConversationMetadataSchema`.
- The same file explicitly says it must stay in sync with `packages/agent/src/api/server-types.ts` and `packages/agent/src/api/conversation-metadata.ts`.
- `packages/ui/src/api/client-types-core.ts` defines `ConversationScope`, `ConversationAutomationType`, and `ConversationMetadata` separately.

Dry-run change:

- Make the shared Zod schema the canonical source.
- Export `ConversationScope`, `ConversationAutomationType`, and `ConversationMetadata` as `z.infer` types from `packages/shared/src/contracts/conversation-routes.ts`.
- Replace UI and agent type copies with imports from shared.
- Keep `VALID_SCOPES` only if runtime code needs a fast array; derive it from the schema where possible.

Validation:

```sh
bun run --cwd packages/shared test -- conversation-routes
bun run --cwd packages/agent typecheck
bun run --cwd packages/ui typecheck
rg -n "type ConversationScope|interface ConversationMetadata|VALID_SCOPES" packages/agent/src packages/ui/src packages/shared/src
```

Risk:

- Medium. Conversation metadata drives UI page context, automation workflow context, and chat persistence. Run the shared contract tests plus UI smoke for page-scoped conversations.

### 3. LifeOps Still Has Transitional Health Re-Export Surfaces

Evidence:

- `plugins/app-lifeops/src/index.ts` re-exports `detectHealthBackend` from `@elizaos/plugin-health`.
- `plugins/app-lifeops/src/lifeops/index.ts` re-exports health bridge symbols from `@elizaos/plugin-health` for existing import paths.
- `plugins/app-lifeops/src/lifeops/checkin/types.ts` imports `SleepRecap` from health with a move note.
- `plugins/app-lifeops/src/lifeops/repository.ts` imports health-owned sleep/health record factories and comments that they are re-exported for compatibility.

Dry-run change:

- Keep LifeOps using health through the public `@elizaos/plugin-health` package only; no internal imports were found in this scan.
- Inventory external imports of the LifeOps re-export paths.
- Move callers to `@elizaos/plugin-health`.
- Remove only the compatibility re-exports that have no external callers.

Validation:

```sh
rg -n "detectHealthBackend|health-bridge|SleepRecap|createLifeOpsSleepEpisode|createLifeOpsHealth" packages plugins --glob '!plugins/app-lifeops/**'
bun run --cwd plugins/plugin-health typecheck
bun run --cwd plugins/app-lifeops typecheck
bun run --cwd plugins/app-lifeops test
```

Risk:

- Medium. This is safe only if consumers are migrated first. Do not collapse health internals into LifeOps; that would violate the repo charter.

### 4. LifeOps Route Handlers Use Boolean Return Values As Local Dispatch Sentinels

Evidence:

- `plugins/app-lifeops/src/routes/scheduled-tasks.ts` has route-handler factories returning `Promise<boolean>`.
- `plugins/app-lifeops/src/routes/lifeops-routes.ts`, `routes/entities.ts`, `routes/plugin.ts`, and `routes/sleep-routes.ts` use the same pattern.
- This is local HTTP route dispatch, not connector/channel dispatch, so it does not directly violate the typed `DispatchResult` connector rule.

Dry-run change:

- Introduce a tiny route result type, for example `{ handled: true } | { handled: false }`, only if it clarifies control flow.
- Do not churn every route just to remove booleans; prioritize handlers where `true` means both "handled successfully" and "handled by writing an error response".

Validation:

```sh
rg -n "Promise<boolean>|return true;|return false;" plugins/app-lifeops/src/routes
bun run --cwd plugins/app-lifeops test -- routes
```

Risk:

- Low to medium. This is cleanup, not behavior. Avoid changing response status/body semantics.

## Lower-Confidence Follow-Ups

### Shared Route Contract Coverage

`packages/shared/src/contracts` now owns route schemas for conversations, inbox, and app run messages. The agent route files mostly consume those schemas, but UI client files still carry many response/request interfaces directly. The next pass should classify each UI client type as:

- Canonical shared contract.
- UI-only view model.
- Server response shape missing a shared schema.

Dry-run command:

```sh
rg -n "export interface .*Request|export interface .*Response|export type .*Request|export type .*Response" packages/ui/src/api packages/agent/src/api packages/shared/src/contracts
```

### Route Registration Duplication

The app/API route layer has route registration in `packages/agent/src/api/server.ts`, `packages/agent/src/api/server-route-dispatch.ts`, and many route group modules. The current shape appears intentional: `server-route-dispatch.ts` delegates route groups and `server.ts` wires process state. Do not delete route modules without a route catalog test that proves every path is still registered.

Validation:

```sh
bun run --cwd packages/agent test -- server-route
rg -n "handle.*Route|register.*Route|/api/" packages/agent/src/api
```

## Proposed Order

1. Consolidate trigger DTOs into shared contracts.
2. Consolidate conversation metadata types around the shared Zod schema.
3. Remove LifeOps health compatibility re-exports only after external import scan is clean.
4. Normalize LifeOps route dispatch return types only where it removes ambiguity.

## Signoff Gates

- `bun run --cwd packages/shared test`
- `bun run --cwd packages/agent typecheck`
- `bun run --cwd packages/ui typecheck`
- `bun run --cwd plugins/app-lifeops test`
- Source-only Madge remains cycle-free.
- Knip rerun succeeds after the local `oxc-resolver` issue is fixed.
