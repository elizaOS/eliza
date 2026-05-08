import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FRAME_FILE } from "@elizaos/plugin-browser/workspace/browser-capture";
import { logger } from "@elizaos/core";
import sharp from "sharp";

export type LifeOpsScreenFocus =
  | "work"
  | "leisure"
  | "transition"
  | "idle"
  | "unknown";

export type LifeOpsScreenSource = "disabled" | "browser-capture" | "vision";

export interface LifeOpsScreenContextSummary {
  sampledAtMs: number;
  source: LifeOpsScreenSource;
  available: boolean;
  throttled: boolean;
  stale: boolean;
  busy: boolean;
  framePath: string;
  capturedAtMs: number | null;
  width: number | null;
  height: number | null;
  byteLength: number;
  averageLuma: number | null;
  lumaStdDev: number | null;
  ocrAvailable: boolean;
  ocrText: string | null;
  focus: LifeOpsScreenFocus;
  contextTags: string[];
  cues: string[];
  confidence: number;
  disabledReason: string | null;
}

export interface LifeOpsScreenOcrAdapter {
  extractText(imageBuffer: Buffer): Promise<string | null>;
}

export interface LifeOpsScreenContextSamplerOptions {
  framePath?: string;
  minSampleIntervalMs?: number;
  maxFrameAgeMs?: number;
  ocr?: LifeOpsScreenOcrAdapter | null;
}

const DEFAULT_MIN_SAMPLE_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_FRAME_AGE_MS = 30 * 60_000;
const HEURISTIC_TEXT_LIMIT = 1_024;
const WORK_KEYWORDS = [
  "inbox",
  "email",
  "calendar",
  "meeting",
  "docs",
  "document",
  "spreadsheet",
  "sheet",
  "slack",
  "discord",
  "github",
  "pull request",
  "jira",
  "terminal",
  "code",
  "editor",
  "notion",
  "figma",
];
const LEISURE_KEYWORDS = [
  "youtube",
  "netflix",
  "twitch",
  "instagram",
  "twitter",
  "x.com",
  "reddit",
  "game",
  "gaming",
  "spotify",
];

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : String(error);
}

function isMissingOptionalVisionImport(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ERR_MODULE_NOT_FOUND" ||
      (error as { code?: unknown }).code === "MODULE_NOT_FOUND")
  );
}
const TRANSITION_KEYWORDS = [
  "lock screen",
  "login",
  "sign in",
  "password",
  "desktop",
  "wallpaper",
  "home screen",
  "launchpad",
];

type ImageStats = {
  width: number;
  height: number;
  averageLuma: number;
  lumaStdDev: number;
  darkRatio: number;
  brightRatio: number;
  edgeRatio: number;
};

function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, HEURISTIC_TEXT_LIMIT);
}

function keywordMatches(text: string, keywords: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((keyword) => lower.includes(keyword));
}

async function analyzeImage(buffer: Buffer): Promise<ImageStats> {
  const image = sharp(buffer).rotate().greyscale().resize({
    width: 160,
    withoutEnlargement: true,
    fit: "inside",
  });
  const { data, info } = await image
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = data;
  let sum = 0;
  let sumSquares = 0;
  let dark = 0;
  let bright = 0;
  let edges = 0;
  let comparisons = 0;

  for (let index = 0; index < pixels.length; index += 1) {
    const value = pixels[index] ?? 0;
    sum += value;
    sumSquares += value * value;
    if (value < 32) dark += 1;
    if (value > 224) bright += 1;
    const left = pixels[index - 1];
    if (left !== undefined) {
      const diff = Math.abs(value - left);
      if (diff > 28) edges += 1;
      comparisons += 1;
    }
  }

  const count = Math.max(1, pixels.length);
  const averageLuma = sum / count / 255;
  const variance = sumSquares / count - (sum / count) ** 2;
  const lumaStdDev = Math.sqrt(Math.max(0, variance)) / 255;

  return {
    width: info.width ?? 0,
    height: info.height ?? 0,
    averageLuma,
    lumaStdDev,
    darkRatio: dark / count,
    brightRatio: bright / count,
    edgeRatio: comparisons > 0 ? edges / comparisons : 0,
  };
}

