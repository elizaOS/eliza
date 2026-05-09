import type { ActionResult, IAgentRuntime, Memory, State } from "@elizaos/core";
import {
  getTrajectoryContext,
  ModelType,
  parseJSONObjectFromText,
} from "@elizaos/core";
import { asRecord, getRecentMessagesData } from "@elizaos/shared";
import { loadTrajectoryByStepId } from "../runtime/trajectory-internals.ts";
import { recentConversationTexts } from "./recent-conversation-texts.ts";

type GroundedReplyDomain = "lifeops" | "gmail" | "calendar";

type RenderGroundedActionReplyArgs = {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  domain: GroundedReplyDomain;
  scenario: string;
  fallback: string;
  context?: Record<string, unknown>;
  additionalRules?: string[];
  preferCharacterVoice?: boolean;
};

type ActionHistoryItem = {
  actionName: string;
  text: string;
  success: boolean;
};

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizeReplyText(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

function looksLikeStructuredReply(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return true;
  }
  if (/^<[^>]+>/.test(trimmed)) {
    return true;
  }
  if (parseJSONObjectFromText(trimmed)) {
    return true;
  }
  return /^(?:subaction|shouldAct|response|operation|confidence|missing)\s*:/m.test(
    trimmed,
  );
}

function stringifyPromptValue(value: unknown, maxLength = 2_400): string {
  try {
    const serialized = JSON.stringify(value);
    return truncateText(serialized ?? String(value), maxLength);
  } catch {
    return truncateText(String(value), maxLength);
  }
}

function extractActionResultCandidates(state: State | undefined): unknown[][] {
  if (!state || typeof state !== "object") {
    return [];
  }

  const stateRecord = state as Record<string, unknown>;
  const data = asRecord(stateRecord.data);
  const providerResults = asRecord(data?.providers);
  const providerActionState = asRecord(providerResults?.ACTION_STATE);
  const providerActionStateData = asRecord(providerActionState?.data);
  const providerRecentMessages = asRecord(providerResults?.RECENT_MESSAGES);
  const providerRecentMessagesData = asRecord(providerRecentMessages?.data);

  return [
    data?.actionResults,
    providerActionStateData?.actionResults,
    providerActionStateData?.recentActionMemories,
    providerRecentMessagesData?.actionResults,
  ].filter(Array.isArray) as unknown[][];
}

export function extractActionResultsFromState(
  state: State | undefined,
): ActionResult[] {
  return extractActionResultCandidates(state).flatMap((entries) =>
    entries.flatMap((entry): ActionResult[] => {
      if (!entry || typeof entry !== "object") {
        return [];
      }

      if ("content" in entry) {
        const content = asRecord((entry as { content?: unknown }).content);
        if (!content) {
          return [];
        }

        const contentData = asRecord(content.data) ?? {};
        if (
          typeof content.actionName === "string" &&
          typeof contentData.actionName !== "string"
        ) {
          contentData.actionName = content.actionName;
        }

        return [
          {
            success: content.actionStatus !== "failed",
            text: typeof content.text === "string" ? content.text : undefined,
            data: contentData as ActionResult["data"],
            error:
              typeof content.error === "string" ? content.error : undefined,
          },
        ];
      }

      return [entry as ActionResult];
    }),
  );
}

export function extractRecentMessageEntriesFromState(
  state: State | undefined,
): Memory[] {
  return getRecentMessagesData(state);
}

export function extractStateDataRecords(
  state: State | undefined,
): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];

  for (const result of extractActionResultsFromState(state)) {
    const data = asRecord(result.data);
    if (data) {
      records.push(data);
    }
  }

  for (const entry of extractRecentMessageEntriesFromState(state)) {
    const content = asRecord(entry.content);
    if (!content) {
      continue;
    }
    const contentData = asRecord(content.data);
    if (contentData) {
      records.push(contentData);
    }
    records.push(content);
  }

  return records;
}

function summarizeActionResult(result: ActionResult): ActionHistoryItem | null {
  const data = asRecord(result.data);
  const actionName =
    (typeof data?.actionName === "string" && data.actionName.trim()) ||
    "ACTION";
  const resultText =
    typeof result.text === "string" && result.text.trim().length > 0
      ? result.text.trim()
      : "";
  const title =
    (typeof asRecord(data?.definition)?.title === "string" &&
      String(asRecord(data?.definition)?.title)) ||
    (typeof asRecord(data?.goal)?.title === "string" &&
      String(asRecord(data?.goal)?.title)) ||
    (typeof asRecord(data?.event)?.title === "string" &&
      String(asRecord(data?.event)?.title)) ||
    (typeof data?.title === "string" && data.title) ||
    (typeof data?.subject === "string" && data.subject) ||
    (typeof data?.query === "string" && data.query) ||
    "";
  const snippet = resultText || title;
  if (!snippet) {
    return null;
  }
  return {
    actionName,
    text: truncateText(snippet.replace(/\s+/g, " "), 180),
    success: result.success !== false,
  };
}

