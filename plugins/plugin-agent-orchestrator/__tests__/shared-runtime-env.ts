/** Exposes the shared runtime helpers used by orchestrator tests without loading the generated-data barrel. */
export {
  isAndroidMobile,
  resolvePlatform,
} from "../../../packages/shared/src/runtime-env.js";
export { readAliasedEnv } from "../../../packages/shared/src/utils/env.js";
export {
  DEFAULT_MAX_RELAY_CHARS,
  elideLongBlocks,
  sanitizeCompletionRelay,
  stripEnvelopeSummaryLines,
  stripStructuredProofLines,
  stripToolTranscript,
  TOOL_OUTPUT_END_MARKER,
} from "../../../packages/shared/src/utils/transcript-sanitizer.js";
