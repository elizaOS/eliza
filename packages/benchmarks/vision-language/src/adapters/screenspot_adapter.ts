/**
 * ScreenSpot adapter.
 *
 * Benchmark: ScreenSpot — UI grounding across desktop, mobile, and web
 * screenshots. Most relevant for CUA / agent control tasks.
 *
 * Paper:   Cheng et al. 2024, "SeeClick: Harnessing GUI Grounding for Advanced
 *          Visual GUI Agents" (https://arxiv.org/abs/2401.10935). The
 *          ScreenSpot eval set is the grounding subset released alongside it.
 * Dataset: https://github.com/njucckevin/SeeClick — Apache-2.0. Full eval
 *          expects `SCREENSPOT_DATA_DIR` pointing at the cloned ScreenSpot
 *          dir with `screenspot_desktop.json`, `screenspot_mobile.json`,
 *          `screenspot_web.json`, and `screenspot_imgs/`.
 *
 * Sample shape: { id, imagePath, question (instruction),
 *   payload: { bbox: [x1,y1,x2,y2]; platform: "desktop"|"mobile"|"web" } }
 *
 * Scoring: 1 when the predicted click lies inside the target bbox (the
 * standard ScreenSpot metric), else 0. Predictions that include a bbox
 * (region grounders) fall back to IoU > 0.5.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clickHit, iouHit } from "../scorers/index.ts";
import type {
  BBox,
  BenchmarkAdapter,
  Prediction,
  Sample,
  VisionRuntime,
} from "../types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..", "..");

export interface ScreenSpotPayload {
  bbox: BBox;
  platform: "desktop" | "mobile" | "web";
}

interface SmokeFile {
  samples: Array<{
    id: string;
    imagePath: string;
    instruction: string;
    bbox: [number, number, number, number];
    platform: "desktop" | "mobile" | "web";
  }>;
}

interface OfficialAnnotation {
  img_filename: string;
  instruction: string;
  /** Upstream uses normalised [x_min, y_min, x_max, y_max] in [0, 1]. */
  bbox: [number, number, number, number];
  data_type?: string;
  data_source?: string;
}

export class ScreenSpotAdapter implements BenchmarkAdapter<ScreenSpotPayload> {
  readonly name = "screenspot" as const;

  async loadSamples(
    n: number,
    opts: { smoke: boolean },
  ): Promise<Sample<ScreenSpotPayload>[]> {
    if (opts.smoke) return loadSmoke(n);
    return loadOfficial(n);
  }

  scoreOne(sample: Sample<ScreenSpotPayload>, prediction: Prediction) {
    if (prediction.click) {
      const score = clickHit(prediction.click, sample.payload.bbox);
      return {
        score,
        detail: {
          predictedClick: prediction.click,
          targetBBox: sample.payload.bbox,
          platform: sample.payload.platform,
        },
      };
    }
    // Region predictions (some grounders return [x1,y1,x2,y2]) — fall back
    // to IoU. The runner does not currently emit these but the shape stays
    // open so future grounders can plug in without changing the scorer.
    const maybeBox = (prediction as unknown as { bbox?: unknown }).bbox;
    if (Array.isArray(maybeBox) && maybeBox.length === 4) {
      const predBox = maybeBox as unknown as BBox;
      const score = iouHit(predBox, sample.payload.bbox);
      return {
        score,
        detail: {
          predictedBBox: predBox,
          targetBBox: sample.payload.bbox,
        },
      };
    }
    return {
      score: 0,
      detail: { reason: "no click or bbox in prediction" },
    };
  }
}

