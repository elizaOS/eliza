/**
 * Re-export of the core wrapper parser so agent-internal callers keep their
 * import path; the parser lives in core so Stage-1 gates can use it too.
 */
export { userRequestFromAugmentedText } from "@elizaos/core";
