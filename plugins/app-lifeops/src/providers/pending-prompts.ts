/**
 * `pendingPromptsProvider` — surfaces open prompts for the current room so
 * the planner can route an inbound to an open task's `complete` /
 * `acknowledge` verb instead of treating it as a fresh request.
 *
 * Frozen contract (`wave1-interfaces.md` §4.3 + `GAP_ASSESSMENT.md` §3.11):
 *
 *   list(roomId): Promise<PendingPrompt[]>
 *
 * Where `PendingPrompt = { taskId, promptSnippet, firedAt, expectedReplyKind, expiresAt? }`.
 *
 * Resolution policy (planner-side):
 *   - exactly one open prompt → planner correlates by default
 *   - multiple → planner asks the user OR uses an LLM classifier
 *   - zero → message routes as fresh
 *
 * Open prompts retained `expiresAt + reopenWindowHours` (default 24h).
 */

import { hasOwnerAccess } from "@elizaos/agent";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  createPendingPromptsStore,
  type PendingPrompt,
  type PendingPromptsStore,
} from "../lifeops/pending-prompts/store.js";

export type { PendingPrompt };

export interface PendingPromptsProvider {
  list(
    roomId: string,
    opts?: { lookbackMinutes?: number },
  ): Promise<PendingPrompt[]>;
}

const EMPTY: ProviderResult = {
  text: "",
  values: { pendingPromptCount: 0 },
  data: { pendingPrompts: [] },
};

const PROMPT_LINES_MAX = 5;

function formatPromptLine(prompt: PendingPrompt): string {
  const expires = prompt.expiresAt ? ` (expires ${prompt.expiresAt})` : "";
  return `- task ${prompt.taskId}: ${prompt.promptSnippet} [reply=${prompt.expectedReplyKind}]${expires}`;
}

/**
 * Build the planner-text rendering of the prompt list. Used both by the
 * provider and externally by integration tests.
 */
export function renderPendingPromptsText(prompts: PendingPrompt[]): string {
  if (prompts.length === 0) return "";
  const lines = prompts
    .slice(0, PROMPT_LINES_MAX)
    .map((prompt) => formatPromptLine(prompt));
  if (prompts.length > PROMPT_LINES_MAX) {
    lines.push(`(+${prompts.length - PROMPT_LINES_MAX} more)`);
  }
  return [
    "Open prompts in this room (route inbound to .complete/.acknowledge):",
    ...lines,
  ].join("\n");
}

/**
 * Wraps the underlying store in the frozen `PendingPromptsProvider` shape
 * for non-provider callers (the planner correlation step uses this).
 */
export function createPendingPromptsProvider(
  runtime: IAgentRuntime,
): PendingPromptsProvider {
  const store: PendingPromptsStore = createPendingPromptsStore(runtime);
  return {
    list: (roomId: string, opts) => store.list(roomId, opts),
  };
}

export const pendingPromptsProvider: Provider = {
  name: "pendingPrompts",
  description:
    "Surfaces open prompts (fired ScheduledTasks awaiting the user's reply) " +
    "for the current room. Lets the planner correlate the next inbound to an open task's complete/acknowledge verb.",
  descriptionCompressed:
    "Open prompts per room — correlate inbound to open task verb.",
  dynamic: true,
  // Sit ahead of the lifeops capability provider so correlation runs first.
  position: 11,
  cacheScope: "turn",
  contexts: ["messaging", "tasks"],

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    if (!(await hasOwnerAccess(runtime, message))) {
      return EMPTY;
    }
    const roomId = typeof message.roomId === "string" ? message.roomId : null;
    if (!roomId) return EMPTY;

    let store: PendingPromptsStore;
    try {
      store = createPendingPromptsStore(runtime);
    } catch (error) {
      logger.debug?.(
        "[pending-prompts-provider] store unavailable:",
        String(error),
      );
      return EMPTY;
    }

    let prompts: PendingPrompt[];
    try {
      prompts = await store.list(roomId);
    } catch (error) {
      logger.debug?.("[pending-prompts-provider] list failed:", String(error));
      return EMPTY;
    }
    if (prompts.length === 0) return EMPTY;

    return {
      text: renderPendingPromptsText(prompts),
      values: {
        pendingPromptCount: prompts.length,
        pendingPromptTaskIds: prompts.map((p) => p.taskId),
      },
      data: { pendingPrompts: prompts },
    };
  },
};