export async function predictScreenSpot(
  runtime: VisionRuntime,
  samples: Sample<ScreenSpotPayload>[],
): Promise<Prediction[]> {
  const out: Prediction[] = [];
  for (const sample of samples) {
    const startedAt = Date.now();
    try {
      let click = null;
      if (typeof runtime.ground === "function") {
        click = await runtime.ground({
          imagePath: sample.imagePath,
          instruction: sample.question,
        });
      } else {
        // Fallback: ask the model in text and parse "x, y" out of the answer.
        const text = await runtime.ask({
          imagePath: sample.imagePath,
          question: groundingPrompt(sample.question),
          maxTokens: 32,
        });
        click = parseClickFromText(text);
      }
      out.push({
        click: click ?? undefined,
        latencyMs: Date.now() - startedAt,
      });
    } catch (err) {
      out.push({
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/**
 * Default prompt used when the runtime doesn't expose a `ground()` method.
 * Mirrors the prompt template from the SeeClick paper §3.2: "Output the
 * click coordinate as `x, y` in pixel space." Adapter is intentionally
 * lenient — `parseClickFromText` accepts JSON and tuple forms.
 */
export function groundingPrompt(instruction: string): string {
  return [
    "You are a UI grounding model. Identify the screen element described below.",
    `Instruction: ${instruction}`,
    "Output the click coordinate as `x, y` in pixel space. No prose.",
  ].join("\n");
}

const COORD_RE = /(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/;

export function parseClickFromText(text: string): { x: number; y: number } | null {
  if (!text) return null;
  const trimmed = text.trim();
  // Try JSON first.
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { x?: number; y?: number };
      if (typeof parsed.x === "number" && typeof parsed.y === "number") {
        return { x: parsed.x, y: parsed.y };
      }
    } catch {
      // fall through
    }
  }
  const match = trimmed.match(COORD_RE);
  if (!match) return null;
  return { x: Number.parseFloat(match[1]), y: Number.parseFloat(match[2]) };
}

function loadSmoke(n: number): Sample<ScreenSpotPayload>[] {
  const file = path.join(PACKAGE_ROOT, "samples", "screenspot", "smoke.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as SmokeFile;
  return raw.samples.slice(0, n).map((s) => ({
    id: s.id,
    imagePath: path.join(PACKAGE_ROOT, s.imagePath),
    question: s.instruction,
    payload: { bbox: s.bbox, platform: s.platform },
  }));
}

function loadOfficial(n: number): Sample<ScreenSpotPayload>[] {
  const dir = process.env.SCREENSPOT_DATA_DIR;
  if (!dir) {
    throw new Error(
      "SCREENSPOT_DATA_DIR is not set. Point it at a local SeeClick/ScreenSpot " +
        "checkout with `screenspot_{desktop,mobile,web}.json` and " +
        "`screenspot_imgs/`, or pass --smoke.",
    );
  }
  const splits: Array<{ file: string; platform: ScreenSpotPayload["platform"] }> = [
    { file: "screenspot_desktop.json", platform: "desktop" },
    { file: "screenspot_mobile.json", platform: "mobile" },
    { file: "screenspot_web.json", platform: "web" },
  ];
  const samples: Sample<ScreenSpotPayload>[] = [];
  for (const split of splits) {
    const annPath = path.join(dir, split.file);
    if (!existsSync(annPath)) continue;
    const raw = JSON.parse(readFileSync(annPath, "utf8")) as OfficialAnnotation[];
    for (const entry of raw) {
      const imgPath = path.join(dir, "screenspot_imgs", entry.img_filename);
      const dims = upstreamImageDims(dir, entry.img_filename);
      const bbox = denormaliseBBox(entry.bbox, dims);
      samples.push({
        id: `screenspot-${split.platform}-${entry.img_filename}-${samples.length}`,
        imagePath: imgPath,
        question: entry.instruction,
        payload: { bbox, platform: split.platform },
      });
      if (samples.length >= n) return samples;
    }
  }
  return samples;
}

/**
 * Upstream bboxes are stored normalised in [0, 1]. We convert to pixel
 * coords using the source PNG's dimensions. Reading PNG headers manually
 * keeps the dependency footprint zero.
 */
function denormaliseBBox(
  norm: [number, number, number, number],
  dims: { width: number; height: number },
): BBox {
  return [
    norm[0] * dims.width,
    norm[1] * dims.height,
    norm[2] * dims.width,
    norm[3] * dims.height,
  ];
}

function upstreamImageDims(
  dir: string,
  filename: string,
): { width: number; height: number } {
  const imgPath = path.join(dir, "screenspot_imgs", filename);
  const buf = readFileSync(imgPath);
  // PNG: bytes 16..24 = width (BE u32) + height (BE u32). Falls back to
  // 1280x800 when the file isn't a PNG.
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height };
  }
  return { width: 1280, height: 800 };
}

// Avoid unused import warning when the adapter is built standalone.
void readdirSync;
