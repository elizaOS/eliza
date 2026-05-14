/**
 * Ambient declaration for `@elizaos/capacitor-llama`.
 *
 * The real types ship with the package once `bun install` links the
 * workspace. Until then (and in server-only TypeScript builds that don't
 * pull in Capacitor plugins), this minimal shape keeps the dynamic-import
 * callsite in `ensure-local-inference-handler.ts` compiling cleanly.
 */
declare module "@elizaos/capacitor-llama" {
  import type { AgentRuntime } from "@elizaos/core";
  export function registerCapacitorLlamaLoader(runtime: AgentRuntime): void;
}