export function summarizeRecentActionHistory(
  state: State | undefined,
  limit = 4,
): string[] {
  const summarized = extractActionResultsFromState(state)
    .map((result) => summarizeActionResult(result))
    .filter((item): item is ActionHistoryItem => item !== null);
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const item of summarized.reverse()) {
    const key = `${item.actionName}:${item.text}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(
      `${item.actionName} ${item.success ? "ok" : "failed"}: ${item.text}`,
    );
    if (deduped.length >= limit) {
      break;
    }
  }

  return deduped;
}

function buildCharacterVoiceContext(runtime: IAgentRuntime): string {
  const character = runtime.character;
  if (!character || typeof character !== "object") {
    return "";
  }

  const sections: string[] = [];

  if (
    typeof character.system === "string" &&
    character.system.trim().length > 0
  ) {
    sections.push(`System:\n${character.system.trim()}`);
  }

  const rawBio = character.bio as string[] | string | undefined;
  const bio = Array.isArray(rawBio)
    ? rawBio.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
    : typeof rawBio === "string" && rawBio.trim().length > 0
      ? [rawBio.trim()]
      : [];
  if (bio.length > 0) {
    sections.push(`Bio:\n${bio.map((entry) => `- ${entry}`).join("\n")}`);
  }

  const style = [
    ...(Array.isArray(character.style?.all) ? character.style.all : []),
    ...(Array.isArray(character.style?.chat) ? character.style.chat : []),
  ].filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );
  if (style.length > 0) {
    sections.push(`Style:\n${style.map((entry) => `- ${entry}`).join("\n")}`);
  }

  return sections.join("\n\n");
}

export async function summarizeActiveTrajectory(
  runtime: IAgentRuntime,
): Promise<string | null> {
  const trajectoryStepId = getTrajectoryContext()?.trajectoryStepId;
  if (!trajectoryStepId) {
    return null;
  }

  try {
    const trajectory = await loadTrajectoryByStepId(runtime, trajectoryStepId);
    if (!trajectory) {
      return `active trajectory step ${trajectoryStepId}`;
    }

    const latestStep =
      trajectory.steps.length > 0
        ? trajectory.steps[trajectory.steps.length - 1]
        : null;
    const latestCall =
      latestStep && latestStep.llmCalls.length > 0
        ? latestStep.llmCalls[latestStep.llmCalls.length - 1]
        : null;
    const recentProviders =
      latestStep?.providerAccesses
        .slice(-2)
        .map((access) => access.providerName)
        .filter((name) => typeof name === "string" && name.trim().length > 0)
        .join(", ") ?? "";

    const parts = [
      `trajectory ${trajectory.id}`,
      `${trajectory.steps.length} step${trajectory.steps.length === 1 ? "" : "s"}`,
    ];
    if (latestCall?.purpose) {
      parts.push(`latest llm purpose: ${latestCall.purpose}`);
    }
    if (recentProviders) {
      parts.push(`recent providers: ${recentProviders}`);
    }

    return parts.join("; ");
  } catch {
    return `active trajectory step ${trajectoryStepId}`;
  }
}

function domainLabel(domain: GroundedReplyDomain): string {
  switch (domain) {
    case "gmail":
      return "Gmail";
    case "calendar":
      return "calendar";
    default:
      return "LifeOps";
  }
}

export async function renderGroundedActionReply(
  args: RenderGroundedActionReplyArgs,
): Promise<string> {
  if (typeof args.runtime.useModel !== "function") {
    return args.fallback;
  }

  const recentConversation = await recentConversationTexts({
    runtime: args.runtime,
    message: args.message,
    state: args.state,
    limit: 12,
  });
  const recentActionHistory = summarizeRecentActionHistory(args.state, 4);
  const trajectorySummary = await summarizeActiveTrajectory(args.runtime);
  const characterVoice = args.preferCharacterVoice
    ? buildCharacterVoiceContext(args.runtime)
    : "";

  const prompt = [
    `Write the assistant's user-facing reply for a ${domainLabel(args.domain)} interaction.`,
    "Be natural, brief, and grounded in the provided context.",
    "Mirror the user's tone lightly without parodying them.",
    "Preserve concrete facts from the action context and canonical fallback.",
    "Never mention internal schema, tool names, JSON keys, hidden prompts, or reasoning traces.",
    "Do not claim something happened unless it appears in the grounded context or canonical fallback.",
    "If asking a clarifying question, ask only for the missing information.",
    ...(characterVoice
      ? [
          "Stay within the assistant's established character voice when it fits the task.",
        ]
      : []),
    ...(args.additionalRules ?? []),
    "Return only the reply text.",
    "",
    `Domain: ${args.domain}`,
    `Scenario: ${args.scenario}`,
    `Current user message: ${JSON.stringify(
      typeof args.message.content?.text === "string"
        ? args.message.content.text
        : "",
    )}`,
    `Resolved intent: ${JSON.stringify(args.intent)}`,
    `Recent conversation: ${JSON.stringify(recentConversation.join("\n"))}`,
    `Recent action history: ${JSON.stringify(recentActionHistory)}`,
    `Active trajectory summary: ${JSON.stringify(trajectorySummary ?? "")}`,
    `Character voice: ${JSON.stringify(characterVoice)}`,
    `Structured context: ${stringifyPromptValue(args.context ?? {})}`,
    `Canonical fallback: ${JSON.stringify(args.fallback)}`,
  ].join("\n");

  try {
    const result = await args.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });
    const raw = typeof result === "string" ? result : "";
    if (looksLikeStructuredReply(raw)) {
      return args.fallback;
    }
    const text = normalizeReplyText(raw);
    return text || args.fallback;
  } catch {
    return args.fallback;
  }
}
