/**
 * Standardized argument-extraction substrate for LifeOps umbrella actions.
 *
 * Replaces the per-action hand-rolled `resolveSubactionPlan`-style helpers
 * (one per umbrella action) with a single shared resolver that:
 *   1. Trusts planner-supplied parameters when they are complete.
 *   2. Falls through to a single LLM extraction pass (with one repair shot)
 *      that picks the right subaction and pulls its required params from
 *      free-form intent + recent conversation.
 *
 * Intentionally narrow: this resolver knows about subactions and required
 * params, nothing else. Domain-specific param normalization, post-extraction
 * confirmation flows, and side-effect dispatch stay in the umbrella action.
 */
import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { parseJsonModelRecord } from "../../utils/json-model-output.js";
import { runExtractorPipeline } from "../../lifeops/llm/extractor-pipeline.js";
import { recentConversationTextsFromState } from "./recent-context.js";

// ── Public types ──────────────────────────────────────

export interface SubactionSpec<TParams = Record<string, unknown>> {
  /** Full description (per-subaction; surfaced into LLM prompt). */
  description: string;
  /** Caveman compressed: max semantic info per token, drop articles/conjunctions. */
  descriptionCompressed: string;
  /** Required parameter keys; missing any -> triggers extraction. */
  required: ReadonlyArray<keyof TParams & string>;
  /** Optional keys; surfaced to extractor as "may extract if obvious". */
  optional?: ReadonlyArray<keyof TParams & string>;
}

export type SubactionsMap<TSubaction extends string = string> = {
  readonly [K in TSubaction]: SubactionSpec;
};

export interface ResolveActionArgsInput<TSubaction extends string, _TParams> {
  runtime: IAgentRuntime;
  message: Memory;
  state?: State;
  options?: HandlerOptions;
  actionName: string;
  subactions: SubactionsMap<TSubaction>;
  defaultSubaction?: TSubaction;
  intentHint?: string;
}

export type ResolveActionArgsResult<TSubaction extends string, TParams> =
  | { ok: true; subaction: TSubaction; params: TParams }
  | {
      ok: false;
      missing: string[];
      clarification: string;
      partial?: Partial<TParams>;
    };

// ── Internal helpers ──────────────────────────────────

const RECENT_CONTEXT_LIMIT = 8;
const MIN_CONFIDENCE = 0.5;
const FALLBACK_CLARIFICATION =
  "I'm not sure what you'd like to do — can you say it a bit differently?";