function inferFocusFromSignals(args: {
  text: string | null;
  stats: ImageStats;
}): {
  focus: LifeOpsScreenFocus;
  contextTags: string[];
  cues: string[];
  confidence: number;
  busy: boolean;
} {
  const normalizedText = normalizeText(args.text);
  const workCues = keywordMatches(normalizedText, WORK_KEYWORDS);
  const leisureCues = keywordMatches(normalizedText, LEISURE_KEYWORDS);
  const transitionCues = keywordMatches(normalizedText, TRANSITION_KEYWORDS);
  const cues = [...workCues, ...leisureCues, ...transitionCues];
  const tags = new Set<string>();
  let focus: LifeOpsScreenFocus = "unknown";
  let confidence = 0.28;

  if (workCues.length > 0) {
    focus = "work";
    confidence = 0.86;
    tags.add("work");
    tags.add("text-heavy");
  } else if (leisureCues.length > 0) {
    focus = "leisure";
    confidence = 0.84;
    tags.add("leisure");
    tags.add("screen-entertainment");
  } else if (transitionCues.length > 0) {
    focus = "transition";
    confidence = 0.78;
    tags.add("transition");
  }

  if (focus === "unknown") {
    if (args.stats.darkRatio > 0.92 && args.stats.lumaStdDev < 0.025) {
      focus = "idle";
      confidence = 0.72;
      tags.add("idle");
    } else if (args.stats.brightRatio > 0.92 && args.stats.lumaStdDev < 0.025) {
      focus = "transition";
      confidence = 0.66;
      tags.add("transition");
    } else if (
      args.stats.edgeRatio > 0.08 &&
      args.stats.averageLuma > 0.18 &&
      args.stats.averageLuma < 0.88
    ) {
      focus = "work";
      confidence = 0.52;
      tags.add("busy");
      tags.add("text-or-ui-dense");
    }
  }

  if (focus === "idle") {
    tags.add("idle");
  } else if (focus === "unknown") {
    tags.add("uncertain");
  } else {
    tags.add("screen-active");
  }

  return {
    focus,
    contextTags: [...tags],
    cues,
    confidence,
    busy: focus === "work" || focus === "transition",
  };
}

async function readOcrText(
  ocr: LifeOpsScreenOcrAdapter | null | undefined,
  frameBytes: Buffer,
): Promise<string | null> {
  if (!ocr) {
    return null;
  }
  try {
    const text = await ocr.extractText(frameBytes);
    return normalizeText(text) || null;
  } catch {
    return null;
  }
}

function buildDisabledSummary(args: {
  sampledAtMs: number;
  framePath: string;
  disabledReason: string;
}): LifeOpsScreenContextSummary {
  return {
    sampledAtMs: args.sampledAtMs,
    source: "disabled",
    available: false,
    throttled: false,
    stale: false,
    busy: false,
    framePath: args.framePath,
    capturedAtMs: null,
    width: null,
    height: null,
    byteLength: 0,
    averageLuma: null,
    lumaStdDev: null,
    ocrAvailable: false,
    ocrText: null,
    focus: "unknown",
    contextTags: ["disabled"],
    cues: [],
    confidence: 0,
    disabledReason: args.disabledReason,
  };
}

export async function analyzeLifeOpsScreenBuffer(args: {
  framePath: string;
  frameBytes: Buffer;
  ocrText: string | null;
  capturedAtMs: number;
  sampledAtMs: number;
  stale: boolean;
}): Promise<LifeOpsScreenContextSummary> {
  const stats = await analyzeImage(args.frameBytes);
  const inference = inferFocusFromSignals({
    text: args.ocrText,
    stats,
  });
  return {
    sampledAtMs: args.sampledAtMs,
    source: args.ocrText ? "vision" : "browser-capture",
    available: !args.stale,
    throttled: false,
    stale: args.stale,
    busy: !args.stale && inference.busy,
    framePath: args.framePath,
    capturedAtMs: args.capturedAtMs,
    width: stats.width,
    height: stats.height,
    byteLength: args.frameBytes.byteLength,
    averageLuma: stats.averageLuma,
    lumaStdDev: stats.lumaStdDev,
    ocrAvailable: Boolean(args.ocrText && args.ocrText.length > 0),
    ocrText: normalizeText(args.ocrText) || null,
    focus: args.stale ? "unknown" : inference.focus,
    contextTags: args.stale ? ["stale-frame"] : inference.contextTags,
    cues: args.stale ? [] : inference.cues,
    confidence: args.stale ? 0.2 : inference.confidence,
    disabledReason: args.stale
      ? "The latest browser-capture frame is stale."
      : null,
  };
}

