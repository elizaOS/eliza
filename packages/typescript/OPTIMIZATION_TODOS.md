# TypeScript Optimization TODOs (packages/typescript/src)

Checklist for file-by-file performance parity and cleanup (excluding tests).

## Root files
- [x] `action-docs.ts` — review perf parity and cleanup
- [x] `actions.ts` — review perf parity and cleanup
- [x] `character.ts` — review perf parity and cleanup
- [x] `database.ts` — review perf parity and cleanup
- [x] `entities.ts` — review perf parity and cleanup
- [x] `index.browser.ts` — review perf parity and cleanup
- [x] `index.node.ts` — review perf parity and cleanup
- [x] `index.ts` — review perf parity and cleanup
- [x] `logger.ts` — review perf parity and cleanup
- [x] `memory.ts` — review perf parity and cleanup
- [x] `plugin.ts` — review perf parity and cleanup
- [x] `prompts.ts` — review perf parity and cleanup
- [x] `roles.ts` — review perf parity and cleanup
- [x] `runtime.ts` — review perf parity and cleanup
- [x] `search.ts` — review perf parity and cleanup
- [x] `secrets.ts` — review perf parity and cleanup
- [x] `services.ts` — review perf parity and cleanup
- [x] `settings.ts` — review perf parity and cleanup
- [x] `streaming-context.browser.ts` — review perf parity and cleanup
- [x] `streaming-context.node.ts` — review perf parity and cleanup
- [x] `streaming-context.ts` — review perf parity and cleanup
- [x] `trajectory-context.ts` — review perf parity and cleanup
- [x] `utils.ts` — review perf parity and cleanup

## advanced-capabilities
- [x] `advanced-capabilities/index.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/actions/index.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/actions/addContact.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/actions/followRoom.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/actions/imageGeneration.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/actions/muteRoom.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/actions/removeContact.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/actions/roles.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/actions/scheduleFollowUp.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/actions/searchContacts.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/actions/sendMessage.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/actions/settings.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/actions/unfollowRoom.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/actions/unmuteRoom.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/actions/updateContact.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/actions/updateEntity.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/evaluators/index.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/evaluators/reflection.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/evaluators/relationshipExtraction.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/providers/index.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/providers/contacts.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/providers/facts.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/providers/followUps.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/providers/knowledge.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/providers/relationships.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/providers/roles.ts` — review perf parity and cleanup
- [x] `advanced-capabilities/providers/settings.ts` — review perf parity and cleanup

## advanced-memory
- [x] `advanced-memory/index.ts` — review perf parity and cleanup
- [x] `advanced-memory/prompts.ts` — review perf parity and cleanup
- [x] `advanced-memory/types.ts` — review perf parity and cleanup
- [x] `advanced-memory/evaluators/index.ts` — review perf parity and cleanup
- [x] `advanced-memory/evaluators/long-term-extraction.ts` — review perf parity and cleanup
- [x] `advanced-memory/evaluators/summarization.ts` — review perf parity and cleanup
- [x] `advanced-memory/providers/index.ts` — review perf parity and cleanup
- [x] `advanced-memory/providers/context-summary.ts` — review perf parity and cleanup
- [x] `advanced-memory/providers/long-term-memory.ts` — review perf parity and cleanup
- [x] `advanced-memory/schemas/index.ts` — review perf parity and cleanup
- [x] `advanced-memory/schemas/long-term-memories.ts` — review perf parity and cleanup
- [x] `advanced-memory/schemas/memory-access-logs.ts` — review perf parity and cleanup
- [x] `advanced-memory/schemas/session-summaries.ts` — review perf parity and cleanup
- [x] `advanced-memory/services/memory-service.ts` — review perf parity and cleanup

## advanced-planning
- [x] `advanced-planning/index.ts` — review perf parity and cleanup
- [x] `advanced-planning/prompts.ts` — review perf parity and cleanup
- [x] `advanced-planning/types.ts` — review perf parity and cleanup
- [x] `advanced-planning/actions/chain-example.ts` — review perf parity and cleanup
- [x] `advanced-planning/providers/message-classifier.ts` — review perf parity and cleanup
- [x] `advanced-planning/services/planning-service.ts` — review perf parity and cleanup

## autonomy
- [x] `autonomy/index.ts` — review perf parity and cleanup
- [x] `autonomy/action.ts` — review perf parity and cleanup
- [x] `autonomy/providers.ts` — review perf parity and cleanup
- [x] `autonomy/routes.ts` — review perf parity and cleanup
- [x] `autonomy/service.ts` — review perf parity and cleanup
- [x] `autonomy/types.ts` — review perf parity and cleanup

