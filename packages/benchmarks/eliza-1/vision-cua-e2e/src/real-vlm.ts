/**
 * Real-mode VLM wrapper for the vision-CUA E2E harness.
 *
 * Replaces `StubVlm` from `./stubs/stub-vlm.ts`. Both stages —
 * `describe(imageUrl, prompt)` and `ground(target, tile)` — go through the
 * same `runtime.useModel(IMAGE_DESCRIPTION, …)` slot, mirroring how
 * plugin-vision dispatches scene description and how the eliza-1 vision
 * grounding-prompt approach works against Qwen3.5-VL-style backends.
 *
 * The grounding step prompts the same handler with a constrained JSON-only
 * response asking for tile-local center coordinates of the target element.
 * If the model's response can't be parsed into integers we surface a
 * parse-failure (rather than fabricating a coordinate) so the trace
 * accurately reflects upstream behaviour.
 */

import type { RealRuntimeAdapter } from "./real-runtime.ts";
import type {
  GroundingRequest,
  GroundingResult,
  VlmDescribeRequest,
  VlmDescribeResult,
} from "./types.ts";

export interface RealVlmGroundingExtra {
  readonly tileWidth: number;
  readonly tileHeight: number;
}

const DESCRIBE_PROMPT_TEMPLATE = (taskJson: string): string =>
  [
    "You are a desktop-screenshot describer. Look at the image and write a single",
    "concise sentence summarising the focused window's chrome and visible buttons.",
    "Do not invent UI that isn't present.",
    "",
    `Task context: ${taskJson}`,
  ].join("\n");

const GROUND_PROMPT_TEMPLATE = (
  target: string,
  tileW: number,
  tileH: number,
): string =>
  [
    "You are a UI-grounding model. Look at the image (a screenshot tile of",
    `dimensions ${tileW}x${tileH} pixels) and locate this element:`,
    "",
    `  "${target}"`,
    "",
    "Reply with EXACTLY one line of JSON in this shape and nothing else:",
    `  {"x": <int 0..${tileW - 1}>, "y": <int 0..${tileH - 1}>, "w": <int>, "h": <int>}`,
    "",
    "x,y is the CENTER of the element in tile-local pixels. w,h is the bbox",
    "width/height in pixels. If the element is not visible, reply:",
    `  {"x": -1, "y": -1, "w": 0, "h": 0}`,
  ].join("\n");

export class RealVlm {
  constructor(private readonly adapter: RealRuntimeAdapter) {}

  async describe(req: VlmDescribeRequest): Promise<VlmDescribeResult> {
    const promptForModel = DESCRIBE_PROMPT_TEMPLATE(req.prompt);
    const result = await this.adapter.describeImage({
      imageUrl: req.imageUrl,
      prompt: promptForModel,
    });
    const description = result.description?.trim() ?? "";
    if (description.length === 0) {
      throw new Error(
        "[real-vlm] IMAGE_DESCRIPTION returned an empty description",
      );
    }
    return { description };
  }

  async ground(
    req: GroundingRequest,
    extra: RealVlmGroundingExtra,
    imageUrl: string,
  ): Promise<GroundingResult> {
    const prompt = GROUND_PROMPT_TEMPLATE(
      req.description,
      extra.tileWidth,
      extra.tileHeight,
    );
    const result = await this.adapter.describeImage({
      imageUrl,
      prompt,
    });
    const text = `${result.title ?? ""}\n${result.description ?? ""}`;
    const parsed = parseGroundingResponse(text);
    if (parsed.x < 0 || parsed.y < 0) {
      throw new Error(
        `[real-vlm] grounding model reported target not visible (raw="${text.slice(0, 200)}")`,
      );
    }
    const cx = clamp(parsed.x, 0, extra.tileWidth - 1);
    const cy = clamp(parsed.y, 0, extra.tileHeight - 1);
    const w = parsed.w > 0 ? parsed.w : 32;
    const h = parsed.h > 0 ? parsed.h : 32;
    return {
      tileLocalX: cx,
      tileLocalY: cy,
      tileWidth: extra.tileWidth,
      tileHeight: extra.tileHeight,
      tileId: req.tileId,
      displayId: req.displayId,
      bbox: {
        x: Math.max(0, cx - Math.floor(w / 2)),
        y: Math.max(0, cy - Math.floor(h / 2)),
        width: w,
        height: h,
      },
      rationale: `[real-vlm/${this.adapter.providerInfo.providerName}] ${text
        .slice(0, 160)
        .replace(/\s+/g, " ")}`,
    };
  }
}

interface ParsedGrounding {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Tolerant JSON extraction. Models occasionally wrap the response in prose or
 * fenced code blocks; we scan for the first `{ "x": … }` object.
 */
export function parseGroundingResponse(raw: string): ParsedGrounding {
  const match = raw.match(/\{[^{}]*"x"\s*:\s*-?\d+[^{}]*\}/);
  if (!match) {
    throw new Error(
      `[real-vlm] could not parse grounding JSON from response (raw="${raw.slice(0, 200)}")`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    throw new Error(
      `[real-vlm] grounding response was not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      } (raw="${match[0]}")`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("[real-vlm] grounding response was not an object");
  }
  const obj = parsed as Record<string, unknown>;
  const x = numberOrNaN(obj.x);
  const y = numberOrNaN(obj.y);
  const w = numberOrNaN(obj.w);
  const h = numberOrNaN(obj.h);
  if ([x, y].some((n) => Number.isNaN(n))) {
    throw new Error(
      `[real-vlm] grounding response missing x/y (got ${JSON.stringify(parsed)})`,
    );
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Number.isNaN(w) ? 0 : Math.round(w),
    h: Number.isNaN(h) ? 0 : Math.round(h),
  };
}

function numberOrNaN(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : Number.NaN;
  }
  return Number.NaN;
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
