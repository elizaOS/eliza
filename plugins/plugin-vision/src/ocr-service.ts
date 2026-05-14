import { logger } from "@elizaos/core";
import { RapidOCRService, shouldPreferAppleVision } from "./ocr-service-rapid";
import { RealOCRService } from "./ocr-service-real";
import type { BoundingBox, OCRResult, ScreenTile } from "./types";

export type OCRBackendName = "rapid" | "apple-vision" | "tesseract";

export interface OCRServiceConfig {
  /**
   * Force a specific backend. If unset, the chain is:
   *   1. RapidOCR (PP-OCRv5 via onnxruntime-node) when available
   *   2. Apple Vision when running on darwin (stubbed — owned by WS9)
   *   3. Tesseract.js as the last-resort fallback
   */
  backend?: OCRBackendName;
}

interface OCRBackend {
  name: OCRBackendName;
  initialize(): Promise<void>;
  extractText(buffer: Buffer): Promise<OCRResult>;
  extractStructuredData?(buffer: Buffer): Promise<{
    tables?: Array<{ rows: string[][]; bbox: BoundingBox }>;
    forms?: Array<{ label: string; value: string; bbox: BoundingBox }>;
    lists?: Array<{ items: string[]; bbox: BoundingBox }>;
  }>;
  dispose(): Promise<void>;
}

class TesseractBackend implements OCRBackend {
  readonly name: OCRBackendName = "tesseract";
  private impl = new RealOCRService();
  initialize() {
    return this.impl.initialize();
  }
  extractText(buffer: Buffer) {
    return this.impl.extractText(buffer);
  }
  extractStructuredData(buffer: Buffer) {
    return this.impl.extractStructuredData(buffer);
  }
  dispose() {
    return this.impl.dispose();
  }
}

class RapidBackend implements OCRBackend {
  readonly name: OCRBackendName = "rapid";
  private impl = new RapidOCRService();
  initialize() {
    return this.impl.initialize();
  }
  extractText(buffer: Buffer) {
    return this.impl.extractText(buffer);
  }
  dispose() {
    return this.impl.dispose();
  }
}

/**
 * External provider seam for the Apple Vision OCR backend.
 *
 * `plugin-vision` does not take a runtime dep on `@elizaos/plugin-computeruse`
 * — that would invert the layering (computeruse is the higher-level seam).
 * Instead, the runtime registers a provider here on iOS/macOS startup using
 * `createIosVisionOcrProvider(...)` from
 * `@elizaos/plugin-computeruse/mobile/ocr-provider`. Until a provider is
 * registered, `AppleVisionBackend.extractText` throws so the chooser falls
 * through to RapidOCR / Tesseract.
 *
 * The provider shape is intentionally structural so plugin-vision stays
 * Node-importable on hosts that don't ship Capacitor.
 */
export interface AppleVisionOcrProvider {
  /** Stable id used in logs/telemetry. */
  readonly name: string;
  /** True when the underlying bridge is registered and ready. */
  available(): boolean;
  /**
   * Recognize text in the JPEG/PNG bytes. The plugin-computeruse iOS provider
   * returns `OcrResult`; we map to plugin-vision's `OCRResult` shape inline.
   */
  recognize(input: { kind: "bytes"; data: Uint8Array }): Promise<{
    readonly lines: ReadonlyArray<{
      readonly text: string;
      readonly confidence: number;
      readonly boundingBox: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
    }>;
    readonly fullText: string;
  }>;
}

let registeredAppleVisionProvider: AppleVisionOcrProvider | null = null;

/**
 * Register the Apple Vision OCR provider. Idempotent — last call wins so a
 * hot-reload of the bridge swaps cleanly. Pass `null` to unregister.
 */
export function registerAppleVisionOcrProvider(
  provider: AppleVisionOcrProvider | null,
): void {
  registeredAppleVisionProvider = provider;
  logger.info(
    `[OCR] AppleVision provider ${provider ? "registered" : "cleared"}${
      provider?.name ? ` (${provider.name})` : ""
    }`,
  );
}

/** Test/inspection helper. */
export function getAppleVisionOcrProvider(): AppleVisionOcrProvider | null {
  return registeredAppleVisionProvider;
}

/**
 * Apple Vision backend — delegates to a runtime-registered provider supplied
 * by WS9's `createIosVisionOcrProvider`. When no provider is registered the
 * backend throws so the chooser falls through to the next entry in the
 * priority chain.
 */
class AppleVisionBackend implements OCRBackend {
  readonly name: OCRBackendName = "apple-vision";
  async initialize(): Promise<void> {
    if (!registeredAppleVisionProvider) {
      throw new Error(
        "Apple Vision OCR backend has no registered provider — call registerAppleVisionOcrProvider(createIosVisionOcrProvider(getBridge)) from the runtime.",
      );
    }
    if (!registeredAppleVisionProvider.available()) {
      throw new Error(
        "Apple Vision OCR provider reports unavailable (Capacitor ComputerUse bridge not yet registered).",
      );
    }
  }
  async extractText(buffer: Buffer): Promise<OCRResult> {
    const provider = registeredAppleVisionProvider;
    if (!provider) {
      throw new Error(
        "Apple Vision OCR backend has no registered provider at extract time",
      );
    }
    const result = await provider.recognize({
      kind: "bytes",
      data: new Uint8Array(buffer),
    });
    const blocks = result.lines.map((line) => ({
      text: line.text,
      confidence: line.confidence,
      bbox: {
        x: line.boundingBox.x,
        y: line.boundingBox.y,
        width: line.boundingBox.width,
        height: line.boundingBox.height,
      } as BoundingBox,
    }));
    return {
      text: result.fullText,
      blocks,
      fullText: result.fullText,
    };
  }
  async dispose(): Promise<void> {
    /* Provider lifecycle is owned by the registrant, not this backend. */
  }
}

