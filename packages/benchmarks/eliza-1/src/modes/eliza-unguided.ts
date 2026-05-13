/**
 * Eliza-1 unguided mode.
 *
 * Calls `LocalInferenceEngine.generate` with NO `grammar` / `responseSkeleton`
 * — the model free-runs and the runner parses JSON post-hoc. This is the
 * baseline we measure the guided mode against.
 */
import {
  type Eliza1TierId,
  type EngineLike,
  resolveElizaEngine,
} from "../engine-resolver.ts";
import { approxTokens } from "../metrics.ts";
import type { ModeAdapter, ModeRequest, ModeResult } from "../types.ts";

export interface ElizaUnguidedModeOptions {
  tier?: Eliza1TierId;
}

export class ElizaUnguidedMode implements ModeAdapter {
  readonly id = "unguided" as const;
  private engine: EngineLike | null = null;
  private skipReason: string | null = null;
  private resolved = false;
  private readonly tier: Eliza1TierId | undefined;

  constructor(options: ElizaUnguidedModeOptions = {}) {
    this.tier = options.tier;
  }

  async available(): Promise<string | null> {
    if (this.resolved) return this.skipReason;
    this.resolved = true;
    const result = await resolveElizaEngine(this.tier);
    if (result.kind === "skip") {
      this.skipReason = result.reason;
      return this.skipReason;
    }
    this.engine = result.engine.engine;
    return null;
  }

  async generate(req: ModeRequest): Promise<ModeResult> {
    if (!this.engine) {
      return emptyResult(this.skipReason ?? "engine unavailable");
    }
    const prompt = renderPrompt(req);
    const startedAt = Date.now();
    let firstTokenAt: number | null = null;
    let accumulated = "";
    try {
      const text = await this.engine.generate({
        prompt,
        maxTokens: req.maxTokens,
        temperature: 0,
        onTextChunk: (chunk: string) => {
          if (firstTokenAt === null) firstTokenAt = Date.now();
          accumulated += chunk;
        },
      });
      const finishedAt = Date.now();
      const rawOutput = text || accumulated;
      return {
        rawOutput,
        firstTokenLatencyMs: firstTokenAt ? firstTokenAt - startedAt : null,
        totalLatencyMs: finishedAt - startedAt,
        tokensGenerated: approxTokens(rawOutput),
      };
    } catch (err) {
      return {
        rawOutput: accumulated,
        firstTokenLatencyMs: firstTokenAt ? firstTokenAt - startedAt : null,
        totalLatencyMs: Date.now() - startedAt,
        tokensGenerated: approxTokens(accumulated),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function renderPrompt(req: ModeRequest): string {
  return [
    req.systemPrompt,
    "",
    "Respond with ONLY a single JSON object matching the schema described above. No prose, no fences, no commentary.",
    "",
    "USER MESSAGE:",
    req.userPrompt,
    "",
    "JSON:",
  ].join("\n");
}

function emptyResult(message: string): ModeResult {
  return {
    rawOutput: "",
    firstTokenLatencyMs: null,
    totalLatencyMs: 0,
    tokensGenerated: 0,
    error: message,
  };
}
