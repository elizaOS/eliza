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
 *   - full:  success-rate from the plugin-computeruse adapter. The runner
 *     hands evaluation off to that adapter; this file only holds the
 *     bridge (no duplicate VM driver).
 */
import { existsSync, readFileSync } from "node:fs";
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
      // Full-VM sample: the plugin-computeruse adapter will have stamped
      // the success bit into prediction.actions[0].text === "SUCCESS".
      const last = prediction.actions?.[prediction.actions.length - 1];
      const success = last?.type === "DONE";
      return { score: success ? 1 : 0, detail: { mode: "vm" } };
    }
    const score = osworldStepMatch(prediction.actions ?? [], sample.payload.trace);
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
  return predictWithVm(runtime, samples);
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

/**
 * Bridge to plugin-computeruse's full OSWorld adapter. We dynamically
 * import so the bench package doesn't have a hard dependency on
 * plugin-computeruse — the smoke path always works without the plugin.
 */
async function predictWithVm(
  runtime: VisionRuntime,
  samples: Sample<OSWorldPayload>[],
): Promise<Prediction[]> {
  if (typeof runtime.runActionLoop !== "function") {
    throw new Error(
      "OSWorld full eval requires a runtime with `runActionLoop`. " +
        "Use plugin-computeruse's OSWorldAdapter to drive the VM and " +
        "wire it into the runtime adapter.",
    );
  }
  const out: Prediction[] = [];
  for (const sample of samples) {
    const startedAt = Date.now();
    try {
      const actions = await runtime.runActionLoop({
        instruction: sample.question,
        initialScreenshotPath: sample.imagePath,
        maxSteps: 30,
      });
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
    "You are a desktop control agent. Output the action sequence to perform the task.",
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
  const dir = process.env.OSWORLD_DATA_DIR;
  if (!dir) {
    throw new Error(
      "OSWORLD_DATA_DIR is not set. Point it at a local OSWorld checkout " +
        "with `evaluation_examples/examples/<domain>/<task>.json`, or pass --smoke.",
    );
  }
  const indexPath = path.join(dir, "evaluation_examples", "test_all.json");
  if (!existsSync(indexPath)) {
    throw new Error(
      `OSWorld task index not found at ${indexPath}. ` +
        "See https://github.com/xlang-ai/OSWorld for setup.",
    );
  }
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as Record<
    string,
    string[]
  >;
  const samples: Sample<OSWorldPayload>[] = [];
  for (const [domain, taskIds] of Object.entries(index)) {
    for (const taskId of taskIds) {
      const taskPath = path.join(
        dir,
        "evaluation_examples",
        "examples",
        domain,
        `${taskId}.json`,
      );
      if (!existsSync(taskPath)) continue;
      const config = JSON.parse(readFileSync(taskPath, "utf8")) as {
        id: string;
        instruction: string;
      } & Record<string, unknown>;
      samples.push({
        id: `${domain}/${taskId}`,
        imagePath: "",
        question: config.instruction,
        payload: { trace: [], taskConfig: config },
      });
      if (samples.length >= n) return samples;
    }
  }
  return samples;
}
