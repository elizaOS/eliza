/**
 * Re-homes the shared `AwarenessRegistry` under the agent package so runtime
 * and plugin code import it from a stable local path rather than reaching into
 * `@elizaos/core` directly.
 */
export { AwarenessRegistry } from "@elizaos/core/awareness/registry";
