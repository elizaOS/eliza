/**
 * WS7 — Brain (full-screen reasoning).
 *
 * Sends one image per display (each downscaled to ~1.3 MP, the local Gemma
 * vision / OS-Atlas image budget) to `runtime.useModel(IMAGE_DESCRIPTION, ...)`.
 * The model is prompted to emit a JSON `BrainOutput` describing:
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
 * Image policy (#9105): the compact scene already carries OCR text + AX boxes,
 * which can suffice to pick the next target, so the `"on-escalation"` policy
 * plans from that text-only context with NO image — routed through a TEXT model,
 * since every IMAGE_DESCRIPTION provider rejects an empty imageUrl — and
 * attaches the ~1.3 MP frame only when the planned target cannot be grounded
 * against the OCR/AX boxes. The DEFAULT is `"always"` (legacy: image on every
 * call) until a real-model CUA trajectory validates imageless planning accuracy;
 * operators opt into `"on-escalation"` via the `COMPUTERUSE_BRAIN_IMAGE_POLICY`
 * setting. `"never"` never attaches pixels.
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
  logger,
  ModelType,
} from "@elizaos/core";
import type { DisplayCapture } from "../platform/capture.js";
import { frameDhash, hamming, pngDimensions } from "../scene/dhash.js";
import type { Scene } from "../scene/scene-types.js";
import { serializeSceneForPrompt } from "../scene/serialize.js";
import { resolveReference } from "./actor.js";
import type { BrainOutput, BrainProposedAction, BrainRoi } from "./types.js";

export const BRAIN_MAX_PIXELS = 1_310_720; // 1280 * 32 * 32 ≈ 1.3 MP cap
export const BRAIN_MAX_ROIS = 2;
/** Bound on the per-Brain dHash→BrainOutput cache (LRU-ish, oldest evicted). */
export const BRAIN_DHASH_CACHE_MAX = 16;
/**
 * dHash Hamming threshold for cached-plan reuse (#9581 continuous-understanding
 * tuning). Exact-equality (distance 0) re-burned the IMAGE_DESCRIPTION model on
 * cosmetically-identical frames — cursor jitter, a blinking caret, anti-aliasing,
 * and tiny scroll noise all flip a few dHash bits.
 *
 * This mirrors `SCREEN_STATE_HAMMING_THRESHOLD`: distances below the threshold
 * are unchanged; distances at or above it are changed and must re-plan.
 */
export const BRAIN_DHASH_HAMMING_THRESHOLD = 5;
/**
 * Image-token estimate per source pixel for the local Gemma vision / OS-Atlas
 * budget: one visual token ≈ a 28×28 (≈750 px) patch. Used only to quantify
 * the saving when a frame is *not* attached (#9105).
 */
export const BRAIN_PIXELS_PER_IMAGE_TOKEN = 750;

/**
 * When to attach the raw screenshot to the planning model (#9105):
 *   - `"always"`     — attach the pixels on every call (legacy behaviour). Default.
 *   - `"on-escalation"` — plan from the compact OCR/AX scene with no image
 *                         first (routed through a TEXT model); attach pixels
 *                         only when the planned target cannot be grounded
 *                         against the OCR/AX boxes or a strict-retry fires.
 *   - `"never"`      — never attach the screenshot; plan from the scene alone.
 */
export type BrainImagePolicy = "always" | "on-escalation" | "never";

/**
 * Default is `"always"` (proven legacy behaviour). `"on-escalation"` cuts the
 * dominant per-frame image-token cost but plans the first pass blind to the
 * pixels, so it stays opt-in (via the `COMPUTERUSE_BRAIN_IMAGE_POLICY` runtime
 * setting / env var) until a real-model CUA trajectory validates its accuracy.
 */
export const DEFAULT_BRAIN_IMAGE_POLICY: BrainImagePolicy = "always";

/**
 * Resolve the Brain image policy from the `COMPUTERUSE_BRAIN_IMAGE_POLICY`
 * runtime setting / env var, falling back to {@link DEFAULT_BRAIN_IMAGE_POLICY}.
 * The operator escape hatch to enable imageless planning without a code change
 * once it is validated against a real model.
 */
