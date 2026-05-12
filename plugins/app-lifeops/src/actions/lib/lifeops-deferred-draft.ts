/**
 * Deferred-draft state machine for OWNER_LIFE create flows.
 *
 * Multi-turn create_definition / create_goal flows preview a draft, then
 * wait for the user to confirm, edit, or cancel on a follow-up turn. The
 * draft lives in the trailing ActionResult / message content under
 * `lifeDraft`; this module owns the parsing, expiry, and reuse-mode
 * decision so the umbrella action can stay focused on dispatch.
 */
import type { ActionResult, IAgentRuntime, Memory, State } from "@elizaos/core";
import {
  ModelType,
  runWithTrajectoryContext,
} from "@elizaos/core";
import { getRecentMessagesData } from "@elizaos/shared";
import { parseJsonModelRecord } from "../../utils/json-model-output.js";
import type {
  CreateLifeOpsDefinitionRequest,
  CreateLifeOpsGoalRequest,
  LifeOpsCadence,
} from "../../contracts/index.js";
import { recentConversationTexts } from "./recent-context.js";

/** Maximum age (ms) for a deferred draft before it expires. */
export const DRAFT_EXPIRY_MS = 5 * 60 * 1000;
/** Maximum conversation turns before a deferred draft expires. */
export const DRAFT_MAX_TURNS = 3;

export type DeferredLifeDefinitionDraft = {
  intent: string;
  operation: "create_definition";
  /** Epoch ms when the draft was created. Used for expiry. */
  createdAt?: number;
  request: {
    cadence: LifeOpsCadence;
    description?: string;
    goalRef?: string;
    kind: CreateLifeOpsDefinitionRequest["kind"];
    priority?: number;
    progressionRule?: CreateLifeOpsDefinitionRequest["progressionRule"];
    reminderPlan?: CreateLifeOpsDefinitionRequest["reminderPlan"];
    timezone?: string;
    title: string;
    metadata?: CreateLifeOpsDefinitionRequest["metadata"];
    windowPolicy?: CreateLifeOpsDefinitionRequest["windowPolicy"];
    websiteAccess?: CreateLifeOpsDefinitionRequest["websiteAccess"];
  };
};

export type DeferredLifeGoalDraft = {
  intent: string;
  operation: "create_goal";
  /** Epoch ms when the draft was created. Used for expiry. */
  createdAt?: number;
  request: {
    cadence?: CreateLifeOpsGoalRequest["cadence"];
    description?: string;
    metadata?: CreateLifeOpsGoalRequest["metadata"];
    successCriteria?: CreateLifeOpsGoalRequest["successCriteria"];
    supportStrategy?: CreateLifeOpsGoalRequest["supportStrategy"];
    title: string;
  };
};

export type DeferredLifeDraft =
  | DeferredLifeDefinitionDraft
  | DeferredLifeGoalDraft;

export type DeferredLifeDraftReuseMode = "confirm" | "edit";
export type DeferredLifeDraftFollowupMode =
  | DeferredLifeDraftReuseMode
  | "cancel"
  | null;

export function coerceDeferredLifeDraft(
  value: unknown,
): DeferredLifeDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const operation = record.operation;
  const intent = typeof record.intent === "string" ? record.intent.trim() : "";
  const request =
    record.request && typeof record.request === "object"
      ? (record.request as Record<string, unknown>)
      : null;
  const createdAt =
    typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
      ? record.createdAt
      : undefined;

  if (!request || !intent) {
    return null;
  }

  const title = typeof request.title === "string" ? request.title.trim() : "";
  if (!title) {
    return null;
  }

  if (operation === "create_definition") {
    const kind =
      typeof request.kind === "string"
        ? (request.kind as CreateLifeOpsDefinitionRequest["kind"])
        : null;
    const cadence = request.cadence as LifeOpsCadence | undefined;
    if (!kind || !cadence) {
      return null;
    }
    return {
      createdAt,
      intent,
      operation,
      request: {
        cadence,
        description:
          typeof request.description === "string"
            ? request.description
            : undefined,
        goalRef:
          typeof request.goalRef === "string" ? request.goalRef : undefined,
        kind,
        priority:
          typeof request.priority === "number" ? request.priority : undefined,
        progressionRule:
          request.progressionRule as CreateLifeOpsDefinitionRequest["progressionRule"],
        reminderPlan:
          request.reminderPlan as CreateLifeOpsDefinitionRequest["reminderPlan"],
        timezone:
          typeof request.timezone === "string" ? request.timezone : undefined,
        title,
        metadata:
          request.metadata && typeof request.metadata === "object"
            ? (request.metadata as CreateLifeOpsDefinitionRequest["metadata"])
            : undefined,
        windowPolicy:
          request.windowPolicy as CreateLifeOpsDefinitionRequest["windowPolicy"],
        websiteAccess:
          request.websiteAccess as CreateLifeOpsDefinitionRequest["websiteAccess"],
      },
    };
  }

  if (operation === "create_goal") {
    return {
      createdAt,
      intent,
      operation,
      request: {
        cadence: request.cadence as CreateLifeOpsGoalRequest["cadence"],
        description:
          typeof request.description === "string"
            ? request.description
            : undefined,
        metadata:
          request.metadata && typeof request.metadata === "object"
            ? (request.metadata as CreateLifeOpsGoalRequest["metadata"])
            : undefined,
        successCriteria:
          request.successCriteria as CreateLifeOpsGoalRequest["successCriteria"],
        supportStrategy:
          request.supportStrategy as CreateLifeOpsGoalRequest["supportStrategy"],
        title,
      },
    };
  }

  return null;
}

