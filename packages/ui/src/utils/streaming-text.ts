/**
 * Re-exports the shared streaming-text delta/merge helpers used by the chat
 * reducer.
 */
export {
  computeStreamingDelta,
  mergeStreamingText,
  resolveStreamingUpdate,
  type StreamingUpdateResult,
} from "@elizaos/shared";
