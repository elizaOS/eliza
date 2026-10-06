/**
 * Eliza-1 guided mode.
 *
 * Calls `LocalInferenceEngine.generate` with a `responseSkeleton` (or an
 * explicit `grammar`) derived from the task's `SkeletonHint`. The skeleton is
 * compiled to a lazy GBNF by `compileSkeletonToGbnf` inside the inference engine — the bench
 * just hands the engine the literal/free spans.
 *
 * When the engine isn't available the mode reports a skip reason; the runner
 * surfaces it in the report.
 */
import {
  type Eliza1TierId,
  type EngineLike,
  resolveElizaEngine,
} from "../engine-resolver.ts";
import type { ModeAdapter, ModeRequest, ModeResult } from "../types.ts";
import { emptyResult, renderPrompt, skeletonFromHint } from "./guided.ts";

export interface ElizaGuidedModeOptions {
  tier?: Eliza1TierId;
}

export class ElizaGuidedMode implements ModeAdapter {
  readonly id = "guided" as const;
  private engine: EngineLike | null = null;
  private modelPath: string | null = null;
  private skipReason: string | null = null;
  private resolved = false;
  private readonly tier: Eliza1TierId | undefined;

  constructor(options: ElizaGuidedModeOptions = {}) {
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
    this.modelPath = result.engine.modelPath;
    return null;
  }

  async generate(req: ModeRequest): Promise<ModeResult> {
    if (!this.engine) {
      return emptyResult(this.skipReason ?? "engine unavailable");
    }
    const prompt = renderPrompt(req);
    const skeleton = skeletonFromHint(req.skeletonHint);
    const startedAt = Date.now();
    let firstTokenAt: number | null = null;
    let accumulated = "";
    let reloadedOnce = false;
    while (true) {
      try {
        const text = await this.engine.generate({
          prompt,
          maxTokens: req.maxTokens,
          temperature: 0,
          responseSkeleton: skeleton,
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
          tokensGenerated: null,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The SharedResourceRegistry can evict the model under RAM pressure
        // between bench tasks. Reload once and retry; if it still fails, give
        // up and report the error.
        if (
          !reloadedOnce &&
          /no backend loaded/i.test(message) &&
          this.modelPath
        ) {
          reloadedOnce = true;
          try {
            await this.engine.load(this.modelPath);
            accumulated = "";
            firstTokenAt = null;
            continue;
          } catch {
            // fall through to error return
          }
        }
        return {
          rawOutput: accumulated,
          firstTokenLatencyMs: firstTokenAt ? firstTokenAt - startedAt : null,
          totalLatencyMs: Date.now() - startedAt,
          tokensGenerated: null,
          error: message,
        };
      }
    }
  }

  async cleanup(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    this.modelPath = null;
    this.resolved = false;
    this.skipReason = null;
    if (engine) await engine.unload();
  }
}