## basic-capabilities
- [x] `basic-capabilities/index.ts` — review perf parity and cleanup
- [x] `basic-capabilities/actions/index.ts` — review perf parity and cleanup
- [x] `basic-capabilities/actions/choice.ts` — review perf parity and cleanup
- [x] `basic-capabilities/actions/ignore.ts` — review perf parity and cleanup
- [x] `basic-capabilities/actions/none.ts` — review perf parity and cleanup
- [x] `basic-capabilities/actions/reply.ts` — review perf parity and cleanup
- [x] `basic-capabilities/providers/index.ts` — review perf parity and cleanup
- [x] `basic-capabilities/providers/actions.ts` — review perf parity and cleanup
- [x] `basic-capabilities/providers/actionState.ts` — review perf parity and cleanup
- [x] `basic-capabilities/providers/attachments.ts` — review perf parity and cleanup
- [x] `basic-capabilities/providers/capabilities.ts` — review perf parity and cleanup
- [x] `basic-capabilities/providers/character.ts` — review perf parity and cleanup
- [x] `basic-capabilities/providers/choice.ts` — review perf parity and cleanup
- [x] `basic-capabilities/providers/contextBench.ts` — review perf parity and cleanup
- [x] `basic-capabilities/providers/currentTime.ts` — review perf parity and cleanup
- [x] `basic-capabilities/providers/entities.ts` — review perf parity and cleanup
- [x] `basic-capabilities/providers/evaluators.ts` — review perf parity and cleanup
- [x] `basic-capabilities/providers/providers.ts` — review perf parity and cleanup
- [x] `basic-capabilities/providers/recentMessages.ts` — review perf parity and cleanup
- [x] `basic-capabilities/providers/time.ts` — review perf parity and cleanup
- [x] `basic-capabilities/providers/world.ts` — review perf parity and cleanup

## database
- [x] `database/inMemoryAdapter.ts` — review perf parity and cleanup

## generated
- [x] `generated/action-docs.ts` — review perf parity and cleanup
- [x] `generated/spec-helpers.ts` — review perf parity and cleanup

## schemas
- [x] `schemas/character.ts` — review perf parity and cleanup

## services
- [x] `services/embedding.ts` — review perf parity and cleanup
- [x] `services/followUp.ts` — review perf parity and cleanup
- [x] `services/message.ts` — review perf parity and cleanup
- [x] `services/rolodex.ts` — review perf parity and cleanup
- [x] `services/task.ts` — review perf parity and cleanup
- [x] `services/trajectoryLogger.ts` — review perf parity and cleanup

## testing (non-test harness)
- [x] `testing/index.ts` — review perf parity and cleanup
- [x] `testing/inference-provider.ts` — review perf parity and cleanup
- [x] `testing/integration-runtime.ts` — review perf parity and cleanup
- [x] `testing/ollama-provider.ts` — review perf parity and cleanup
- [x] `testing/test-utils.ts` — review perf parity and cleanup

## types
- [x] `types/agent.ts` — review perf parity and cleanup
- [x] `types/components.ts` — review perf parity and cleanup
- [x] `types/database.ts` — review perf parity and cleanup
- [x] `types/environment.ts` — review perf parity and cleanup
- [x] `types/events.ts` — review perf parity and cleanup
- [x] `types/index.ts` — review perf parity and cleanup
- [x] `types/knowledge.ts` — review perf parity and cleanup
- [x] `types/memory.ts` — review perf parity and cleanup
- [x] `types/message-service.ts` — review perf parity and cleanup
- [x] `types/messaging.ts` — review perf parity and cleanup
- [x] `types/model.ts` — review perf parity and cleanup
- [x] `types/plugin.ts` — review perf parity and cleanup
- [x] `types/primitives.ts` — review perf parity and cleanup
- [x] `types/prompts.ts` — review perf parity and cleanup
- [x] `types/proto.ts` — review perf parity and cleanup
- [x] `types/runtime.ts` — review perf parity and cleanup
- [x] `types/service-interfaces.ts` — review perf parity and cleanup
- [x] `types/service.ts` — review perf parity and cleanup
- [x] `types/settings.ts` — review perf parity and cleanup
- [x] `types/state.ts` — review perf parity and cleanup
- [x] `types/streaming.ts` — review perf parity and cleanup
- [x] `types/task.ts` — review perf parity and cleanup
- [x] `types/tee.ts` — review perf parity and cleanup
- [x] `types/testing.ts` — review perf parity and cleanup

## utils
- [x] `utils/buffer.ts` — review perf parity and cleanup
- [x] `utils/crypto-compat.ts` — review perf parity and cleanup
- [x] `utils/environment.ts` — review perf parity and cleanup
- [x] `utils/index.ts` — review perf parity and cleanup
- [x] `utils/node.ts` — review perf parity and cleanup
- [x] `utils/paths.ts` — review perf parity and cleanup
- [x] `utils/server-health.ts` — review perf parity and cleanup
- [x] `utils/streaming.ts` — review perf parity and cleanup
- [x] `utils/type-guards.ts` — review perf parity and cleanup
