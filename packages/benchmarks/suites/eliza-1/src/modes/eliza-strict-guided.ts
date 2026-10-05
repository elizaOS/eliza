/**
 * Eliza-1 strict-guided mode.
 *
 * Like the guided mode, but for the planner task it receives a pre-built
 * GBNF grammar string (from `buildPlannerActionGrammarStrict`) in the
 * ModeRequest and passes it to the engine. For should_respond and action:*
 * tasks, it falls back to the simple skeleton.
 *
 * The strict grammar precisely pins the `action` enum + lets `parameters`
 * be free JSON, achieving single-pass tight control over the action choice
 * while the engine's second pass refines the parameters.
 */
import {
  type Eliza1TierId,
  type EngineLike,
  resolveElizaEngine,
} from "../engine-resolver.ts";
import type { ModeAdapter, ModeRequest, ModeResult } from "../types.ts";
import { emptyResult, renderPrompt, skeletonFromHint } from "./guided.ts";

export interface ElizaStrictGuidedModeOptions {
  tier?: Eliza1TierId;
}

export class ElizaStrictGuidedMode implements ModeAdapter {
  readonly id = "strict-guided" as const;
  private engine: EngineLike | null = null;
  private modelPath: string | null = null;
  private skipReason: string | null = null;
  private resolved = false;
  private readonly tier: Eliza1TierId | undefined;

  constructor(options: ElizaStrictGuidedModeOptions = {}) {
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

    // For planner tasks with a pre-built grammar, use the grammar.
    // Otherwise, build a skeleton from the hint.
    let skeleton: ReturnType<typeof skeletonFromHint>;
    let grammar: string | undefined;

    if (req.grammar) {
      // Planner task with strict grammar — use minimal skeleton + grammar
      grammar = req.grammar;
      skeleton = { spans: [{ kind: "free-json", key: "envelope" }] };
    } else {
      // should_respond or action:* — use simple skeleton
      skeleton = skeletonFromHint(req.skeletonHint);
    }

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
          grammar,
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
          _skeleton: skeleton,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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
