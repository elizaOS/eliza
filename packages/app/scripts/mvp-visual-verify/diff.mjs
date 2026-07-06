/**
 * Compatibility exports for MVP pixel-diff verification. The counters,
 * threshold, baseline compare, and diff PNG writer live in the shared evidence
 * primitive module so screenshot lanes cannot drift on changed-pixel math.
 */

export {
  comparePixels,
  DEFAULT_PIXEL_THRESHOLD,
  diffAgainstBaseline,
  summarizeDiff,
} from "@elizaos/evidence/visual-primitives";
