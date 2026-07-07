/**
 * Re-exports the shared streaming-text delta/merge helpers used by the chat
 * reducer.
 */
export {
  computeStreamingDelta,
  DELTA_STREAM_PROTOCOL,
  type DeltaStreamProtocol,
  mergeStreamingText,
  resolveStreamingUpdate,
  type StreamingUpdateResult,
} from "@elizaos/shared";
