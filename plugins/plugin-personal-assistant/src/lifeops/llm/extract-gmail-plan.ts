import {
  type IAgentRuntime,
  type Memory,
  ModelType,
  resolveOptimizedPromptForRuntime,
  runWithTrajectoryContext,
  type State,
} from "@elizaos/core";

export type GmailPlanSubaction =
  | "triage"
  | "needs_response"
  | "search"
  | "read"
  | "draft_reply"
  | "send_reply";

export interface GmailPlan {
  subaction: GmailPlanSubaction;
  shouldAct: boolean;
  response: string | null;
  queries: string[];
  replyNeededOnly?: boolean;
}

export const GMAIL_PLAN_INSTRUCTIONS = [
  "Plan the Gmail/inbox triage action for this request.",
  "The user may speak in any language.",
  "Use only Gmail/inbox actions. Do not plan calendar, reminder, or document work here.",
  "Return line-based fields only:",
  "subaction: triage | needs_response | search | read | draft_reply | send_reply",
  "shouldAct: true | false",
  "response: null or a short clarification",
  "queries: up to 3 concise Gmail search queries separated by ||",
  "",
  "Choose triage for broad inbox cleanup or priority review.",
  "Choose needs_response when the owner asks what needs a reply.",
  "Choose search/read when the owner asks for specific messages.",
  "Choose draft_reply or send_reply only when the owner explicitly asks to respond.",
  "Set shouldAct=false when the request is too vague to choose safely.",
].join("\n");

export const GMAIL_QUERY_EXTRACTION_INSTRUCTIONS = [
  "Extract Gmail search queries for the owner's request.",
  "Return line-based fields only:",
  "subaction: search",
  "shouldAct: true",
  "response: null",
  "queries: up to 3 concise Gmail search queries separated by ||",
].join("\n");

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

  const subaction = (fields.get("subaction") || "triage") as GmailPlanSubaction;
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