/**
 * Choose the highest-priority available backend. We do this at every
 * `extractText` call (cheaply — backend instances are cached) so a
 * runtime-loaded RapidOCR can take over from Tesseract without restart.
 */
export class OCRService {
  private backends: OCRBackend[] = [];
  private chosen: OCRBackend | null = null;
  private initialized = false;
  private readonly forced?: OCRBackendName;

  constructor(config: OCRServiceConfig = {}) {
    this.forced = config.backend;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info("[OCR] initializing OCR service…");

    // Build the priority chain. Order matters.
    const candidates: Array<() => Promise<OCRBackend | null>> = [];
    if (!this.forced || this.forced === "rapid") {
      candidates.push(async () =>
        (await RapidOCRService.isAvailable()) ? new RapidBackend() : null,
      );
    }
    if (!this.forced || this.forced === "apple-vision") {
      candidates.push(async () =>
        shouldPreferAppleVision() ? new AppleVisionBackend() : null,
      );
    }
    if (!this.forced || this.forced === "tesseract") {
      candidates.push(async () => new TesseractBackend());
    }

    for (const factory of candidates) {
      const backend = await factory();
      if (!backend) continue;
      try {
        if (backend.name === "rapid") {
          // Defer fetch/load until first use so OCRService.initialize stays
          // cheap. RapidBackend.initialize() is what actually triggers the
          // ONNX model download.
          this.backends.push(backend);
          if (!this.chosen) this.chosen = backend;
          continue;
        }
        await backend.initialize();
        this.backends.push(backend);
        if (!this.chosen) this.chosen = backend;
      } catch (error) {
        logger.warn(
          `[OCR] backend ${backend.name} unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        await backend.dispose().catch(() => {});
      }
    }

    if (!this.chosen) {
      throw new Error("No OCR backend available (Tesseract fallback failed)");
    }
    this.initialized = true;
    logger.info(`[OCR] active backend: ${this.chosen.name}`);
  }

  async extractText(imageBuffer: Buffer): Promise<OCRResult> {
    if (!this.initialized) await this.initialize();
    if (!this.chosen) throw new Error("OCR not initialized");

    // Walk the priority list — if the chosen backend throws, fall back to
    // the next loaded backend instead of returning an empty result. This is
    // intentionally narrow: a failure in the active backend is logged and
    // counted, but the call still produces text where possible.
    const ordered = [
      this.chosen,
      ...this.backends.filter((b) => b !== this.chosen),
    ];
    let lastError: unknown = null;
    for (const backend of ordered) {
      try {
        if (backend.name === "rapid" && backend instanceof RapidBackend) {
          // Lazy-init on first call so cold start doesn't block boot.
          await backend.initialize();
        }
        return await backend.extractText(imageBuffer);
      } catch (error) {
        lastError = error;
        logger.warn(
          `[OCR] backend ${backend.name} failed:`,
          error instanceof Error ? error.message : error,
        );
        // If this was the chosen backend, demote it so subsequent calls go
        // straight to the fallback.
        if (backend === this.chosen && ordered.length > 1) {
          this.chosen = ordered[1];
          logger.warn(`[OCR] demoted to backend: ${this.chosen.name}`);
        }
      }
    }
    throw new Error(
      `All OCR backends failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  async extractFromTile(tile: ScreenTile): Promise<OCRResult> {
    if (!tile.data) {
      return { text: "", blocks: [], fullText: "" };
    }
    return this.extractText(tile.data);
  }

  async extractFromImage(imageBuffer: Buffer): Promise<OCRResult> {
    return this.extractText(imageBuffer);
  }

  async extractStructuredData(imageBuffer: Buffer): Promise<{
    tables?: Array<{ rows: string[][]; bbox: BoundingBox }>;
    forms?: Array<{ label: string; value: string; bbox: BoundingBox }>;
    lists?: Array<{ items: string[]; bbox: BoundingBox }>;
  }> {
    if (!this.initialized) await this.initialize();
    // Only Tesseract has structured-data support today; if our chosen
    // backend doesn't implement it, fall through to the Tesseract backend
    // when present.
    const fallback = this.backends.find(
      (b): b is TesseractBackend => b.name === "tesseract",
    );
    const target =
      this.chosen && this.chosen.extractStructuredData
        ? this.chosen
        : (fallback ?? null);
    if (!target?.extractStructuredData) {
      return { tables: [], forms: [], lists: [] };
    }
    try {
      return await target.extractStructuredData(imageBuffer);
    } catch (error) {
      logger.error("[OCR] structured-data extraction failed:", error);
      return { tables: [], forms: [], lists: [] };
    }
  }

  /** Test/inspection helper. */
  getActiveBackend(): OCRBackendName | null {
    return this.chosen?.name ?? null;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async dispose(): Promise<void> {
    for (const backend of this.backends) {
      await backend.dispose().catch((error) => {
        logger.warn(`[OCR] dispose ${backend.name} failed:`, error);
      });
    }
    this.backends = [];
    this.chosen = null;
    this.initialized = false;
    logger.info("[OCR] service disposed");
  }
}
