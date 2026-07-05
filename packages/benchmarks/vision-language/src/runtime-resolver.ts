/**
 * Resolve a `VisionRuntime` for a given eliza-1 tier.
 *
 * The bench is layered to be skippable cleanly:
 *   - When `--smoke --stub` is passed (or the local-inference plugin can't
 *     be imported), explicit `--smoke --stub` runs return
 *     `createStubRuntime()` — a deterministic vision Q&A that lets the runner
 *     exercise scoring + reporting without loading any model.
 *   - Otherwise we attempt to instantiate plugin-local-inference's
 *     IMAGE_DESCRIPTION pipeline against the requested tier. Full runs fail
 *     closed when no real runtime is available.
 *
 * `useModel(IMAGE_DESCRIPTION, ...)` is the canonical entrypoint per
 * CLAUDE.md / Task 15 spec.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAliasedEnvValue } from "@elizaos/core";
import {
  actionListPrompt,
  parseActionList,
} from "./adapters/osworld_adapter.ts";
import { parseClickFromText } from "./adapters/screenspot_adapter.ts";
import type {
  Eliza1TierId,
  Point,
  PredictedAction,
  UsageTelemetry,
  VisionRuntime,
} from "./types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_ROOT = path.join(HERE, "..");

export interface RuntimeResolveArgs {
  tier: Eliza1TierId | string;
  forceStub: boolean;
  harness?: "eliza" | "hermes" | "openclaw" | "elizaos" | "opencode";
  provider?: string;
  model?: string;
}

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
      const candidate = (await import(spec)) as AppCoreVisionLike;
      if (typeof candidate.createImageDescriptionRuntime === "function") {
        mod = candidate;
        break;
      }
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
          "UI grounding model. Output the click coordinate as `x, y` in pixel space.",
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

/**
 * Local mirror of `elizaModelsDir()` from `@elizaos/shared/local-inference/paths`,
 * kept so the bench resolves model paths without importing shared. State-dir and
 * namespace resolve through core's non-mutating alias reader so a branded prefix
 * (e.g. `MILADY_STATE_DIR`) is honoured without the `syncBrandEnvToEliza` mirror
 * mutation (#13422).
 */
