import type { IAgentRuntime, Memory, State } from "@elizaos/core";

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
  const first = String(
    await runtime.useModel("TEXT_SMALL", {
      prompt: intent,
    }),
  );
  const plan = parseGmailPlan(first);

  if (plan.subaction === "search" && plan.queries.length === 0) {
    const fallback = String(
      await runtime.useModel("TEXT_SMALL", {
        prompt: `Extract Gmail search queries for: ${intent}`,
      }),
    );
    plan.queries = parseGmailPlan(fallback).queries;
  }

  return plan;
}