interface ParsedExtraction<TSubaction extends string> {
  subaction: TSubaction | null;
  params: Record<string, unknown>;
  missing: string[];
  confidence: number;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function valueIsPresent(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

function getMessageText(message: Memory): string {
  const text = message?.content?.text;
  return typeof text === "string" ? text.trim() : "";
}

function isSubactionKey<TSubaction extends string>(
  value: unknown,
  subactions: SubactionsMap<TSubaction>,
): value is TSubaction {
  return typeof value === "string" && Object.hasOwn(subactions, value);
}

function missingRequiredKeys<TSubaction extends string>(
  subaction: TSubaction,
  subactions: SubactionsMap<TSubaction>,
  params: Record<string, unknown>,
): string[] {
  const required = subactions[subaction]?.required ?? [];
  const missing: string[] = [];
  for (const key of required) {
    if (!valueIsPresent(params[key])) {
      missing.push(key);
    }
  }
  return missing;
}

function pickKnownParams<TSubaction extends string>(
  subaction: TSubaction,
  subactions: SubactionsMap<TSubaction>,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const spec = subactions[subaction];
  if (!spec) {
    return {};
  }
  const allowed = new Set<string>([
    ...(spec.required as readonly string[]),
    ...((spec.optional as readonly string[] | undefined) ?? []),
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (allowed.has(key) && value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function buildClarificationMessage(
  actionName: string,
  subaction: string | null,
  missing: string[],
): string {
  if (missing.length === 0) {
    return `I need a bit more detail to run ${actionName}.`;
  }
  const fields = missing.join(", ");
  if (subaction) {
    return `To ${actionName} (${subaction}) I still need: ${fields}.`;
  }
  return `To ${actionName} I still need: ${fields}.`;
}

function describeSubactionsForPrompt<TSubaction extends string>(
  subactions: SubactionsMap<TSubaction>,
): string {
  const entries: string[] = [];
  for (const key of Object.keys(subactions) as TSubaction[]) {
    const spec = subactions[key];
    const required = spec.required.length > 0 ? spec.required.join(", ") : "—";
    const optional =
      spec.optional && spec.optional.length > 0
        ? spec.optional.join(", ")
        : "—";
    entries.push(
      [
        `- ${key}: ${spec.descriptionCompressed}`,
        `  required: ${required}`,
        `  optional: ${optional}`,
      ].join("\n"),
    );
  }
  return entries.join("\n");
}

function buildExtractionPrompt<TSubaction extends string>(args: {
  actionName: string;
  subactions: SubactionsMap<TSubaction>;
  defaultSubaction?: TSubaction;
  intent: string;
  intentHint?: string;
  recentConversation: string;
}): string {
  const { actionName, subactions, defaultSubaction, intent, intentHint } = args;
  const lines: string[] = [
    `Pick the correct subaction for the ${actionName} umbrella and extract its parameters.`,
    "Subactions (with their required + optional parameter keys):",
    describeSubactionsForPrompt(subactions),
    "",
  ];
  if (defaultSubaction) {
    lines.push(
      `If the intent is on-topic but ambiguous between subactions, prefer "${defaultSubaction}".`,
    );
  }
  lines.push(
    "Return ONLY a JSON object with these fields:",
    "  subaction: one of the subaction keys above, or null if the request does not match any subaction",
    "  params: record containing the required and any obvious optional parameter values you extracted",
    "  missing: list of required parameter keys you could NOT extract from the request or context",
    "  confidence: number from 0.0 to 1.0 reflecting how confident you are in the subaction choice",
    "",
    "Rules:",
    "- Use null for params you cannot determine; do not invent values.",
    "- Only include parameter keys that appear in the chosen subaction's required or optional list.",
    "- If the request does not match any subaction, set subaction=null and confidence < 0.5.",
    "",
    `User request: ${intent || "(empty)"}`,
  );
  if (intentHint && intentHint.trim().length > 0) {
    lines.push(`Intent hint: ${intentHint.trim()}`);
  }
  lines.push(
    "Recent conversation (most recent last):",
    args.recentConversation.length > 0 ? args.recentConversation : "(none)",
    "",
    'Return ONLY the JSON object. Example: {"subaction":null,"params":{},"missing":["subaction"],"confidence":0.0}. No prose, markdown, or code fences.',
  );
  return lines.join("\n");
}

function buildRepairPromptForExtraction(rawFirstPass: string): string {
  return [
    "Your previous reply was not valid JSON for the action argument extractor.",
    "Return ONLY a JSON object with exactly these fields: subaction, params, missing, confidence.",
    "subaction: string or null. params: record. missing: list of strings. confidence: number 0.0-1.0.",
    "No prose, no markdown, no code fences.",
    "",
    "Previous invalid output:",
    rawFirstPass.trim().length > 0 ? rawFirstPass.trim() : "(empty)",
  ].join("\n");
}

function parseExtractionEnvelope<TSubaction extends string>(
  raw: string,
  subactions: SubactionsMap<TSubaction>,
): ParsedExtraction<TSubaction> | null {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  const parsed = parseJsonModelRecord<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const subactionRaw = parsed.subaction;
  const subaction = isSubactionKey(subactionRaw, subactions)
    ? subactionRaw
    : null;

  const params =
    parsed.params &&
    typeof parsed.params === "object" &&
    !Array.isArray(parsed.params)
      ? (parsed.params as Record<string, unknown>)
      : {};

  const missingRaw = Array.isArray(parsed.missing) ? parsed.missing : [];
  const missing = missingRaw.filter(nonEmptyString).map((s) => s.trim());

  const confidenceRaw = parsed.confidence;
  let confidence = 0;
  if (typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)) {
    confidence = Math.max(0, Math.min(1, confidenceRaw));
  } else if (typeof confidenceRaw === "string") {
    const numeric = Number.parseFloat(confidenceRaw);
    if (Number.isFinite(numeric)) {
      confidence = Math.max(0, Math.min(1, numeric));
    }
  }

  return { subaction, params, missing, confidence };
}

// ── Public entry point ────────────────────────────────

/**
 * Resolve the (subaction, params) pair for a LifeOps umbrella action.
 *
 * Trusts complete planner-supplied parameters when present; otherwise runs
 * a single LLM extraction pass (with one repair retry) over the registered
 * subactions and returns either a fully resolved result or a structured
 * "missing fields + clarification" failure.
 */
export async function resolveActionArgs<
  TSubaction extends string,
  TParams = Record<string, unknown>,
>(
  input: ResolveActionArgsInput<TSubaction, TParams>,
): Promise<ResolveActionArgsResult<TSubaction, TParams>> {
  const {
    runtime,
    message,
    state,
    options,
    actionName,
    subactions,
    defaultSubaction,
    intentHint,
  } = input;

  const plannerParams =
    options?.parameters && typeof options.parameters === "object"
      ? (options.parameters as Record<string, unknown>)
      : {};

  // 1. Planner trust path — fully populated subaction + required fields.
  const plannerSubactionRaw = plannerParams.subaction;
  if (isSubactionKey(plannerSubactionRaw, subactions)) {
    const plannerSubaction = plannerSubactionRaw;
    const missingFromPlanner = missingRequiredKeys(
      plannerSubaction,
      subactions,
      plannerParams,
    );
    if (missingFromPlanner.length === 0) {
      return {
        ok: true,
        subaction: plannerSubaction,
        params: plannerParams as TParams,
      };
    }
  }

  // 2. LLM extraction path for natural-language umbrella actions.
  const intent = asTrimmedString(intentHint) || getMessageText(message);
  const recentConversation = recentConversationTextsFromState(
    state,
    RECENT_CONTEXT_LIMIT,
  ).join("\n");

  const prompt = buildExtractionPrompt({
    actionName,
    subactions,
    defaultSubaction,
    intent,
    intentHint,
    recentConversation,
  });

  const { parsed } = await runExtractorPipeline({
    runtime,
    prompt,
    parser: (raw) => parseExtractionEnvelope(raw, subactions),
    buildRepairPrompt: buildRepairPromptForExtraction,
  });

  if (!parsed) {
    return {
      ok: false,
      missing: ["subaction"],
      clarification: FALLBACK_CLARIFICATION,
    };
  }

  // Resolve subaction (with default fallback).
  let chosen: TSubaction | null = parsed.subaction;
  if (!chosen && defaultSubaction) {
    chosen = defaultSubaction;
  }

  if (!chosen) {
    return {
      ok: false,
      missing: parsed.missing.length > 0 ? parsed.missing : ["subaction"],
      clarification: buildClarificationMessage(
        actionName,
        null,
        parsed.missing.length > 0 ? parsed.missing : ["subaction"],
      ),
    };
  }

  // Merge planner-provided params (which take precedence) with extracted params,
  // but only retain keys this subaction actually declares.
  const allowedExtracted = pickKnownParams(chosen, subactions, parsed.params);
  const allowedPlanner = pickKnownParams(chosen, subactions, plannerParams);
  const mergedParams: Record<string, unknown> = {
    ...allowedExtracted,
    ...allowedPlanner,
  };

  const missing = missingRequiredKeys(chosen, subactions, mergedParams);
  const finalMissing =
    missing.length > 0
      ? missing
      : parsed.missing.filter((key) => {
          const required = subactions[chosen as TSubaction]?.required ?? [];
          return (required as readonly string[]).includes(key);
        });

  if (parsed.confidence < MIN_CONFIDENCE || finalMissing.length > 0) {
    return {
      ok: false,
      missing: finalMissing.length > 0 ? finalMissing : ["subaction"],
      clarification: buildClarificationMessage(
        actionName,
        chosen,
        finalMissing,
      ),
      partial: mergedParams as Partial<TParams>,
    };
  }

  return {
    ok: true,
    subaction: chosen,
    params: mergedParams as TParams,
  };
}
