import {
  type IAgentRuntime,
  type Memory,
  ModelType,
  resolveOptimizedPromptForRuntime,
  runWithTrajectoryContext,
  type State,
} from "@elizaos/core";
import {
  GMAIL_PLAN_INSTRUCTIONS,
  GMAIL_QUERY_EXTRACTION_INSTRUCTIONS,
} from "../optimized-prompt-instructions.js";

export {
  GMAIL_PLAN_INSTRUCTIONS,
  GMAIL_QUERY_EXTRACTION_INSTRUCTIONS,
} from "../optimized-prompt-instructions.js";

export type GmailPlanSubaction =
  | "triage"
  | "needs_response"
  | "search"
  | "read"
  | "draft_reply"
  | "send_reply";

const GMAIL_PLAN_SUBACTIONS: ReadonlySet<GmailPlanSubaction> = new Set([
  "triage",
  "needs_response",
  "search",
  "read",
  "draft_reply",
  "send_reply",
]);

/**
 * Coerce a model-emitted subaction string to a known {@link GmailPlanSubaction},
 * falling back to the safe read-shaped default "triage" for a missing/invalid
 * value (#8795). Without this, a malformed model output (e.g. a hallucinated
 * "delete_everything") was blind-cast and flowed downstream as if valid.
 */
function coerceGmailSubaction(value: string | undefined): GmailPlanSubaction {
  const normalized = value?.trim().toLowerCase();
  return normalized &&
    GMAIL_PLAN_SUBACTIONS.has(normalized as GmailPlanSubaction)
    ? (normalized as GmailPlanSubaction)
    : "triage";
}

export interface GmailPlan {
  subaction: GmailPlanSubaction;
  shouldAct: boolean;
  response: string | null;
  queries: string[];
  replyNeededOnly?: boolean;
}

function buildGmailPlanPrompt(instructions: string, intent: string): string {
  return [
    instructions,
    "",
    "Current request:",
    intent.trim() || "(empty)",
  ].join("\n");
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\s*\|\|\s*|\s*,\s*/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseGmailPlan(text: string): GmailPlan {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([a-zA-Z_]+)\s*:\s*(.*)$/u.exec(line.trim());
    if (match) fields.set(match[1].toLowerCase(), match[2].trim());
  }

  const subaction = coerceGmailSubaction(fields.get("subaction"));
  const shouldAct = fields.get("shouldact")?.toLowerCase() !== "false";
  const responseRaw = fields.get("response");
  const response =
    !responseRaw || responseRaw.toLowerCase() === "null" ? null : responseRaw;

  return {
    subaction,
    shouldAct,
    response,
    queries: parseList(fields.get("queries")),
    replyNeededOnly: subaction === "needs_response" ? true : undefined,
  };
}

export async function extractGmailPlanWithLlm(
  runtime: IAgentRuntime,
  _message: Memory,
  _state: State | undefined,
  intent: string,
): Promise<GmailPlan> {
  const instructions = resolveOptimizedPromptForRuntime(
    runtime,
    "inbox_triage",
    GMAIL_PLAN_INSTRUCTIONS,
  );
  const first = String(
    await runWithTrajectoryContext({ purpose: "inbox_triage" }, () =>
      runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: buildGmailPlanPrompt(instructions, intent),
      }),
    ),
  );
  const plan = parseGmailPlan(first);

  if (plan.subaction === "search" && plan.queries.length === 0) {
    const queryInstructions = resolveOptimizedPromptForRuntime(
      runtime,
      "inbox_triage",
      GMAIL_QUERY_EXTRACTION_INSTRUCTIONS,
    );
    const fallback = String(
      await runWithTrajectoryContext({ purpose: "inbox_triage" }, () =>
        runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: buildGmailPlanPrompt(queryInstructions, intent),
        }),
      ),
    );
    plan.queries = parseGmailPlan(fallback).queries;
  }

  return plan;
}