function stateActionResults(state: State | undefined): ActionResult[] {
  if (!state || typeof state !== "object") {
    return [];
  }
  const stateRecord = state as Record<string, unknown>;
  const data =
    stateRecord.data && typeof stateRecord.data === "object"
      ? (stateRecord.data as Record<string, unknown>)
      : undefined;
  const providerResults =
    data?.providers && typeof data.providers === "object"
      ? (data.providers as Record<string, unknown>)
      : undefined;
  const providerActionState =
    providerResults?.ACTION_STATE &&
    typeof providerResults.ACTION_STATE === "object"
      ? (providerResults.ACTION_STATE as Record<string, unknown>)
      : undefined;
  const providerActionStateData =
    providerActionState?.data && typeof providerActionState.data === "object"
      ? (providerActionState.data as Record<string, unknown>)
      : undefined;
  const providerRecentMessages =
    providerResults?.RECENT_MESSAGES &&
    typeof providerResults.RECENT_MESSAGES === "object"
      ? (providerResults.RECENT_MESSAGES as Record<string, unknown>)
      : undefined;
  const providerRecentMessagesData =
    providerRecentMessages?.data &&
    typeof providerRecentMessages.data === "object"
      ? (providerRecentMessages.data as Record<string, unknown>)
      : undefined;

  const candidates = [
    data?.actionResults,
    providerActionStateData?.actionResults,
    providerActionStateData?.recentActionMemories,
    providerRecentMessagesData?.actionResults,
  ].filter(Array.isArray) as unknown[][];

  if (candidates.length === 0) {
    return [];
  }

  return candidates.flatMap((entries) =>
    entries.flatMap((entry): ActionResult[] => {
      if (!entry || typeof entry !== "object") {
        return [];
      }

      if ("content" in entry) {
        const content =
          (entry as { content?: unknown }).content &&
          typeof (entry as { content?: unknown }).content === "object"
            ? ((entry as { content: Record<string, unknown> })
                .content as Record<string, unknown>)
            : null;
        if (!content) {
          return [];
        }

        const contentData =
          content.data && typeof content.data === "object"
            ? ({ ...(content.data as Record<string, unknown>) } as Record<
                string,
                unknown
              >)
            : {};
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
            data: contentData as import("@elizaos/core").ProviderDataRecord,
            error:
              typeof content.error === "string" ? content.error : undefined,
          },
        ];
      }

      return [entry as ActionResult];
    }),
  );
}

function stateMessageDrafts(state: State | undefined): DeferredLifeDraft[] {
  if (!state || typeof state !== "object") {
    return [];
  }

  const drafts: DeferredLifeDraft[] = [];
  for (const item of getRecentMessagesData(state)) {
    const content = item.content;
    if (!content || typeof content !== "object") {
      continue;
    }
    const contentRecord = content as Record<string, unknown>;
    const candidate =
      coerceDeferredLifeDraft(contentRecord.lifeDraft) ??
      coerceDeferredLifeDraft(
        contentRecord.data && typeof contentRecord.data === "object"
          ? (contentRecord.data as Record<string, unknown>).lifeDraft
          : undefined,
      );
    if (candidate) {
      drafts.push(candidate);
    }
  }

  return drafts;
}

function stateRecentMessageEntries(state: State | undefined): Memory[] {
  if (!state || typeof state !== "object") {
    return [];
  }

  return getRecentMessagesData(state);
}

function isDeferredLifeDraftMessageEntry(item: Memory): boolean {
  const content =
    item.content && typeof item.content === "object"
      ? (item.content as Record<string, unknown>)
      : null;
  if (!content) {
    return false;
  }
  return Boolean(
    coerceDeferredLifeDraft(content.lifeDraft) ??
      coerceDeferredLifeDraft(
        content.data && typeof content.data === "object"
          ? (content.data as Record<string, unknown>).lifeDraft
          : undefined,
      ),
  );
}

export function countTurnsSinceLatestDeferredLifeDraft(
  state: State | undefined,
): number | undefined {
  const entries = stateRecentMessageEntries(state);
  if (entries.length === 0) {
    return undefined;
  }

  let latestDraftIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry && isDeferredLifeDraftMessageEntry(entry)) {
      latestDraftIndex = index;
      break;
    }
  }
  if (latestDraftIndex < 0) {
    return undefined;
  }

  let turns = 0;
  for (const entry of entries.slice(latestDraftIndex + 1)) {
    const content =
      entry.content && typeof entry.content === "object"
        ? (entry.content as Record<string, unknown>)
        : null;
    if (!content || isDeferredLifeDraftMessageEntry(entry)) {
      continue;
    }
    if (typeof content.text === "string" && content.text.trim().length > 0) {
      turns++;
    }
  }
  return turns;
}

