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
import { approxTokens } from "../metrics.ts";
import type {
  ModeAdapter,
  ModeRequest,
  ModeResult,
  SkeletonFreeField,
  SkeletonHint,
} from "../types.ts";

/**
 * A single skeleton-span entry — mirror of `ResponseSkeletonSpan` in
 * @elizaos/core. We re-declare it locally to keep this module type-free at the
 * core-package boundary.
 */
interface BenchSkeletonSpan {
  kind: "literal" | "enum" | "free-string" | "free-json";
  key?: string;
  value?: string;
  enumValues?: string[];
}

interface BenchSkeleton {
  id?: string;
  spans: BenchSkeletonSpan[];
}

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
    let skeleton: BenchSkeleton;
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
          tokensGenerated: approxTokens(rawOutput),
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
          tokensGenerated: approxTokens(accumulated),
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

/**
 * Build a skeleton from the compact `SkeletonHint`. The shape is always a JSON
 * object — we emit a leading `{` literal, alternating `"key":` literals with
 * free spans, and a trailing `}`. Single-value enums collapse to literals
 * automatically inside app-core (`collapseSkeleton`).
 */
function skeletonFromHint(hint: SkeletonHint): BenchSkeleton {
  const spans: BenchSkeletonSpan[] = [];
  const fields = hint.freeFields;
  if (fields.length === 0 && hint.enumKey && hint.enumValues) {
    spans.push({ kind: "literal", value: `{"${hint.enumKey}":` });
    spans.push({
      kind: "enum",
      key: hint.enumKey,
      enumValues: hint.enumValues,
    });
    spans.push({ kind: "literal", value: "}" });
    return { spans };
  }
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    const prefix = i === 0 ? `{"${field.key}":` : `,"${field.key}":`;
    spans.push({ kind: "literal", value: prefix });
    spans.push(spanForField(field));
  }
  spans.push({ kind: "literal", value: "}" });
  return { spans };
}

function spanForField(field: SkeletonFreeField): BenchSkeletonSpan {
  switch (field.kind) {
    case "enum":
      return {
        kind: "enum",
        key: field.key,
        enumValues: field.enumValues ?? [],
      };
    case "string":
      return { kind: "free-string", key: field.key };
    case "boolean":
    case "number":
    case "object":
      return { kind: "free-json", key: field.key };
  }
}

function renderPrompt(req: ModeRequest): string {
  return [
    req.systemPrompt,
    "",
    "Respond with a single JSON object only.",
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
