/**
 * Eliza-1 guided mode.
 *
 * Calls `LocalInferenceEngine.generate` with a `responseSkeleton` (or an
 * explicit `grammar`) derived from the task's `SkeletonHint`. The skeleton is
 * compiled to a lazy GBNF by `compileSkeletonToGbnf` inside app-core — the bench
 * just hands the engine the literal/free spans.
 *
 * When the engine isn't available the mode reports a skip reason; the runner
 * surfaces it in the report.
 */
import { type EngineLike, resolveElizaEngine } from "../engine-resolver.ts";
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

export class ElizaGuidedMode implements ModeAdapter {
  readonly id = "guided" as const;
  private engine: EngineLike | null = null;
  private skipReason: string | null = null;
  private resolved = false;

  async available(): Promise<string | null> {
    if (this.resolved) return this.skipReason;
    this.resolved = true;
    const result = await resolveElizaEngine();
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
    const skeleton = skeletonFromHint(req.skeletonHint);
    const startedAt = Date.now();
    let firstTokenAt: number | null = null;
    let accumulated = "";
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

/**
 * Build a skeleton from the compact `SkeletonHint`. The shape is always a JSON
 * object — we emit a leading `{` literal, alternating `"key":` literals with
 * free spans, and a trailing `}`. Single-value enums collapse to literals
 * automatically inside app-core (`collapseSkeleton`).
 */
export function skeletonFromHint(hint: SkeletonHint): BenchSkeleton {
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
