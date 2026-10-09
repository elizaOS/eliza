/**
 * OSWorld adapter.
 *
 * Benchmark: OSWorld — end-to-end CUA evaluation in a real Linux VM. Each
 * task is an instruction; the agent observes screenshots, emits actions,
 * and is scored on whether the final environment state matches the
 * task's evaluator.
 *
 * Paper:   Xie et al. 2024, "OSWorld: Benchmarking Multimodal Agents for
 *          Open-Ended Tasks in Real Computer Environments"
 *          (https://arxiv.org/abs/2404.07972).
 * Dataset: https://github.com/xlang-ai/OSWorld — Apache-2.0 task configs;
 *          the VM image is hosted separately. The full eval requires a
 *          running OSWorld VM (≈30 GB image) and is wired here through
 *          `plugins/plugin-computeruse/src/osworld/` (`OSWorldAdapter`).
 *
 * Sample shape (smoke): { id, imagePath, question,
 *   payload: { trace: PredictedAction[] } }
 * Sample shape (full):  the OSWorldTaskConfig from plugin-computeruse;
 *                       the runtime drives the VM + adapter directly.
 *
 * Scoring:
 *   - smoke: action-sequence agreement against the reference trace via
 *     `osworldStepMatch` (cheap, no VM required).
 *   - full:  rejected here because this package has no VM-state evaluator.
 *     Publishable full runs use the separately registered canonical OSWorld
 *     harness, which owns the real VM lifecycle and task evaluators.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { osworldStepMatch } from "../scorers/index.ts";
import type {
  BenchmarkAdapter,
  PredictedAction,
  Prediction,
  Sample,
  VisionRuntime,
} from "../types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..", "..");

export interface OSWorldPayload {
  /** Reference action trace for smoke runs. Empty for full-VM samples. */
  trace: PredictedAction[];
  /** Full-VM only: opaque task config the plugin-computeruse adapter consumes. */
  taskConfig?: Record<string, unknown>;
}

interface SmokeFile {
  samples: Array<{
    id: string;
    imagePath: string;
    instruction: string;
    trace: PredictedAction[];
  }>;
}

export class OSWorldAdapter implements BenchmarkAdapter<OSWorldPayload> {
  readonly name = "osworld" as const;

  async loadSamples(
    n: number,
    opts: { smoke: boolean },
  ): Promise<Sample<OSWorldPayload>[]> {
    if (opts.smoke) return loadSmoke(n);
    return loadOfficial(n);
  }

  scoreOne(sample: Sample<OSWorldPayload>, prediction: Prediction) {
    if (sample.payload.trace.length === 0) {
      return {
        score: 0,
        detail: {
          mode: "invalid",
          reason: "full OSWorld requires the canonical VM-state evaluator",
        },
      };
    }
    const score = osworldStepMatch(
      prediction.actions ?? [],
      sample.payload.trace,
    );
    return {
      score,
      detail: {
        mode: "trace",
        predictedSteps: prediction.actions?.length ?? 0,
        referenceSteps: sample.payload.trace.length,
      },
    };
  }
}

export async function predictOSWorld(
  runtime: VisionRuntime,
  samples: Sample<OSWorldPayload>[],
  opts: { smoke: boolean },
): Promise<Prediction[]> {
  if (opts.smoke) return predictSmoke(runtime, samples);
  throw new Error(
    "Full OSWorld predictions require the canonical suites/OSWorld VM harness",
  );
}

async function predictSmoke(
  runtime: VisionRuntime,
  samples: Sample<OSWorldPayload>[],
): Promise<Prediction[]> {
  const out: Prediction[] = [];
  for (const sample of samples) {
    const startedAt = Date.now();
    try {
      let actions: PredictedAction[] = [];
      if (typeof runtime.runActionLoop === "function") {
        actions = await runtime.runActionLoop({
          instruction: sample.question,
          initialScreenshotPath: sample.imagePath,
          maxSteps: Math.max(sample.payload.trace.length + 2, 5),
        });
      } else {
        // Fallback for runtimes without an action-loop: ask the model to
        // emit a JSON action list and parse it. Keeps smoke runs functional
        // against any vision Q&A model.
        const text = await runtime.ask({
          imagePath: sample.imagePath,
          question: actionListPrompt(sample.question),
          maxTokens: 256,
        });
        actions = parseActionList(text);
      }
      out.push({ actions, latencyMs: Date.now() - startedAt });
    } catch (err) {
      out.push({
        actions: [],
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

export function actionListPrompt(instruction: string): string {
  return [
    "Desktop control agent. Output the action sequence to perform the task.",
    `Task: ${instruction}`,
    'Use JSON array format: [{ "type": "CLICK", "x": 100, "y": 200 }, { "type": "TYPING", "text": "..." }, { "type": "DONE" }].',
    "Allowed types: CLICK, TYPING, HOTKEY (with `keys`), SCROLL, WAIT, DONE, FAIL.",
  ].join("\n");
}

const ALLOWED_TYPES = new Set([
  "CLICK",
  "TYPING",
  "HOTKEY",
  "SCROLL",
  "WAIT",
  "DONE",
  "FAIL",
]);

export function parseActionList(text: string): PredictedAction[] {
  if (!text) return [];
  const trimmed = text.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PredictedAction[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const type = typeof e.type === "string" ? e.type.toUpperCase() : "";
    if (!ALLOWED_TYPES.has(type)) continue;
    const action: PredictedAction = { type: type as PredictedAction["type"] };
    if (typeof e.x === "number") action.x = e.x;
    if (typeof e.y === "number") action.y = e.y;
    if (typeof e.text === "string") action.text = e.text;
    if (Array.isArray(e.keys) && e.keys.every((k) => typeof k === "string")) {
      action.keys = e.keys as string[];
    }
    out.push(action);
  }
  return out;
}

function loadSmoke(n: number): Sample<OSWorldPayload>[] {
  const file = path.join(PACKAGE_ROOT, "samples", "osworld", "smoke.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as SmokeFile;
  return raw.samples.slice(0, n).map((s) => ({
    id: s.id,
    imagePath: path.join(PACKAGE_ROOT, s.imagePath),
    question: s.instruction,
    payload: { trace: s.trace },
  }));
}

function loadOfficial(n: number): Sample<OSWorldPayload>[] {
  void n;
  throw new Error(
    "Full OSWorld is not implemented by vision-language: a task JSON plus an empty " +
      "screenshot cannot drive or evaluate VM state. Run the registered canonical " +
      "suites/OSWorld harness with a real VM provider; use --smoke here " +
      "only for non-publishable action-trace plumbing checks.",
  );
}
