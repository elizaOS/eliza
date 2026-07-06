/**
 * Compatibility exports for the MVP visual verifier's brand-color buckets.
 * The implementation lives in `@elizaos/evidence/visual-primitives` so app
 * audit post-processing and cross-lane evidence review share one no-blue /
 * orange-accent classifier.
 */

export {
  bucket,
  bucketRgb,
  parseRgb,
} from "@elizaos/evidence/visual-primitives";
