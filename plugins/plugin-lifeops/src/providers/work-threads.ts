import { hasOwnerAccess } from "@elizaos/agent";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import {
  createWorkThreadStore,
  type WorkThread,
} from "../lifeops/work-threads/index.js";

const EMPTY: ProviderResult = {
  text: "",
  values: { workThreadCount: 0 },
  data: { workThreads: [] },
};

const MAX_THREADS = 8;

function threadMutability(thread: WorkThread, roomId: string | null): string {
  const refs = [thread.primarySourceRef, ...thread.sourceRefs];
  const currentRoomRef = roomId
    ? refs.find((ref) => ref.roomId === roomId)
    : undefined;
  if (currentRoomRef?.canMutate) {
    return "mutable-current-channel";
  }
  if (currentRoomRef?.canRead) {
    return "read-only-current-channel";
  }
  return "read-only-cross-channel";
}

function renderWorkThreadsText(
  threads: WorkThread[],
  roomId: string | null,
): string {
  if (threads.length === 0) {
    return "";
  }
  const lines = threads.slice(0, MAX_THREADS).map((thread) => {
    const source = thread.primarySourceRef;
    const channel =
      source.channelName ??
      source.roomId ??
      source.externalThreadId ??
      "unknown-channel";
    const plan = thread.currentPlanSummary
      ? ` plan=${thread.currentPlanSummary}`
      : "";
    return `- ${thread.id} [${thread.status}; ${threadMutability(thread, roomId)}; ${source.connector}/${channel}]: ${thread.title} - ${thread.summary}${plan}`;
  });
  if (threads.length > MAX_THREADS) {
    lines.push(`(+${threads.length - MAX_THREADS} more)`);
  }
  return [
    "Active LifeOps work threads:",
    "Use lifeops_thread_control only for lifecycle/routing. Cross-channel entries are read-only unless current-channel mutability is shown.",
    ...lines,
  ].join("\n");
}

export const workThreadsProvider: Provider = {
  name: "workThreads",
  description:
    "Surfaces active LifeOps work threads for the current room and owner. Current-room mutable refs may be steered; cross-channel refs are read-only summaries.",
  descriptionCompressed:
    "Active work threads: current-channel mutable, cross-channel read-only summaries.",
  dynamic: true,
  position: 12,
  cacheScope: "turn",
  contexts: ["tasks", "messaging", "automation"],

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    if (!(await hasOwnerAccess(runtime, message))) {
      return EMPTY;
    }
    const roomId = typeof message.roomId === "string" ? message.roomId : null;
    const ownerEntityId =
      typeof message.entityId === "string" && message.entityId.length > 0
        ? message.entityId
        : undefined;
    const store = createWorkThreadStore(runtime);
    const currentRoomThreads = roomId
      ? await store.list({
          statuses: ["active", "waiting", "paused"],
          roomId,
          limit: MAX_THREADS,
        })
      : [];
    const ownerThreads = ownerEntityId
      ? await store.list({
          statuses: ["active", "waiting", "paused"],
          ownerEntityId,
          includeCrossChannel: true,
          limit: MAX_THREADS,
        })
      : [];
    const byId = new Map<string, WorkThread>();
    for (const thread of [...currentRoomThreads, ...ownerThreads]) {
      byId.set(thread.id, thread);
    }
    const currentRoomThreadIds = new Set(
      currentRoomThreads.map((thread) => thread.id),
    );
    const threads = [...byId.values()]
      .sort((a, b) => {
        const currentRoomDelta =
          Number(currentRoomThreadIds.has(b.id)) -
          Number(currentRoomThreadIds.has(a.id));
        if (currentRoomDelta !== 0) {
          return currentRoomDelta;
        }
        return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
      })
      .slice(0, MAX_THREADS);
    if (threads.length === 0) {
      return EMPTY;
    }
    return {
      text: renderWorkThreadsText(threads, roomId),
      values: {
        workThreadCount: threads.length,
        workThreadIds: threads.map((thread) => thread.id),
      },
      data: { workThreads: threads },
    };
  },
};