export function resolveBrainImagePolicy(
  runtime: IAgentRuntime | null,
): BrainImagePolicy {
  const raw = runtime?.getSetting?.("COMPUTERUSE_BRAIN_IMAGE_POLICY");
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : undefined;
  if (value === "always" || value === "on-escalation" || value === "never") {
    return value;
  }
  return DEFAULT_BRAIN_IMAGE_POLICY;
}

/** Token-accounting snapshot for a Brain instance (#9105 M3). */
export interface BrainStats {
  /** IMAGE_DESCRIPTION model calls actually issued. */
  invocations: number;
  /** Describe calls served from the frame-dHash cache (no model call). */
  cacheHits: number;
  /**
   * Model calls issued with NO screenshot attached (the scene's OCR/AX text
   * sufficed). Each one saved roughly one full-frame image's worth of tokens.
   */
  imagelessCalls: number;
  /**
   * Estimated image tokens NOT sent because of imageless calls — the sum of
   * `(width * height) / BRAIN_PIXELS_PER_IMAGE_TOKEN` over every imageless
   * call, capped per frame at `BRAIN_MAX_PIXELS`.
   */
  estImageTokensSaved: number;
}

/**
 * Action kinds whose dispatch needs a grounded display-local coordinate. For
 * these, an imageless plan is only safe when its `ref`/rationale resolves to an
 * OCR/AX box; otherwise the Brain escalates to the pixels. The remaining kinds
 * (type/hotkey/key/wait/finish) carry everything in their args.
 */
const COORDINATE_ACTION_KINDS: ReadonlySet<BrainProposedAction["kind"]> =
  new Set(["click", "double_click", "right_click", "scroll", "drag"]);

