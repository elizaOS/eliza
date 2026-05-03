import {
  AgentRuntime,
  ChannelType,
  type Content,
  createMessageMemory,
  EventType,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { plugin as localdbPlugin } from "@elizaos/plugin-localdb";
import {
  ELIZAGOTCHI_STATE_UPDATED_EVENT,
  type ElizagotchiStateUpdatedPayload,
  elizagotchiPlugin,
} from "./plugin";
import type { AnimationType, PetState, SaveData } from "./types";

// ============================================================================
// Runtime singleton (browser)
// ============================================================================

let runtimeInstance: AgentRuntime | null = null;
let initializationPromise: Promise<AgentRuntime> | null = null;

const userId = stringToUuid("elizagotchi-user");
const roomId = stringToUuid("elizagotchi-room");
const worldId = stringToUuid("elizagotchi-world");

// ============================================================================
// Agent log subscriptions (enable/disable in UI)
// ============================================================================

export type ElizagotchiAgentLogEntry = {
  id: string;
  timestamp: number;
  kind: "ACTION_STARTED" | "ACTION_COMPLETED";
  action: string;
  status?: string;
  text?: string;
};

type AgentLogListener = (entry: ElizagotchiAgentLogEntry) => void;

const agentLogListeners = new Set<AgentLogListener>();
let agentLogRegistered = false;

function pushAgentLog(entry: ElizagotchiAgentLogEntry): void {
  for (const listener of agentLogListeners) {
    listener(entry);
  }
}

async function initializeRuntime(): Promise<AgentRuntime> {
  const runtime = new AgentRuntime({
    character: {
      name: "Elizagotchi Agent",
      bio: [
        "A virtual pet simulation agent. The pet's state lives inside the agent runtime.",
      ],
    },
    plugins: [localdbPlugin, elizagotchiPlugin],
  });

  await runtime.initialize();

  await runtime.ensureConnection({
    entityId: userId,
    roomId,
    worldId,
    userName: "Player",
    source: "elizagotchi-ui",
    channelId: "elizagotchi",
    type: ChannelType.DM,
  });

  // Register once: observe action execution events from the runtime.
  if (!agentLogRegistered) {
    agentLogRegistered = true;

    runtime.registerEvent(EventType.ACTION_STARTED, async (payload) => {
      const action =
        Array.isArray(payload.content.actions) &&
        typeof payload.content.actions[0] === "string"
          ? payload.content.actions[0]
          : "UNKNOWN_ACTION";

      const status =
        typeof payload.content.actionStatus === "string"
          ? payload.content.actionStatus
          : undefined;

      const text =
        typeof payload.content.text === "string"
          ? payload.content.text
          : undefined;

      pushAgentLog({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        kind: "ACTION_STARTED",
        action,
        status,
        text,
      });
    });

    runtime.registerEvent(EventType.ACTION_COMPLETED, async (payload) => {
      const action =
        Array.isArray(payload.content.actions) &&
        typeof payload.content.actions[0] === "string"
          ? payload.content.actions[0]
          : "UNKNOWN_ACTION";

      const status =
        typeof payload.content.actionStatus === "string"
          ? payload.content.actionStatus
          : undefined;

      const text =
        typeof payload.content.text === "string"
          ? payload.content.text
          : undefined;

      pushAgentLog({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        kind: "ACTION_COMPLETED",
        action,
        status,
        text,
      });
    });
  }

  return runtime;
}

export async function getElizagotchiRuntime(): Promise<AgentRuntime> {
  if (runtimeInstance) return runtimeInstance;
  if (initializationPromise) return initializationPromise;

  initializationPromise = initializeRuntime();
  runtimeInstance = await initializationPromise;
  initializationPromise = null;

  return runtimeInstance;
}

// ============================================================================
// Public API: send commands through the agent message pipeline
// ============================================================================

export type ElizagotchiClientEvent = {
  type: string;
  text?: string;
  animation?: AnimationType;
  petState?: PetState;
  saveData?: SaveData;
};

export async function sendElizagotchiCommand(
  text: string,
): Promise<ElizagotchiClientEvent | null> {
  const runtime = await getElizagotchiRuntime();
  if (!runtime.messageService) {
    throw new Error("Runtime message service not available");
  }

  const messageId = crypto.randomUUID() as UUID;
  const message = createMessageMemory({
    id: messageId,
    entityId: userId,
    roomId,
    content: {
      text,
      source: "client_chat",
      channelType: ChannelType.DM,
    },
  });

  let lastEvent: ElizagotchiClientEvent | null = null;

  await runtime.messageService.handleMessage(
    runtime,
    message,
    async (content: Content): Promise<Memory[]> => {
      const type = typeof content.type === "string" ? content.type : "unknown";
      const animation =
        typeof content.animation === "string"
          ? (content.animation as AnimationType)
          : undefined;

      const petStateJson =
        typeof content.petStateJson === "string" ? content.petStateJson : null;
      const petState = petStateJson
        ? (JSON.parse(petStateJson) as PetState)
        : undefined;

      const saveDataJson =
        typeof content.saveDataJson === "string" ? content.saveDataJson : null;
      const saveData = saveDataJson
        ? (JSON.parse(saveDataJson) as SaveData)
        : undefined;

      lastEvent = {
        type,
        text: typeof content.text === "string" ? content.text : undefined,
        petState,
        animation,
        saveData,
      };

      return [];
    },
  );

  return lastEvent;
}

export async function subscribeElizagotchiState(
  onState: (payload: ElizagotchiStateUpdatedPayload) => void,
): Promise<() => void> {
  const runtime = await getElizagotchiRuntime();
  type OnHandler = Parameters<AgentRuntime["on"]>[1];
  type OnPayload = OnHandler extends (data: infer D) => void ? D : never;

  const handler = (payload: OnPayload) =>
    onState(payload as ElizagotchiStateUpdatedPayload);

  runtime.on(ELIZAGOTCHI_STATE_UPDATED_EVENT, handler);
  return () => runtime.off(ELIZAGOTCHI_STATE_UPDATED_EVENT, handler);
}

export async function subscribeElizagotchiAgentLog(
  listener: AgentLogListener,
): Promise<() => void> {
  // Ensure runtime (and thus event registration) is initialized.
  await getElizagotchiRuntime();

  agentLogListeners.add(listener);
  return () => {
    agentLogListeners.delete(listener);
  };
}
