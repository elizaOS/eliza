/**
 * Compatibility exports for MVP screenshot OCR. Engine resolution, packaged
 * tesseract workers, explicit unavailable results, and cleanup live in the
 * shared evidence primitive module so OCR failure semantics stay consistent.
 */

export {
  closeOcrEngines,
  ocrImage,
  resetTesseractProbe,
  resolveOcrEngine,
  resolveTesseract,
} from "@elizaos/evidence/visual-primitives";
