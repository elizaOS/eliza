/**
 * WS7 — Actor (optional fine-grained grounding).
 *
 * The Actor is responsible for converting a Brain-issued reference
 * ("click the Save button I see in this crop") into concrete display-local
 * pixel coords.
 *
 * Primary path — deterministic (no model):
 *   `OcrCoordinateGroundingActor` resolves a `ref: "t<displayId>-<seq>"`
 *   (OCR id) or `ref: "a<displayId>-<seq>"` (AX id) directly from the
 *   Scene. Click point is bbox-center. No VLM call, fully reproducible,
 *   what 99% of the cascade should use.
 *
 * Optional secondary path — VLM:
 *   `OsAtlasProActor` is a typed adapter stub for a model-server endpoint
 *   (e.g. an OS-Atlas-Pro vLLM service). Until that endpoint exists in the
 *   Milady deployment it stays unregistered and the cascade falls back to
 *   the OCR/AX grounding above.
 *
 * Register the active Actor on the cascade via `setActor(actor)` (see
 * `cascade.ts`). If none is registered, the cascade uses the OCR/AX actor
 * automatically.
 */

import type { Scene, SceneAxNode, SceneOcrBox } from "../scene/scene-types.js";
import type { GroundingResult, ReferenceTarget } from "./types.js";

export interface ActorGroundArgs {
  /** Display the Brain wants to act on. */
  displayId: number;
  /**
   * Cropped image of the ROI at native resolution (PNG bytes). May be a
   * placeholder Buffer when the deterministic grounding doesn't need it.
   */
  croppedImage: Buffer;
  /** Hint from the Brain: "the Save button in the dialog footer". */
  hint: string;
  /** Optional reference from `BrainProposedAction.ref`. */
  ref?: string;
}

export interface Actor {
  readonly name: string;
  ground(args: ActorGroundArgs): Promise<GroundingResult>;
}

/* ── deterministic OCR/AX grounding (primary) ──────────────────────────── */

export class OcrCoordinateGroundingActor implements Actor {
  readonly name = "ocr-ax-grounding";

  constructor(private readonly getScene: () => Scene | null) {}

  async ground(args: ActorGroundArgs): Promise<GroundingResult> {
    const scene = this.getScene();
    if (!scene) {
      throw new Error(
        `[computeruse/actor] cannot ground without a current scene (ref=${args.ref ?? "?"})`,
      );
    }
    const target = resolveReference(scene, args.ref, args.hint, args.displayId);
    if (!target) {
      throw new Error(
        `[computeruse/actor] no OCR/AX target matched ref=${args.ref ?? "?"} hint=${JSON.stringify(args.hint)} on display ${args.displayId}`,
      );
    }
    const [x, y, w, h] = target.bbox;
    return {
      displayId: target.displayId,
      x: Math.round(x + w / 2),
      y: Math.round(y + h / 2),
      confidence: 1,
      reason: `Matched ${target.kind} id=${describe(target)} bbox=[${x},${y},${w},${h}]`,
    };
  }
}

/**
 * Look up a scene element by stable id, OR by case-insensitive label match
 * when an id is absent. Used by both the deterministic actor and the cascade
 * dispatcher to validate Brain output.
 */
export function resolveReference(
  scene: Scene,
  ref: string | undefined,
  hint: string,
  preferredDisplay: number,
): ReferenceTarget | null {
  if (ref) {
    // OCR id format: t<displayId>-<seq>
    const ocrMatch = scene.ocr.find((b) => b.id === ref);
    if (ocrMatch) return toOcrTarget(ocrMatch);
    // AX id format: a<displayId>-<seq>
    const axMatch = scene.ax.find((n) => n.id === ref);
    if (axMatch) return toAxTarget(axMatch);
  }
  // Fall back to hint-based label match. Prefer the requested display.
  const lc = hint.trim().toLowerCase();
  if (lc.length === 0) return null;
  const ocrCandidates = scene.ocr
    .filter((b) => b.text.toLowerCase().includes(lc))
    .sort(
      (a, b) =>
        preferenceScore(b, preferredDisplay) -
        preferenceScore(a, preferredDisplay),
    );
  const bestOcr = ocrCandidates[0];
  if (bestOcr) return toOcrTarget(bestOcr);
  const axCandidates = scene.ax
    .filter((n) => (n.label ?? "").toLowerCase().includes(lc))
    .sort(
      (a, b) =>
        preferenceScoreAx(b, preferredDisplay) -
        preferenceScoreAx(a, preferredDisplay),
    );
  const bestAx = axCandidates[0];
  if (bestAx) return toAxTarget(bestAx);
  return null;
}