export function elizaModelsDir(): string {
  const explicit = resolveAliasedEnvValue("ELIZA_STATE_DIR");
  const ns = resolveAliasedEnvValue("ELIZA_NAMESPACE") ?? "eliza";
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

function createHarnessRuntime(args: {
  harness: "eliza" | "hermes" | "openclaw" | "elizaos" | "opencode";
  provider: string;
  model: string;
}): VisionRuntime {
  const usageTotals: Required<UsageTelemetry> = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cached_tokens: 0,
    cache_creation_tokens: 0,
    llm_call_count: 0,
  };
  let sawUsage = false;
  const python = process.env.PYTHON ?? process.env.PYTHON_BIN ?? "python";
  const script = path.join(
    PACKAGE_ROOT,
    "scripts",
    "vision_harness_runtime.py",
  );

  async function askHarness({
    imagePath,
    question,
    maxTokens,
  }: {
    imagePath: string;
    question: string;
    maxTokens?: number;
  }): Promise<string> {
    const child = spawnSync(python, [script], {
      input: JSON.stringify({
        harness: args.harness,
        provider: args.provider,
        model: args.model,
        imagePath,
        question,
        maxTokens,
      }),
      encoding: "utf8",
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (child.error) throw child.error;
    if (child.status !== 0) {
      throw new Error(
        `${args.harness} vision runtime failed rc=${child.status}: ${child.stderr || child.stdout}`,
      );
    }
    const output = (child.stdout || "").trim().split("\n").at(-1) || "";
    const parsed = JSON.parse(output) as {
      text?: unknown;
      usage?: unknown;
      params?: unknown;
    };
    const usage = usageFromPayload(parsed);
    addUsage(usageTotals, usage);
    if (Object.values(usage).some((value) => value !== undefined)) {
      sawUsage = true;
    }
    const text = typeof parsed.text === "string" ? parsed.text : "";
    return text;
  }

  return {
    id: `${args.harness}:${args.provider}/${args.model}`,
    ask: askHarness,
    async ground({ imagePath, instruction }): Promise<Point | null> {
      const text = await askHarness({
        imagePath,
        question: [
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
      const text = await askHarness({
        imagePath: initialScreenshotPath,
        question: actionListPrompt(instruction),
        maxTokens: 256,
      });
      return parseActionList(text).slice(0, maxSteps);
    },
    usage() {
      if (!sawUsage) return {};
      const totalTokens =
        usageTotals.total_tokens ||
        usageTotals.input_tokens + usageTotals.output_tokens;
      return { ...usageTotals, total_tokens: totalTokens };
    },
  };
}

function addUsage(
  target: Required<UsageTelemetry>,
  usage: UsageTelemetry,
): void {
  target.input_tokens += usage.input_tokens ?? 0;
  target.output_tokens += usage.output_tokens ?? 0;
  target.total_tokens += usage.total_tokens ?? 0;
  target.cached_tokens += usage.cached_tokens ?? 0;
  target.cache_creation_tokens += usage.cache_creation_tokens ?? 0;
  target.llm_call_count +=
    usage.llm_call_count ?? (Object.keys(usage).length ? 1 : 0);
}

function usageFromPayload(payload: {
  usage?: unknown;
  params?: unknown;
}): UsageTelemetry {
  const direct = normalizeUsage(payload.usage);
  if (Object.keys(direct).length) return direct;
  const params = payload.params;
  if (params && typeof params === "object" && "usage" in params) {
    return normalizeUsage((params as { usage?: unknown }).usage);
  }
  return {};
}

function normalizeUsage(payload: unknown): UsageTelemetry {
  if (!payload || typeof payload !== "object") return {};
  const usage = payload as Record<string, unknown>;
  const input = numberValue(
    usage.input_tokens,
    usage.prompt_tokens,
    usage.inputTokens,
    usage.promptTokens,
  );
  const output = numberValue(
    usage.output_tokens,
    usage.completion_tokens,
    usage.outputTokens,
    usage.completionTokens,
  );
  const total = numberValue(usage.total_tokens, usage.totalTokens);
  const cached = numberValue(
    usage.cached_tokens,
    usage.cache_read_input_tokens,
    usage.cachedTokens,
    usage.cacheReadInputTokens,
  );
  const cacheCreation = numberValue(
    usage.cache_creation_tokens,
    usage.cache_creation_input_tokens,
    usage.cacheCreationTokens,
    usage.cacheCreationInputTokens,
  );
  const calls = numberValue(usage.llm_call_count, usage.llmCallCount);
  const result: UsageTelemetry = {};
  if (input !== undefined) result.input_tokens = input;
  if (output !== undefined) result.output_tokens = output;
  if (total !== undefined) result.total_tokens = total;
  if (cached !== undefined) result.cached_tokens = cached;
  if (cacheCreation !== undefined) result.cache_creation_tokens = cacheCreation;
  if (calls !== undefined) result.llm_call_count = calls;
  return result;
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
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

export async function resolveRuntime(
  args: RuntimeResolveArgs,
): Promise<VisionRuntime> {
  if (args.forceStub) return createStubRuntime(args.tier);
  if (args.tier === "stub") return createStubRuntime();
  const harness = args.harness ?? "eliza";
  const provider = (args.provider ?? process.env.VISION_LANGUAGE_PROVIDER ?? "")
    .trim()
    .toLowerCase();
  const LOCAL_ELIZA_PROVIDERS = new Set([
    "local-eliza",
    "local_eliza",
    "eliza-local",
    "eliza_local",
  ]);
  // The local eliza-1 VLM runs through llama-mtmd-cli, driven by the Python
  // vision harness runtime. Route any harness with a local-eliza provider
  // through that bridge instead of the in-process FFI plugin path (which
  // requires a specialized libelizainference build that isn't always present).
  if (LOCAL_ELIZA_PROVIDERS.has(provider)) {
    return createHarnessRuntime({
      harness: "eliza",
      provider,
      model: (args.model ?? args.tier).trim() || args.tier,
    });
  }
  if (
    harness === "hermes" ||
    harness === "openclaw" ||
    harness === "elizaos" ||
    harness === "opencode"
  ) {
    const model = (
      args.model ??
      process.env.VISION_LANGUAGE_MODEL ??
      ""
    ).trim();
    if (!model) {
      throw new Error(
        `vision-language ${harness} runtime requires --model or VISION_LANGUAGE_MODEL`,
      );
    }
    return createHarnessRuntime({
      harness,
      provider:
        (
          args.provider ??
          process.env.VISION_LANGUAGE_PROVIDER ??
          "openai"
        ).trim() || "openai",
      model,
    });
  }
  const plugin = await tryLoadPluginVision(args.tier as Eliza1TierId);
  if (plugin) return plugin;
  throw new Error(
    `no real IMAGE_DESCRIPTION runtime available for tier '${args.tier}'. ` +
      "Use --smoke --stub only for explicit non-publishable smoke runs.",
  );
}

void HERE;
