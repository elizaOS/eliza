/**
 * WS7 — Brain (full-screen reasoning).
 *
 * Sends one image per display (each downscaled to ~1.3 MP, the OS-Atlas /
 * Qwen3-VL `max_pixels` convention) to `runtime.useModel(IMAGE_DESCRIPTION,
 * ...)`. The model is prompted to emit a JSON `BrainOutput` describing:
 *   - the scene in one paragraph,
 *   - which display to act on,
 *   - up to N ROIs the Actor should zoom into,
 *   - a single proposed action with rationale.
 *
 * The Brain itself doesn't dispatch — it just produces `BrainOutput`. The
 * cascade ("ScreenSeekeR") is the orchestrator that takes a `BrainOutput`,
 * optionally calls the Actor on cropped ROIs, and produces a concrete
 * `ProposedAction` for the dispatcher.
 *
 * Image transport contract: we pass `imageUrl` as a `data:image/png;base64,...`
 * URL. The WS2 MemoryArbiter intercepts at `ModelType.IMAGE_DESCRIPTION` and
 * routes through its content-hash cache, so identical frames don't burn
 * inference budget twice.
 *
 * Parse strictness:
 *   - We try to parse the response as JSON (either the literal string or
 *     `result.description`).
 *   - On first parse failure, retry once with a stricter prompt.
 *   - On second failure, throw `BrainParseError` — the cascade surfaces this
 *     as a structured `ActionResult.error` and aborts the turn cleanly.
 */

import {
  type IAgentRuntime,
  type ImageDescriptionResult,
  ModelType,
} from "@elizaos/core";
import type { DisplayCapture } from "../platform/capture.js";
import type { Scene } from "../scene/scene-types.js";
import { serializeSceneForPrompt } from "../scene/serialize.js";
import type { BrainOutput, BrainRoi } from "./types.js";

export const BRAIN_MAX_PIXELS = 1_310_720; // 1280 * 32 * 32 ≈ 1.3 MP cap
export const BRAIN_MAX_ROIS = 2;

export class BrainParseError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = "BrainParseError";
  }
}

export interface BrainDeps {
  /** Optional override for tests — bypasses runtime.useModel. */
  invokeModel?: (args: {
    imageUrl: string;
    prompt: string;
    displayId: number;
  }) => Promise<string | ImageDescriptionResult>;
}

export interface BrainInput {
  scene: Scene;
  goal: string;
  /**
   * Per-display capture buffers. If a display from `scene.displays` is
   * missing here, the Brain skips it. The cascade is responsible for
   * supplying these alongside the scene.
   */
  captures: Map<number, DisplayCapture>;
}

/**
 * Pure description of a "Brain" call. Created by `Cascade.runCascade` and
 * test fixtures.
 */
export class Brain {
  constructor(
    private readonly runtime: IAgentRuntime | null,
    private readonly deps: BrainDeps = {},
  ) {}

  async observeAndPlan(input: BrainInput): Promise<BrainOutput> {
    if (input.captures.size === 0) {
      throw new Error("[computeruse/brain] no captures supplied");
    }
    const compactScene = serializeSceneForPrompt(input.scene);
    const primaryDisplay =
      input.scene.focused_window?.displayId ??
      input.scene.displays.find((d) => d.primary)?.id ??
      input.scene.displays[0]?.id ??
      0;
    const targetCapture =
      input.captures.get(primaryDisplay) ??
      input.captures.values().next().value;
    if (!targetCapture) {
      throw new Error("[computeruse/brain] could not pick a target capture");
    }
    const dataUrl = await encodeForBrain(targetCapture.frame);
    const prompt = brainPromptFor(compactScene, input.goal, /*strict*/ false);
    const first = await this.invoke({
      imageUrl: dataUrl,
      prompt,
      displayId: targetCapture.display.id,
    });
    const tryParse = (raw: string): BrainOutput | null => {
      try {
        return parseBrainOutput(raw);
      } catch {
        return null;
      }
    };
    const rawFirst = extractText(first);
    const parsed = tryParse(rawFirst);
    if (parsed) return enforceCaps(parsed);
    // Strict retry — same image, stricter prompt.
    const strictPrompt = brainPromptFor(
      compactScene,
      input.goal,
      /*strict*/ true,
    );
    const second = await this.invoke({
      imageUrl: dataUrl,
      prompt: strictPrompt,
      displayId: targetCapture.display.id,
    });
    const rawSecond = extractText(second);
    const parsedRetry = tryParse(rawSecond);
    if (parsedRetry) return enforceCaps(parsedRetry);
    throw new BrainParseError(
      "Brain output is not valid JSON conforming to BrainOutput after retry",
      rawSecond,
    );
  }

  private async invoke(args: {
    imageUrl: string;
    prompt: string;
    displayId: number;
  }): Promise<string | ImageDescriptionResult> {
    if (this.deps.invokeModel) {
      return this.deps.invokeModel(args);
    }
    if (!this.runtime) {
      throw new Error(
        "[computeruse/brain] no runtime + no invokeModel override; cannot call IMAGE_DESCRIPTION",
      );
    }
    return this.runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
      imageUrl: args.imageUrl,
      prompt: args.prompt,
    });
  }
}

/* ── prompt + parser ───────────────────────────────────────────────────── */

