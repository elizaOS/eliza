/**
 * Compatibility exports for MVP screenshot OCR and its independent pixel
 * diagnostics. Engine resolution, preprocessing, explicit unavailable results,
 * and cleanup live in the shared evidence primitive module so failure semantics
 * stay consistent.
 */

export {
  analyzeImageFile,
  closeOcrEngines,
  ocrImage,
  resetTesseractProbe,
  resolveOcrEngine,
  resolveTesseract,
} from "@elizaos/evidence/visual-primitives";
