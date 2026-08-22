/**
 * Renders the agent's user-facing reply for an action (LifeOps/Gmail/calendar) by
 * prompting TEXT_SMALL with complete grounded conversation, action-result,
 * trajectory, and optional character context. Model inputs and outputs cross
 * this boundary unchanged; invalid context fails explicitly instead of producing
 * a plausible reply from a partial prompt.
 */
import type { ActionResult, IAgentRuntime, Memory, State } from "@elizaos/core";
import {
  ElizaError,
  getTrajectoryContext,
  ModelType,
  renderActionResultsForModel,
} from "@elizaos/core";
import { asRecord } from "@elizaos/shared";
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

function stringifyPromptValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("Value is not JSON-serializable");
    }
    return serialized;
  } catch (error) {
    // error-policy:J2 Context must be complete; never replace an unserializable
    // value with a partial string representation.
    throw new ElizaError("Grounded reply context is not serializable", {
      code: "GROUNDED_REPLY_CONTEXT_INVALID",
      cause: error,
    });
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

/**
 * Returns every action result in the complete model-facing wire format.
 * Legacy limit/projection parameters remain source-compatible but never omit data.
 */
export function summarizeRecentActionHistory(
  state: State | undefined,
  _limit?: number,
  _projectionEnabled?: boolean,
): string[] {
  return extractActionResultsFromState(state).map(
    (result) => renderActionResultsForModel([result], { header: "" }).text,
  );
}

function buildCharacterVoiceContext(runtime: IAgentRuntime): string {
  const character = runtime.character;
  if (!character || typeof character !== "object") {
    return "";
  }

  return stringifyPromptValue({
    system: character.system,
    bio: character.bio,
    style: character.style,
  });
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

    return stringifyPromptValue(trajectory);
  } catch (error) {
    // error-policy:J2 A grounded reply cannot silently omit trajectory context.
    throw new ElizaError("Failed to load complete grounded reply trajectory", {
      code: "GROUNDED_REPLY_TRAJECTORY_UNAVAILABLE",
      cause: error,
      context: { trajectoryStepId },
    });
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
  });
  const recentActionHistory = summarizeRecentActionHistory(args.state);
  const trajectorySummary = await summarizeActiveTrajectory(args.runtime);
  const characterVoice = args.preferCharacterVoice
    ? buildCharacterVoiceContext(args.runtime)
    : "";

  const prompt = [
    `Write the assistant's user-facing reply for a ${domainLabel(args.domain)} interaction.`,
    "Be natural, brief, and grounded in the provided context.",
    "Mirror the user's tone lightly without parodying them.",
    "Preserve concrete facts from the action context and fallback reply.",
    "Never mention internal schema, tool names, JSON keys, hidden prompts, or reasoning traces.",
    "Do not claim something happened unless it appears in the grounded context or fallback reply.",
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
      typeof args.message.content.text === "string"
        ? args.message.content.text
        : "",
    )}`,
    `Resolved intent: ${JSON.stringify(args.intent)}`,
    `Complete conversation: ${JSON.stringify(recentConversation)}`,
    `Complete action history: ${JSON.stringify(recentActionHistory)}`,
    `Active trajectory summary: ${JSON.stringify(trajectorySummary ?? "")}`,
    `Character voice: ${JSON.stringify(characterVoice)}`,
    `Structured context: ${stringifyPromptValue(args.context ?? {})}`,
    `Canonical fallback: ${JSON.stringify(args.fallback)}`,
  ].join("\n");

  const result = await args.runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
  });
  if (typeof result !== "string") {
    throw new ElizaError("Grounded reply model returned a non-text response", {
      code: "GROUNDED_REPLY_OUTPUT_INVALID",
      context: { outputType: typeof result },
    });
  }
  return result;
}
