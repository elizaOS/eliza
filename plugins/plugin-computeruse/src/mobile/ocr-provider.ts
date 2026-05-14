/**
 * OCR provider chain — used by WS6 (scene-builder) and any other consumer
 * that needs text-from-image extraction.
 *
 * Defined here in plugin-computeruse so the mobile bridge can publish the
 * iOS Apple Vision implementation alongside the rest of the iOS surface.
 * WS6 will register additional providers (cloud, Tesseract fallback) and
 * pick a provider per-call via `selectOcrProvider`.
 *
 * Contract:
 *   - `name`         : stable string id for routing/telemetry.
 *   - `priority`     : higher wins when multiple providers report `available`.
 *   - `available()`  : cheap synchronous availability probe; the registry
 *                      caches the result for the process lifetime.
 *   - `recognize()`  : async OCR call. Throws on hard failures so callers can
 *                      fall back to the next provider; never returns empty
 *                      lines silently.
 */

import type {
  IosComputerUseBridge,
  VisionOcrLine,
  VisionOcrOptions,
  VisionOcrResult,
} from "./ios-bridge.js";

export interface OcrLine {
  readonly text: string;
  readonly confidence: number;
  readonly boundingBox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface OcrResult {
  readonly lines: readonly OcrLine[];
  readonly fullText: string;
  readonly elapsedMs: number;
  readonly providerName: string;
  readonly languagesUsed: readonly string[];
}

export interface OcrRecognizeOptions {
  readonly languages?: readonly string[];
  readonly recognitionLevel?: "fast" | "accurate";
  readonly minimumTextHeight?: number;
}

export interface OcrProvider {
  readonly name: string;
  readonly priority: number;
  available(): boolean;
  recognize(input: OcrInput, options?: OcrRecognizeOptions): Promise<OcrResult>;
}

/**
 * Image input. Either a base64-encoded PNG/JPEG or raw bytes. The provider
 * is responsible for normalizing into whatever its native side expects.
 */
export type OcrInput =
  | { readonly kind: "base64"; readonly data: string }
  | { readonly kind: "bytes"; readonly data: Uint8Array };

// ── Registry ─────────────────────────────────────────────────────────────────

const REGISTRY = new Map<string, OcrProvider>();

export function registerOcrProvider(provider: OcrProvider): void {
  REGISTRY.set(provider.name, provider);
}

export function unregisterOcrProvider(name: string): void {
  REGISTRY.delete(name);
}

export function listOcrProviders(): readonly OcrProvider[] {
  return [...REGISTRY.values()].sort((a, b) => b.priority - a.priority);
}

/**
 * Returns the highest-priority provider that reports `available()`. Throws if
 * none are available — callers must handle that explicitly rather than
 * silently degrading. WS6's scene-builder catches and reports.
 */
export function selectOcrProvider(): OcrProvider {
  for (const provider of listOcrProviders()) {
    if (provider.available()) return provider;
  }
  throw new Error(
    "No OCR provider available. Register at least one provider before calling selectOcrProvider().",
  );
}

// ── iOS Apple Vision provider ────────────────────────────────────────────────

/**
 * Builds an OcrProvider that delegates to the Capacitor `ComputerUse` plugin's
 * `visionOcr` method. Pass in a getter that lazily resolves the bridge so this
 * module stays free of Capacitor imports (which would break Node test runs).
 */
export function createIosVisionOcrProvider(
  getBridge: () => IosComputerUseBridge | null,
  options: { readonly priority?: number } = {},
): OcrProvider {
  return {
    name: "ios-apple-vision",
    priority: options.priority ?? 100,
    available(): boolean {
      return getBridge() !== null;
    },
    async recognize(input, recognizeOptions): Promise<OcrResult> {
      const bridge = getBridge();
      if (!bridge) {
        throw new Error(
          "ios-apple-vision provider invoked but Capacitor ComputerUse plugin is not registered.",
        );
      }
      const imageBase64 = toBase64(input);
      const visionOptions: VisionOcrOptions = {
        ...(recognizeOptions?.languages
          ? { languages: recognizeOptions.languages }
          : {}),
        ...(recognizeOptions?.recognitionLevel
          ? { recognitionLevel: recognizeOptions.recognitionLevel }
          : {}),
        ...(recognizeOptions?.minimumTextHeight !== undefined
          ? { minimumTextHeight: recognizeOptions.minimumTextHeight }
          : {}),
      };
      const result = await bridge.visionOcr({ imageBase64, options: visionOptions });
      if (!result.ok) {
        // Narrow to the failure arm explicitly — some consumer tsconfigs
        // run with `strict: false`, which disables discriminated-union
        // narrowing on `!result.ok` and surfaces TS2339 on `result.code`
        // / `result.message`. The runtime invariant is unchanged.
        const failure = result as Extract<typeof result, { ok: false }>;
        throw new Error(
          `ios-apple-vision OCR failed: ${failure.code} — ${failure.message}`,
        );
      }
      return mapVisionResult(result.data);
    },
  };
}

function toBase64(input: OcrInput): string {
  if (input.kind === "base64") return input.data;
  return uint8ArrayToBase64(input.data);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  // btoa is the only universal browser/Capacitor path.
  // eslint-disable-next-line no-undef
  return btoa(binary);
}

function mapVisionResult(result: VisionOcrResult): OcrResult {
  return {
    lines: result.lines.map(mapLine),
    fullText: result.fullText,
    elapsedMs: result.elapsedMs,
    providerName: "ios-apple-vision",
    languagesUsed: result.languagesUsed,
  };
}

function mapLine(line: VisionOcrLine): OcrLine {
  return {
    text: line.text,
    confidence: line.confidence,
    boundingBox: line.boundingBox,
  };
}

/**
 * Test helper. Drops every provider from the registry; callers re-register
 * in `beforeEach`.
 */
export function _resetOcrProvidersForTests(): void {
  REGISTRY.clear();
}
