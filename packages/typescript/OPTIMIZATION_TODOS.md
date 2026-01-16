# TypeScript Optimization TODOs (packages/typescript/src)

Checklist for file-by-file performance parity and cleanup (excluding tests).

## Root files
- [ ] `action-docs.ts` — review perf parity and cleanup
- [ ] `actions.ts` — review perf parity and cleanup
- [ ] `character.ts` — review perf parity and cleanup
- [ ] `database.ts` — review perf parity and cleanup
- [ ] `entities.ts` — review perf parity and cleanup
- [ ] `index.browser.ts` — review perf parity and cleanup
- [ ] `index.node.ts` — review perf parity and cleanup
- [ ] `index.ts` — review perf parity and cleanup
- [ ] `logger.ts` — review perf parity and cleanup
- [ ] `memory.ts` — review perf parity and cleanup
- [ ] `plugin.ts` — review perf parity and cleanup
- [ ] `prompts.ts` — review perf parity and cleanup
- [ ] `roles.ts` — review perf parity and cleanup
- [ ] `runtime.ts` — review perf parity and cleanup
- [ ] `search.ts` — review perf parity and cleanup
- [ ] `secrets.ts` — review perf parity and cleanup
- [ ] `services.ts` — review perf parity and cleanup
- [ ] `settings.ts` — review perf parity and cleanup
- [ ] `streaming-context.browser.ts` — review perf parity and cleanup
- [ ] `streaming-context.node.ts` — review perf parity and cleanup
- [ ] `streaming-context.ts` — review perf parity and cleanup
- [ ] `trajectory-context.ts` — review perf parity and cleanup
- [ ] `utils.ts` — review perf parity and cleanup

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
- [ ] `basic-capabilities/index.ts` — review perf parity and cleanup
- [x] `basic-capabilities/actions/index.ts` — review perf parity and cleanup
- [x] `basic-capabilities/actions/choice.ts` — review perf parity and cleanup
- [x] `basic-capabilities/actions/ignore.ts` — review perf parity and cleanup
- [x] `basic-capabilities/actions/none.ts` — review perf parity and cleanup
- [x] `basic-capabilities/actions/reply.ts` — review perf parity and cleanup
- [ ] `basic-capabilities/providers/index.ts` — review perf parity and cleanup
- [ ] `basic-capabilities/providers/actions.ts` — review perf parity and cleanup
- [ ] `basic-capabilities/providers/actionState.ts` — review perf parity and cleanup
- [ ] `basic-capabilities/providers/attachments.ts` — review perf parity and cleanup
- [ ] `basic-capabilities/providers/capabilities.ts` — review perf parity and cleanup
- [ ] `basic-capabilities/providers/character.ts` — review perf parity and cleanup
- [ ] `basic-capabilities/providers/choice.ts` — review perf parity and cleanup
- [ ] `basic-capabilities/providers/contextBench.ts` — review perf parity and cleanup
- [ ] `basic-capabilities/providers/currentTime.ts` — review perf parity and cleanup
- [ ] `basic-capabilities/providers/entities.ts` — review perf parity and cleanup
- [ ] `basic-capabilities/providers/evaluators.ts` — review perf parity and cleanup
- [ ] `basic-capabilities/providers/providers.ts` — review perf parity and cleanup
- [ ] `basic-capabilities/providers/recentMessages.ts` — review perf parity and cleanup
- [ ] `basic-capabilities/providers/time.ts` — review perf parity and cleanup
- [ ] `basic-capabilities/providers/world.ts` — review perf parity and cleanup

## database
- [ ] `database/inMemoryAdapter.ts` — review perf parity and cleanup

## generated
- [ ] `generated/action-docs.ts` — review perf parity and cleanup
- [ ] `generated/spec-helpers.ts` — review perf parity and cleanup

## schemas
- [ ] `schemas/character.ts` — review perf parity and cleanup

## services
- [ ] `services/embedding.ts` — review perf parity and cleanup
- [ ] `services/followUp.ts` — review perf parity and cleanup
- [ ] `services/message.ts` — review perf parity and cleanup
- [ ] `services/rolodex.ts` — review perf parity and cleanup
- [ ] `services/task.ts` — review perf parity and cleanup
- [ ] `services/trajectoryLogger.ts` — review perf parity and cleanup

## testing (non-test harness)
- [ ] `testing/index.ts` — review perf parity and cleanup
- [ ] `testing/inference-provider.ts` — review perf parity and cleanup
- [ ] `testing/integration-runtime.ts` — review perf parity and cleanup
- [ ] `testing/ollama-provider.ts` — review perf parity and cleanup
- [ ] `testing/test-helpers.ts` — review perf parity and cleanup

## types
- [ ] `types/agent.ts` — review perf parity and cleanup
- [ ] `types/components.ts` — review perf parity and cleanup
- [ ] `types/database.ts` — review perf parity and cleanup
- [ ] `types/environment.ts` — review perf parity and cleanup
- [ ] `types/events.ts` — review perf parity and cleanup
- [ ] `types/index.ts` — review perf parity and cleanup
- [ ] `types/knowledge.ts` — review perf parity and cleanup
- [ ] `types/memory.ts` — review perf parity and cleanup
- [ ] `types/message-service.ts` — review perf parity and cleanup
- [ ] `types/messaging.ts` — review perf parity and cleanup
- [ ] `types/model.ts` — review perf parity and cleanup
- [ ] `types/plugin.ts` — review perf parity and cleanup
- [ ] `types/primitives.ts` — review perf parity and cleanup
- [ ] `types/prompts.ts` — review perf parity and cleanup
- [ ] `types/proto.ts` — review perf parity and cleanup
- [ ] `types/runtime.ts` — review perf parity and cleanup
- [ ] `types/service-interfaces.ts` — review perf parity and cleanup
- [ ] `types/service.ts` — review perf parity and cleanup
- [ ] `types/settings.ts` — review perf parity and cleanup
- [ ] `types/state.ts` — review perf parity and cleanup
- [ ] `types/streaming.ts` — review perf parity and cleanup
- [ ] `types/task.ts` — review perf parity and cleanup
- [ ] `types/tee.ts` — review perf parity and cleanup
- [ ] `types/testing.ts` — review perf parity and cleanup

## utils
- [ ] `utils/buffer.ts` — review perf parity and cleanup
- [ ] `utils/crypto-compat.ts` — review perf parity and cleanup
- [ ] `utils/environment.ts` — review perf parity and cleanup
- [ ] `utils/index.ts` — review perf parity and cleanup
- [ ] `utils/node.ts` — review perf parity and cleanup
- [ ] `utils/paths.ts` — review perf parity and cleanup
- [ ] `utils/server-health.ts` — review perf parity and cleanup
- [ ] `utils/streaming.ts` — review perf parity and cleanup
- [ ] `utils/type-guards.ts` — review perf parity and cleanup
