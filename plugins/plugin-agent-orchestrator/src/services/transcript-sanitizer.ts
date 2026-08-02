/**
 * Compatibility surface for orchestrator-internal relay sanitation imports.
 * The implementation lives in @elizaos/shared so the agent startup path does
 * not depend on the optional orchestrator plugin being fully installed.
 */

export {
  DEFAULT_MAX_RELAY_CHARS,
  elideLongBlocks,
  sanitizeCompletionRelay,
  stripEnvelopeSummaryLines,
  stripStructuredProofLines,
  stripToolTranscript,
  TOOL_OUTPUT_END_MARKER,
} from "@elizaos/shared";
