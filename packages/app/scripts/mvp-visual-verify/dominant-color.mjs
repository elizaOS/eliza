/**
 * Compatibility exports for MVP screenshot palette extraction. The quantizer
 * and PNG decoder live in `@elizaos/testing/evidence/visual-primitives` so all evidence
 * tools report dominant colors with the same bucket math.
 */

export {
  dominantColorsFromPng,
  quantizePalette,
} from "@elizaos/testing/evidence/visual-primitives";
