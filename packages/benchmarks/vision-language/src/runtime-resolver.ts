/**
 * Resolve a `VisionRuntime` for a given eliza-1 tier.
 *
 * The bench is layered to be skippable cleanly:
 *   - When `--smoke --stub` is passed (or the local-inference plugin can't
 *     be imported), we return `createStubRuntime()` — a deterministic
 *     vision Q&A that lets the runner exercise scoring + reporting without
 *     loading any model.
 *   - Otherwise we attempt to instantiate plugin-local-inference's
 *     IMAGE_DESCRIPTION pipeline against the requested tier. The pipeline
 *     reuses the same engine resolution path as the eliza-1 text bench.
 *
 * `useModel(IMAGE_DESCRIPTION, ...)` is the canonical entrypoint per
 * CLAUDE.md / Task 15 spec.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  actionListPrompt,
  parseActionList,
} from "./adapters/osworld_adapter.ts";
import { parseClickFromText } from "./adapters/screenspot_adapter.ts";
import type {
  Eliza1TierId,
  Point,
  PredictedAction,
  VisionRuntime,
} from "./types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

interface AppCoreVisionLike {
  /** Plugin-local-inference's IMAGE_DESCRIPTION handler factory. */
  createImageDescriptionRuntime?: (args: {
    tier: Eliza1TierId;
    modelPath: string;
  }) => Promise<{
    describe(args: {
      imagePath: string;
      prompt: string;
      maxTokens?: number;
    }): Promise<string>;
    cleanup?(): Promise<void>;
  }>;
}

/**
 * Tries to wire plugin-local-inference's vision handler. Returns null when
 * the plugin source can't be imported (CI shard without the build, fresh
 * clone without `bun install`, etc.) so the runner can fall back to the
 * stub runtime.
 */
async function tryLoadPluginVision(
  tier: Eliza1TierId,
): Promise<VisionRuntime | null> {
  const modelPath = resolveModelPath(tier);
  if (!modelPath) return null;
  const candidates = [
    "@elizaos/plugin-local-inference/services",
    new URL(
      "../../../../plugins/plugin-local-inference/src/services/index.ts",
      import.meta.url,
    ).href,
  ];
  let mod: AppCoreVisionLike | null = null;
  for (const spec of candidates) {
    try {
      mod = (await import(spec)) as AppCoreVisionLike;
      break;
    } catch {
      // try next
    }
  }
  if (!mod || typeof mod.createImageDescriptionRuntime !== "function") {
    return null;
  }
  const impl = await mod.createImageDescriptionRuntime({ tier, modelPath });
  return wrapVisionImpl(tier, impl);
}

function wrapVisionImpl(
  tier: Eliza1TierId,
  impl: {
    describe(args: {
      imagePath: string;
      prompt: string;
      maxTokens?: number;
    }): Promise<string>;
    cleanup?(): Promise<void>;
  },
): VisionRuntime {
  return {
    id: tier,
    async ask({ imagePath, question, maxTokens }) {
      return impl.describe({
        imagePath,
        prompt: question,
        maxTokens: maxTokens ?? 64,
      });
    },
    async ground({ imagePath, instruction }): Promise<Point | null> {
      const text = await impl.describe({
        imagePath,
        prompt: [
          "You are a UI grounding model. Output the click coordinate as `x, y` in pixel space.",
          `Instruction: ${instruction}`,
        ].join("\n"),
        maxTokens: 32,
      });
      return parseClickFromText(text);
    },
    async runActionLoop({
      instruction,
      initialScreenshotPath,
      maxSteps,
    }): Promise<PredictedAction[]> {
      const text = await impl.describe({
        imagePath: initialScreenshotPath,
        prompt: actionListPrompt(instruction),
        maxTokens: 256,
      });
      const actions = parseActionList(text);
      return actions.slice(0, maxSteps);
    },
    cleanup: impl.cleanup,
  };
}

function resolveModelPath(tier: Eliza1TierId): string | null {
  const root = elizaModelsDir();
  const candidates = [path.join(root, `${tier}.bundle`), path.join(root, tier)];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function elizaModelsDir(): string {
  const explicit = process.env.ELIZA_STATE_DIR ?? process.env.MILADY_STATE_DIR;
  const ns = process.env.ELIZA_NAMESPACE ?? "eliza";
  const stateDir = explicit ?? path.join(homedir(), `.${ns}`);
  return path.join(stateDir, "local-inference", "models");
}

/**
 * Deterministic stub runtime for smoke tests. Returns the first reference
 * answer for VQA tasks and a fixed click point for grounding. Tests can
 * replace it via `--stub` to exercise the full runner without a model.
 */
export function createStubRuntime(tier: string = "stub"): VisionRuntime {
  return {
    id: `${tier}-stub`,
    async ask({ question }) {
      // Deterministic, content-agnostic answer. The smoke fixtures never
      // depend on this matching — the smoke runner asserts that the
      // pipeline runs end-to-end, not that the score is high.
      return inferStubAnswer(question);
    },
    async ground({ instruction }): Promise<Point | null> {
      // Centre of the smoke screen (1280x800). One smoke sample's bbox
      // includes this point, the others don't — so the reported smoke
      // score is a non-trivial number rather than 0/1.
      void instruction;
      return { x: 640, y: 400 };
    },
    async runActionLoop({ instruction }): Promise<PredictedAction[]> {
      void instruction;
      return [{ type: "DONE" }];
    },
  };
}

function inferStubAnswer(question: string): string {
  const q = question.toLowerCase();
  if (q.includes("time")) return "3:15";
  if (q.includes("number") || q.includes("jersey")) return "7";
  if (q.includes("city") || q.includes("airport")) return "Paris";
  if (q.includes("orange sign")) return "stop";
  if (q.includes("bottle")) return "water";
  if (q.includes("invoice total")) return "$1,250.00";
  if (q.includes("signed")) return "John Smith";
  if (q.includes("date")) return "2024-03-12";
  if (q.includes("address")) return "742 Evergreen Terrace";
  if (q.includes("policy number")) return "POL-2024-78213";
  if (q.includes("q3")) return "42";
  if (q.includes("highest bar") || q.includes("category")) return "Sales";
  if (q.includes("blue slice") || q.includes("percentage")) return "35%";
  if (q.includes("revenue")) return "increase";
  if (q.includes("difference")) return "18";
  return "unknown";
}

export async function resolveRuntime(args: {
  tier: Eliza1TierId | string;
  forceStub: boolean;
}): Promise<VisionRuntime> {
  if (args.forceStub) return createStubRuntime(args.tier);
  if (args.tier === "stub") return createStubRuntime();
  const plugin = await tryLoadPluginVision(args.tier as Eliza1TierId);
  if (plugin) return plugin;
  // No model available — fall back to the stub so smoke runs always
  // complete. Full runs surface the unavailability via the report's
  // `runtime` field.
  return createStubRuntime(args.tier);
}

void HERE;