function toOcrTarget(box: SceneOcrBox): ReferenceTarget {
  return {
    displayId: box.displayId,
    bbox: box.bbox,
    kind: "ocr",
    label: box.text,
    source: box,
  };
}

function toAxTarget(node: SceneAxNode): ReferenceTarget {
  return {
    displayId: node.displayId,
    bbox: node.bbox,
    kind: "ax",
    label: node.label ?? node.role,
    source: node,
  };
}

function preferenceScore(box: SceneOcrBox, preferredDisplay: number): number {
  return (box.displayId === preferredDisplay ? 1000 : 0) + box.conf;
}

function preferenceScoreAx(
  node: SceneAxNode,
  preferredDisplay: number,
): number {
  const area = (node.bbox[2] ?? 0) * (node.bbox[3] ?? 0);
  return (node.displayId === preferredDisplay ? 1_000_000 : 0) + area;
}

function describe(target: ReferenceTarget): string {
  return target.kind === "ocr"
    ? (target.source as SceneOcrBox).id
    : (target.source as SceneAxNode).id;
}

/* ── optional VLM adapter stub ─────────────────────────────────────────── */

export interface OsAtlasProActorOptions {
  /** Endpoint of the model server, e.g. `http://localhost:8000/v1`. */
  endpoint: string;
  /** Optional auth header. */
  apiKey?: string;
  /** Model identifier on the server. */
  model?: string;
  /** Override the HTTP fetch (mostly for tests). */
  fetcher?: (
    input: string,
    init: { body: string; headers: Record<string, string> },
  ) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}

/**
 * Adapter for a server-side OS-Atlas-Pro (or compatible) grounding model.
 * Not wired into the cascade by default. The contract: POST a JSON payload
 * with `{ image: base64, hint }`, expect `{ x, y, confidence }` in image
 * coordinates of the crop. The cascade is responsible for converting those
 * crop-local coords back to display-local before dispatch.
 */
export class OsAtlasProActor implements Actor {
  readonly name = "osatlas-pro";

  constructor(private readonly opts: OsAtlasProActorOptions) {
    if (!opts.endpoint) {
      throw new Error(
        "[computeruse/actor] OsAtlasProActor requires an endpoint",
      );
    }
  }

  async ground(args: ActorGroundArgs): Promise<GroundingResult> {
    const body = JSON.stringify({
      image: args.croppedImage.toString("base64"),
      hint: args.hint,
      ref: args.ref,
      model: this.opts.model,
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const fetcher =
      this.opts.fetcher ??
      (async (url, init) => {
        const resp = await fetch(url, {
          method: "POST",
          body: init.body,
          headers: init.headers,
        });
        return { ok: resp.ok, status: resp.status, text: () => resp.text() };
      });
    const resp = await fetcher(this.opts.endpoint, { body, headers });
    if (!resp.ok) {
      throw new Error(
        `[computeruse/actor] osatlas-pro returned ${resp.status}: ${await resp.text()}`,
      );
    }
    const text = await resp.text();
    let parsed: { x?: number; y?: number; confidence?: number };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch (err) {
      throw new Error(
        `[computeruse/actor] osatlas-pro emitted non-JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") {
      throw new Error(
        `[computeruse/actor] osatlas-pro response missing (x, y): ${text}`,
      );
    }
    return {
      displayId: args.displayId,
      x: parsed.x,
      y: parsed.y,
      confidence:
        typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      reason: `osatlas-pro grounded ${args.ref ?? args.hint}`,
    };
  }
}
