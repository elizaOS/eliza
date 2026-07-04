/**
 * Re-exports the canonical view-interact protocol contract from
 * `@elizaos/shared`. The constants and types live in shared so the agent server
 * can dispatch against them without importing UI internals (#12408); this module
 * keeps the historical `@elizaos/ui/views/view-interact-protocol` import path
 * working for UI consumers.
 */

export {
  STANDARD_CAPABILITIES,
  type StandardCapability,
  type ViewInteractRequest,
  type ViewInteractResult,
} from "@elizaos/shared/views/view-interact-protocol";
