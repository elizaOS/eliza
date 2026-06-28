/**
 * CloudBootstrapMessageService — public barrel.
 *
 * The implementation is split across `./cloud-bootstrap-message-service/`:
 *
 *   - `service.ts`          — `CloudBootstrapMessageService` (orchestration class)
 *   - `types.ts`             — internal interfaces, `EMPTY_STATE`, `SINGLE_SHOT_TEMPLATE`,
 *                              metadata helpers
 *   - `model-resolution.ts`  — per-step model resolvers + scoped entity-settings overrides
 *   - `retry.ts`             — exponential backoff + structured-output parser
 *
 * The class is cohesive: its private methods share local state, the
 * runtime, and tracing helpers, so it stayed in a single file rather
 * than being decomposed into per-strategy classes. Module-level helpers
 * that were free functions in the original file are extracted into the
 * sibling modules above.
 */

export { CloudBootstrapMessageService } from "./cloud-bootstrap-message-service/service";
