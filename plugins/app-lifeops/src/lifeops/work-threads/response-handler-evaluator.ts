import { hasOwnerAccess } from "@elizaos/agent";
import type {
  ResponseHandlerEvaluator,
  ResponseHandlerPatch,
} from "@elizaos/core";
import { createPendingPromptsStore } from "../pending-prompts/store.js";
import { createWorkThreadStore } from "./store.js";

function messageText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (!content || typeof content !== "object") return "";
  const text = (content as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function looksLikeThreadIntent(text: string): boolean {
  return /\b(thread|conversation|workstream|follow-?up|keep working|continue this|stop this|pause this|merge (?:these|this)|combine (?:these|this)|mark (?:this )?(?:done|complete)|schedule (?:a )?follow-?up)\b/i.test(
    text,
  );
}

export const workThreadResponseHandlerEvaluator: ResponseHandlerEvaluator = {
  name: "lifeops.work_thread_router",
  description:
    "Routes active owner work-thread and pending-prompt turns into the task/messaging planner surface.",
  priority: 40,
  async shouldRun({ runtime, message }) {
    if (!(await hasOwnerAccess(runtime, message))) {
      return false;
    }
    const text = messageText(message);
    if (looksLikeThreadIntent(text)) {
      return true;
    }
    const roomId = typeof message.roomId === "string" ? message.roomId : null;
    if (!roomId) {
      return false;
    }
    const [threads, prompts] = await Promise.all([
      createWorkThreadStore(runtime).list({
        statuses: ["active", "waiting", "paused"],
        roomId,
        limit: 1,
      }),
      createPendingPromptsStore(runtime).list(roomId, { lookbackMinutes: 60 * 24 }),
    ]);
    return threads.length > 0 || prompts.length > 0;
  },
  async evaluate({ runtime, message }): Promise<ResponseHandlerPatch | undefined> {
    const roomId = typeof message.roomId === "string" ? message.roomId : null;
    const ownerEntityId =
      typeof message.entityId === "string" && message.entityId.length > 0
        ? message.entityId
        : undefined;
    const [currentRoomThreads, ownerThreads, prompts] = await Promise.all([
      roomId
        ? createWorkThreadStore(runtime).list({
            statuses: ["active", "waiting", "paused"],
            roomId,
            limit: 3,
          })
        : Promise.resolve([]),
      ownerEntityId
        ? createWorkThreadStore(runtime).list({
            statuses: ["active", "waiting", "paused"],
            ownerEntityId,
            includeCrossChannel: true,
            limit: 3,
          })
        : Promise.resolve([]),
      roomId
        ? createPendingPromptsStore(runtime).list(roomId, {
            lookbackMinutes: 60 * 24,
          })
        : Promise.resolve([]),
    ]);
    const hasThreadState =
      currentRoomThreads.length > 0 || ownerThreads.length > 0 || prompts.length > 0;
    const hasIntent = looksLikeThreadIntent(messageText(message));
    if (!hasThreadState && !hasIntent) {
      return undefined;
    }
    return {
      requiresTool: true,
      simple: false,
      clearReply: true,
      addContexts: ["tasks", "messaging", "automation"],
      addCandidateActions: [
        "work_thread",
        "WORK_THREAD",
        "scheduled_tasks",
        "SCHEDULED_TASKS",
      ],
      addParentActionHints: ["WORK_THREAD", "SCHEDULED_TASKS", "MESSAGE"],
      addContextSlices: [
        hasThreadState
          ? "Active owner work thread or pending prompt is relevant to this turn."
          : "User asked to create or manage durable thread work.",
      ],
      debug: [
        `threads=${currentRoomThreads.length + ownerThreads.length}`,
        `pendingPrompts=${prompts.length}`,
        `intent=${hasIntent ? "yes" : "no"}`,
      ],
    };
  },
};