export class LifeOpsScreenContextSampler {
  private lastSampleAtMs = 0;
  private lastSummary: LifeOpsScreenContextSummary | null = null;

  constructor(
    private readonly options: LifeOpsScreenContextSamplerOptions = {},
  ) {}

  shouldSample(nowMs = Date.now()): boolean {
    const minIntervalMs =
      this.options.minSampleIntervalMs ?? DEFAULT_MIN_SAMPLE_INTERVAL_MS;
    return (
      this.lastSampleAtMs === 0 || nowMs - this.lastSampleAtMs >= minIntervalMs
    );
  }

  getLastSummary(): LifeOpsScreenContextSummary | null {
    return this.lastSummary;
  }

  async sample(nowMs = Date.now()): Promise<LifeOpsScreenContextSummary> {
    if (!this.shouldSample(nowMs) && this.lastSummary) {
      return {
        ...this.lastSummary,
        throttled: true,
        sampledAtMs: nowMs,
      };
    }

    const framePath = this.options.framePath ?? FRAME_FILE;
    const maxFrameAgeMs =
      this.options.maxFrameAgeMs ?? DEFAULT_MAX_FRAME_AGE_MS;

    if (!fs.existsSync(framePath)) {
      const summary = buildDisabledSummary({
        sampledAtMs: nowMs,
        framePath,
        disabledReason: "No browser-capture frame is available.",
      });
      this.lastSampleAtMs = nowMs;
      this.lastSummary = summary;
      return summary;
    }

    try {
      const stat = fs.statSync(framePath);
      const stale = nowMs - stat.mtimeMs > maxFrameAgeMs;
      const frameBytes = fs.readFileSync(framePath);
      const ocrText = await readOcrText(this.options.ocr, frameBytes);
      const summary = await analyzeLifeOpsScreenBuffer({
        framePath,
        frameBytes,
        ocrText,
        capturedAtMs: stat.mtimeMs,
        sampledAtMs: nowMs,
        stale,
      });

      this.lastSampleAtMs = nowMs;
      this.lastSummary = summary;
      return summary;
    } catch {
      const summary = buildDisabledSummary({
        sampledAtMs: nowMs,
        framePath,
        disabledReason: "Unable to read or analyze the browser-capture frame.",
      });
      this.lastSampleAtMs = nowMs;
      this.lastSummary = summary;
      return summary;
    }
  }
}

export async function tryCreateVisionOcrAdapter(): Promise<LifeOpsScreenOcrAdapter | null> {
  const localVisionOcrServiceUrl = pathToFileURL(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../plugins/plugin-vision/src/ocr-service.ts",
    ),
  ).href;
  const visionImportCandidates = [
    "@elizaos/plugin-vision",
    localVisionOcrServiceUrl,
  ];

  for (const specifier of visionImportCandidates) {
    try {
      const mod = await import(/* @vite-ignore */ specifier);
      const OCRService = mod.OCRService as
        | (new () => {
            initialize(): Promise<void>;
            extractText(
              imageBuffer: Buffer,
            ): Promise<{ fullText?: string; text?: string }>;
          })
        | undefined;
      if (!OCRService) {
        continue;
      }

      const service = new OCRService();
      if (typeof service.initialize === "function") {
        await service.initialize();
      }

      return {
        async extractText(imageBuffer: Buffer): Promise<string | null> {
          const result = await service.extractText(imageBuffer);
          return normalizeText(result.fullText ?? result.text ?? null) || null;
        },
      };
    } catch (error) {
      if (!isMissingOptionalVisionImport(error)) {
        logger.warn(
          `[LifeOpsScreenContext] vision OCR adapter unavailable for ${specifier}: ${errorMessage(error)}`,
        );
      }
    }
  }

  return null;
}