function sceneCacheSignature(scene: Scene): string {
  return JSON.stringify({
    displays: scene.displays.map((display) => ({
      id: display.id,
      name: display.name,
      bounds: display.bounds,
      primary: display.primary,
      scaleFactor: display.scaleFactor,
    })),
    focused_window: scene.focused_window,
    apps: scene.apps.map((app) => ({
      name: app.name,
      pid: app.pid,
      windows: app.windows.map((window) => ({
        id: window.id,
        title: window.title,
        bounds: window.bounds,
        displayId: window.displayId,
      })),
    })),
    ocr: scene.ocr.map((box) => ({
      id: box.id,
      text: box.text,
      bbox: box.bbox,
      conf: Number(box.conf.toFixed(3)),
      displayId: box.displayId,
    })),
    ax: scene.ax.map((node) => ({
      id: node.id,
      role: node.role,
      label: node.label,
      bbox: node.bbox,
      actions: node.actions,
      displayId: node.displayId,
    })),
    vlm_scene: scene.vlm_scene,
    vlm_elements: scene.vlm_elements,
  });
}

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
  /**
   * When to attach the raw screenshot to the planning model (#9105). Defaults
   * to `"always"` (legacy); see {@link resolveBrainImagePolicy} for the
   * operator opt-in to `"on-escalation"`.
   */
  imagePolicy?: BrainImagePolicy;
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
  /**
   * Frame-dHash → BrainOutput cache. The WS2 MemoryArbiter only dedups the
   * IMAGE_DESCRIPTION call for LOCAL backends; the remote/cloud path bypasses
   * it, so an identical screen re-burns tokens every step. This call-site cache
   * skips the model entirely when the same frame is observed for the same goal,
   * cutting the dominant CUA-loop token cost regardless of backend (#9105 M3).
   */
  private readonly dhashCache: Array<{
    dh: bigint;
    goal: string;
    sceneSignature: string;
    output: BrainOutput;
  }> = [];
  private readonly imagePolicy: BrainImagePolicy;
  private invocations = 0;
  private cacheHits = 0;
  private imagelessCalls = 0;
  private estImageTokensSaved = 0;

  constructor(
    private readonly runtime: IAgentRuntime | null,
    private readonly deps: BrainDeps = {},
  ) {
    this.imagePolicy = deps.imagePolicy ?? DEFAULT_BRAIN_IMAGE_POLICY;
  }

  /** Token-accounting snapshot (model calls, cache hits, imageless savings). */
  getStats(): BrainStats {
    return {
      invocations: this.invocations,
      cacheHits: this.cacheHits,
      imagelessCalls: this.imagelessCalls,
      estImageTokensSaved: this.estImageTokensSaved,
    };
  }

  private cacheKey(
    frame: Buffer,
    goal: string,
    sceneSignature: string,
  ): { dh: bigint; goal: string; sceneSignature: string } | null {
    const dh = frameDhash(frame);
    return dh === null ? null : { dh, goal, sceneSignature };
  }

  /**
   * Return a cached plan for the same goal whose frame is within
   * `BRAIN_DHASH_HAMMING_THRESHOLD` bits of `dh` — a near-identical screen, not
   * just a byte-identical one. On a hit the entry is moved to the end (LRU), so
   * a steadily-evolving screen keeps its most-recent close match warm.
   */
  private findCached(
    dh: bigint,
    goal: string,
    sceneSignature: string,
  ): BrainOutput | null {
    for (let i = this.dhashCache.length - 1; i >= 0; i--) {
      const entry = this.dhashCache[i]!;
      if (
        entry.goal === goal &&
        entry.sceneSignature === sceneSignature &&
        hamming(entry.dh, dh) < BRAIN_DHASH_HAMMING_THRESHOLD
      ) {
        this.dhashCache.splice(i, 1);
        this.dhashCache.push(entry);
        return entry.output;
      }
    }
    return null;
  }

  private rememberOutput(
    key: { dh: bigint; goal: string; sceneSignature: string } | null,
    output: BrainOutput,
  ): BrainOutput {
    if (key) {
      // Evict oldest to bound memory.
      if (this.dhashCache.length >= BRAIN_DHASH_CACHE_MAX) {
        this.dhashCache.shift();
      }
      this.dhashCache.push({
        dh: key.dh,
        goal: key.goal,
        sceneSignature: key.sceneSignature,
        output,
      });
    }
    return output;
  }

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

    // Frame-dHash cache: a near-identical screen + same goal → reuse the prior
    // plan, skip the (possibly remote) IMAGE_DESCRIPTION call. Tolerant to a few
    // dHash bits so cosmetic churn (cursor, caret, anti-aliasing) still hits.
    const sceneSignature = sceneCacheSignature(input.scene);
    const key = this.cacheKey(targetCapture.frame, input.goal, sceneSignature);
    if (key) {
      const cached = this.findCached(key.dh, key.goal, key.sceneSignature);
      if (cached) {
        this.cacheHits += 1;
        return cached;
      }
    }

    const displayId = targetCapture.display.id;
    const tryParse = (raw: string): BrainOutput | null => {
      try {
        return parseBrainOutput(raw);
      } catch {
        // error-policy:J3 untrusted model output; null is the explicit
        // invalid signal that drives the escalation ladder (imageless →
        // pixels → strict prompt). Total failure throws BrainParseError.
        return null;
      }
    };
    const lightPrompt = brainPromptFor(
      compactScene,
      input.goal,
      /*strict*/ false,
    );
    const strictPrompt = brainPromptFor(
      compactScene,
      input.goal,
      /*strict*/ true,
    );

    // ── Pass 1: plan from the compact OCR/AX scene with NO image, unless the
    // policy demands the pixels up front (#9105). The compact scene already
    // carries the OCR text + AX boxes the planner needs to pick a target.
    if (this.imagePolicy !== "always") {
      this.invocations += 1;
      let imageless: string | ImageDescriptionResult | null = null;
      try {
        imageless = await this.invoke({
          imageUrl: "",
          prompt: lightPrompt,
          displayId,
        });
      } catch (err) {
        // "never" has no pixels to fall back to — surface the failure.
        if (this.imagePolicy === "never") throw err;
        // Otherwise degrade to the escalation (pixels) path rather than crash
        // the whole CUA loop if the text model is unavailable.
        logger.debug(
          `[computeruse/brain] imageless planning pass failed (${
            err instanceof Error ? err.message : String(err)
          }); escalating to pixels`,
        );
      }
      if (imageless !== null) {
        const parsedImageless = tryParse(extractText(imageless));
        if (parsedImageless) {
          const capped = enforceCaps(parsedImageless);
          // Keep the imageless plan when its target is grounded against the
          // OCR/AX boxes (or it needs no coordinate at all), OR when the policy
          // forbids ever attaching pixels. Otherwise fall through to escalation.
          if (
            this.imagePolicy === "never" ||
            this.resolvesWithoutImage(input.scene, capped)
          ) {
            this.recordImageless(targetCapture.frame);
            return this.rememberOutput(key, capped);
          }
        } else if (this.imagePolicy === "never") {
          // No pixels available to escalate to — strict-retry imageless once.
          this.invocations += 1;
          const strictImageless = await this.invoke({
            imageUrl: "",
            prompt: strictPrompt,
            displayId,
          });
          const rawStrict = extractText(strictImageless);
          const parsedStrict = tryParse(rawStrict);
          if (parsedStrict) {
            this.recordImageless(targetCapture.frame);
            return this.rememberOutput(key, enforceCaps(parsedStrict));
          }
          throw new BrainParseError(
            "Brain output is not valid JSON conforming to BrainOutput after retry",
            rawStrict,
          );
        }
      }
    }

    // ── Escalation: attach the pixels. Either policy === "always", or the
    // imageless plan could not be grounded / parsed. The existing encode +
    // strict-retry path runs from here unchanged.
    const dataUrl = await encodeForBrain(targetCapture.frame);
    this.invocations += 1;
    const first = await this.invoke({
      imageUrl: dataUrl,
      prompt: lightPrompt,
      displayId,
    });
    const parsed = tryParse(extractText(first));
    if (parsed) return this.rememberOutput(key, enforceCaps(parsed));
    // Strict retry — same image, stricter prompt.
    this.invocations += 1;
    const second = await this.invoke({
      imageUrl: dataUrl,
      prompt: strictPrompt,
      displayId,
    });
    const rawSecond = extractText(second);
    const parsedRetry = tryParse(rawSecond);
    if (parsedRetry) return this.rememberOutput(key, enforceCaps(parsedRetry));
    throw new BrainParseError(
      "Brain output is not valid JSON conforming to BrainOutput after retry",
      rawSecond,
    );
  }

  /**
   * True when the imageless plan needs no screenshot to dispatch: a
   * non-coordinate action (type/hotkey/key/wait/finish) carries everything in
   * its args, and a coordinate action is fine when its `ref`/rationale resolves
   * to a concrete OCR/AX box. When the target cannot be grounded we escalate to
   * the pixels — correctness over token saving.
   */
  private resolvesWithoutImage(scene: Scene, output: BrainOutput): boolean {
    const action: BrainProposedAction = output.proposed_action;
    if (!COORDINATE_ACTION_KINDS.has(action.kind)) return true;
    return (
      resolveReference(
        scene,
        action.ref,
        action.rationale,
        output.target_display_id,
      ) !== null
    );
  }

  private recordImageless(frame: Buffer): void {
    this.imagelessCalls += 1;
    this.estImageTokensSaved += estimateImageTokens(frame);
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
        "[computeruse/brain] no runtime + no invokeModel override; cannot call the planning model",
      );
    }
    // Imageless planning (#9105): with no pixels to describe, route the
    // text-only plan through a TEXT model. The compact OCR/AX scene is already
    // in the prompt, and every IMAGE_DESCRIPTION provider (local-inference,
    // anthropic, …) hard-rejects an empty imageUrl, so an empty frame must NOT
    // be sent there.
    if (args.imageUrl.length === 0) {
      return this.runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: args.prompt,
      });
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

/**
 * Estimate the visual tokens a frame would have cost the planning model, for
 * the "tokens saved by going imageless" telemetry (#9105). The backends apply a
 * `max_pixels` downscale, so the per-frame estimate is capped at
 * `BRAIN_MAX_PIXELS`. Falls back to the cap when the PNG header is unreadable —
 * an attached frame would have been downscaled to that ceiling regardless.
 */
export function estimateImageTokens(png: Buffer): number {
  const dims = pngDimensions(png);
  const pixels = dims
    ? Math.min(dims.width * dims.height, BRAIN_MAX_PIXELS)
    : BRAIN_MAX_PIXELS;
  return Math.round(pixels / BRAIN_PIXELS_PER_IMAGE_TOKEN);
}