export function brainPromptFor(
  compactSceneJson: string,
  goal: string,
  strict: boolean,
): string {
  const header = strict
    ? "You are the planning Brain inside an autonomous desktop agent. You MUST emit ONLY a JSON object — no prose, no markdown fence — matching the BrainOutput schema. Do not include any text before or after the JSON."
    : "You are the planning Brain inside an autonomous desktop agent. Decide the single next action that makes the most progress toward the goal.";
  return [
    header,
    "",
    `Goal: ${goal}`,
    "",
    "Current scene context (display-local coords):",
    compactSceneJson,
    "",
    "Schema:",
    "{",
    '  "scene_summary": "one short paragraph",',
    '  "target_display_id": number,',
    '  "roi": [',
    '    { "displayId": number, "bbox": [x, y, w, h], "reason": "why" }',
    "  ],",
    '  "proposed_action": {',
    '    "kind": "click|double_click|right_click|type|hotkey|key|scroll|drag|wait|finish",',
    '    "ref": "t<displayId>-<seq> or a<displayId>-<seq> (optional)",',
    '    "args": { ... action-specific keys ... },',
    '    "rationale": "why this action"',
    "  }",
    "}",
    "",
    `Cap ROIs to ${BRAIN_MAX_ROIS}. Use action kind "finish" when the goal is already accomplished, "wait" when the screen is mid-transition.`,
    strict
      ? "Return raw JSON. No fences, no commentary, no extra fields."
      : "Output JSON only (a single object). Markdown fences are optional but will be stripped.",
  ].join("\n");
}

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)\s*```/i;

export function parseBrainOutput(raw: string): BrainOutput {
  const trimmed = raw.trim();
  let body = trimmed;
  const fenceMatch = FENCE_RE.exec(trimmed);
  if (fenceMatch) {
    const fencedBody = fenceMatch[1];
    if (fencedBody === undefined) {
      throw new BrainParseError("Brain response markdown fence was empty", raw);
    }
    body = fencedBody.trim();
  }
  // Allow a leading prose paragraph by snipping to the first `{`.
  const firstBrace = body.indexOf("{");
  if (firstBrace > 0) body = body.slice(firstBrace);
  const lastBrace = body.lastIndexOf("}");
  if (lastBrace !== -1 && lastBrace < body.length - 1) {
    body = body.slice(0, lastBrace + 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new BrainParseError(
      `Brain response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      raw,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new BrainParseError("Brain response is not an object", raw);
  }
  const obj = parsed as Record<string, unknown>;
  const summary =
    typeof obj.scene_summary === "string" ? obj.scene_summary : "";
  const targetDisplay =
    typeof obj.target_display_id === "number" ? obj.target_display_id : 0;
  const rois = Array.isArray(obj.roi) ? obj.roi : [];
  const proposed = (obj.proposed_action ?? null) as Record<
    string,
    unknown
  > | null;
  if (!proposed || typeof proposed !== "object") {
    throw new BrainParseError("Brain response missing proposed_action", raw);
  }
  const kind = proposed.kind;
  if (typeof kind !== "string") {
    throw new BrainParseError(
      "proposed_action.kind missing or not a string",
      raw,
    );
  }
  const rationale =
    typeof proposed.rationale === "string" ? proposed.rationale : "";
  const ref = typeof proposed.ref === "string" ? proposed.ref : undefined;
  const args =
    proposed.args && typeof proposed.args === "object"
      ? (proposed.args as Record<string, unknown>)
      : undefined;
  const validated: BrainOutput = {
    scene_summary: summary,
    target_display_id: targetDisplay,
    roi: rois
      .map((r): BrainRoi | null => {
        if (!r || typeof r !== "object") return null;
        const ro = r as Record<string, unknown>;
        const bb = ro.bbox;
        if (!Array.isArray(bb) || bb.length !== 4) return null;
        const nums = bb.map((n) => Number(n));
        if (!nums.every((n) => Number.isFinite(n))) return null;
        const [x, y, width, height] = nums;
        if (
          x === undefined ||
          y === undefined ||
          width === undefined ||
          height === undefined
        ) {
          return null;
        }
        return {
          displayId:
            typeof ro.displayId === "number" ? ro.displayId : targetDisplay,
          bbox: [x, y, width, height],
          reason: typeof ro.reason === "string" ? ro.reason : "",
        };
      })
      .filter((x): x is BrainRoi => x !== null),
    proposed_action: {
      kind: kind as BrainOutput["proposed_action"]["kind"],
      ref,
      args,
      rationale,
    },
  };
  return validated;
}

function enforceCaps(out: BrainOutput): BrainOutput {
  if (out.roi.length > BRAIN_MAX_ROIS) {
    out.roi = out.roi.slice(0, BRAIN_MAX_ROIS);
  }
  return out;
}

function extractText(value: string | ImageDescriptionResult): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if (typeof value.description === "string") return value.description;
    if (typeof value.title === "string") return value.title;
  }
  return String(value);
}

/**
 * Encode a PNG buffer for transport to the IMAGE_DESCRIPTION model. We don't
 * resize here — `runtime.useModel` adapters (and any vLLM backends behind
 * them) handle the `max_pixels` downscale. The constant `BRAIN_MAX_PIXELS`
 * is exported for the cascade so it can crop ROIs at the right native
 * resolution before invoking the Actor.
 */
export async function encodeForBrain(png: Buffer): Promise<string> {
  return `data:image/png;base64,${png.toString("base64")}`;
}
