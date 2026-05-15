import { logger } from "@elizaos/core";
import {
  DoctrOCRService,
  shouldPreferAppleVision,
} from "./ocr-service-doctr";
import type { BoundingBox, OCRResult, ScreenTile } from "./types";

export type OCRBackendName = "doctr" | "apple-vision";

export interface OCRServiceConfig {
  /**
   * Force a specific backend. If unset, the chain is:
   *   1. Apple Vision (darwin only, when a provider has been registered)
   *   2. doCTR (ggml-backed CRNN+DBNet via native/doctr.cpp)
   *
   * There is no tesseract / onnx fallback — the migration removed both.
   * If neither backend can initialize, `initialize()` throws.
   */
  backend?: OCRBackendName;
}

interface OCRBackend {
  name: OCRBackendName;
  initialize(): Promise<void>;
  extractText(buffer: Buffer): Promise<OCRResult>;
  dispose(): Promise<void>;
}

class DoctrBackend implements OCRBackend {
  readonly name: OCRBackendName = "doctr";
  private impl = new DoctrOCRService();
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
 * through to the doCTR ggml backend.
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

export function getAppleVisionOcrProvider(): AppleVisionOcrProvider | null {
  return registeredAppleVisionProvider;
}

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
 * Walk the priority chain and pick the first backend that initializes.
 * Backend instances are cached; per-call we just dispatch to the active one.
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

    const candidates: Array<() => Promise<OCRBackend | null>> = [];
    if (!this.forced || this.forced === "apple-vision") {
      candidates.push(async () =>
        shouldPreferAppleVision() ? new AppleVisionBackend() : null,
      );
    }
    if (!this.forced || this.forced === "doctr") {
      candidates.push(async () =>
        (await DoctrOCRService.isAvailable()) ? new DoctrBackend() : null,
      );
    }

    for (const factory of candidates) {
      const backend = await factory();
      if (!backend) continue;
      try {
        if (backend.name === "doctr") {
          // Defer GGUF load until first use so OCRService.initialize stays
          // cheap. DoctrBackend.initialize() is what triggers the FFI load.
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
      throw new Error(
        "No OCR backend available — doctr.cpp GGUFs not built and no Apple Vision provider registered.",
      );
    }
    this.initialized = true;
    logger.info(`[OCR] active backend: ${this.chosen.name}`);
  }

  async extractText(imageBuffer: Buffer): Promise<OCRResult> {
    if (!this.initialized) await this.initialize();
    if (!this.chosen) throw new Error("OCR not initialized");

    const ordered = [
      this.chosen,
      ...this.backends.filter((b) => b !== this.chosen),
    ];
    let lastError: unknown = null;
    for (const backend of ordered) {
      try {
        if (backend.name === "doctr" && backend instanceof DoctrBackend) {
          await backend.initialize();
        }
        return await backend.extractText(imageBuffer);
      } catch (error) {
        lastError = error;
        logger.warn(
          `[OCR] backend ${backend.name} failed:`,
          error instanceof Error ? error.message : error,
        );
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

  /**
   * Structured data extraction (tables / forms / lists) is not implemented in
   * the doCTR path yet — the previous tesseract-based implementation owned
   * this surface. Returns an empty result so callers don't break; structured
   * extraction is a follow-up that will live in a separate post-process
   * module (it's pure geometry, not model output).
   */
  async extractStructuredData(_imageBuffer: Buffer): Promise<{
    tables?: Array<{ rows: string[][]; bbox: BoundingBox }>;
    forms?: Array<{ label: string; value: string; bbox: BoundingBox }>;
    lists?: Array<{ items: string[]; bbox: BoundingBox }>;
  }> {
    if (!this.initialized) await this.initialize();
    return { tables: [], forms: [], lists: [] };
  }

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