export function latestDeferredLifeDraft(
  state: State | undefined,
): DeferredLifeDraft | null {
  for (const result of [...stateActionResults(state)].reverse()) {
    const resultData =
      result.data && typeof result.data === "object"
        ? (result.data as Record<string, unknown>)
        : null;
    const completedCreate =
      result.success &&
      resultData &&
      !coerceDeferredLifeDraft(resultData.lifeDraft) &&
      ((resultData.definition && typeof resultData.definition === "object") ||
        (resultData.goal && typeof resultData.goal === "object"));
    if (completedCreate) {
      return null;
    }

    const candidate = coerceDeferredLifeDraft(result.data?.lifeDraft);
    if (candidate) {
      return candidate;
    }
  }

  const messageDrafts = stateMessageDrafts(state);
  return messageDrafts.at(-1) ?? null;
}

export function deferredLifeDraftExpiryReason(args: {
  draft: DeferredLifeDraft | null;
  turnsSinceDraft?: number;
}): "age" | "turns" | null {
  if (!args.draft) {
    return null;
  }

  if (args.draft.createdAt) {
    const ageMs = Date.now() - args.draft.createdAt;
    if (ageMs >= DRAFT_EXPIRY_MS) {
      return "age";
    }
  }
  if (
    typeof args.turnsSinceDraft === "number" &&
    args.turnsSinceDraft >= DRAFT_MAX_TURNS
  ) {
    return "turns";
  }
  return null;
}

function formatPromptRecord(value: unknown): string {
  if (value === null || value === undefined) {
    return "  null";
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return `  ${String(value)}`;
  }
  const lines = Object.entries(value as Record<string, unknown>).map(
    ([key, entry]) => {
      if (entry === null || entry === undefined) {
        return `  ${key}: null`;
      }
      if (Array.isArray(entry)) {
        return `  ${key}: [${entry.map((item) => String(item)).join(", ")}]`;
      }
      if (typeof entry === "object") {
        return `  ${key}: ${formatPromptRecord(entry).trim()}`;
      }
      return `  ${key}: ${String(entry)}`;
    },
  );
  return lines.length > 0 ? lines.join("\n") : "  null";
}

export function stringifyDeferredLifeDraftForPrompt(
  draft: DeferredLifeDraft,
): string {
  if (draft.operation === "create_definition") {
    return [
      `operation: ${draft.operation}`,
      `title: ${draft.request.title}`,
      `kind: ${draft.request.kind}`,
      "cadence:",
      formatPromptRecord(draft.request.cadence),
      `timezone: ${draft.request.timezone ?? "null"}`,
      `description: ${draft.request.description ?? "null"}`,
    ].join("\n");
  }

  return [
    `operation: ${draft.operation}`,
    `title: ${draft.request.title}`,
    "cadence:",
    formatPromptRecord(draft.request.cadence ?? null),
    `description: ${draft.request.description ?? "null"}`,
  ].join("\n");
}

export async function extractDeferredLifeDraftFollowupWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  currentText: string;
  draft: DeferredLifeDraft;
}): Promise<DeferredLifeDraftFollowupMode> {
  if (typeof args.runtime.useModel !== "function") {
    return null;
  }

  const recentConversation = await recentConversationTexts({
    runtime: args.runtime,
    message: args.message,
    state: args.state,
    limit: 12,
  });
  const prompt = [
    "Decide how the assistant should interpret the user's follow-up to a previewed LifeOps draft that has not been saved yet.",
    "Use the current message, the draft summary, and recent conversation.",
    "The user may speak in any language.",
    "",
    'Return ONLY a JSON object with exactly this field, for example {"mode":"confirm"}.',
    "",
    "Choose confirm when the user clearly approves saving the current draft now.",
    "Choose edit when the user wants to change the draft or continue specifying it before saving.",
    "Choose cancel when the user says not to save it, never mind, not yet, hold off, or equivalent.",
    "Choose none when the follow-up is unrelated or too ambiguous to attach to the draft.",
    "",
    "Previewed draft:",
    stringifyDeferredLifeDraftForPrompt(args.draft),
    "",
    `Current user message: ${args.currentText.trim() || "(empty)"}`,
    "Recent conversation:",
    recentConversation.join("\n").trim() || "(empty)",
  ].join("\n");

  try {
    const result = await runWithTrajectoryContext(
      { purpose: "lifeops-deferred-draft" },
      () =>
        args.runtime.useModel(ModelType.TEXT_LARGE, {
          prompt,
        }),
    );
    const raw = typeof result === "string" ? result : "";
    const parsed = parseJsonModelRecord<Record<string, unknown>>(raw);
    const mode =
      parsed && typeof parsed.mode === "string"
        ? parsed.mode.trim().toLowerCase()
        : "";
    switch (mode) {
      case "confirm":
      case "edit":
      case "cancel":
        return mode;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
