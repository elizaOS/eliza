/**
 * Replays the messages of quint/PeerMentionAddressing.qnt through the
 * production MESSAGE_RECEIVED listener (createActiveSessionForwardHandler) on
 * a PGlite-backed AgentRuntime. The classifier call reaches a local TEXT_SMALL
 * handler that answers in prose, so decideInterruption decides from the text.
 * Only the ACP subprocess boundary is scripted: it lists the room's sessions
 * and records prompts, cancels and stop stamps. No provider is called.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type AgentRuntime,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type Plugin,
  Service,
  type ServiceClass,
  type UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { createActiveSessionForwardHandler } from "../services/active-session-forward.js";
import { ADMIN_STOP_META_KEY } from "../services/admin-stop-marker.js";
import { SubAgentInbox } from "../services/sub-agent-inbox.js";
import type { SessionInfo } from "../services/types.js";
import { createRealTestRuntime } from "./real-runtime.js";

/** One posted message and the outcome per sub-agent (see the model). */
interface ModelCase {
  rooms: number;
  busy: number[];
  address: number;
  target: number;
  intent: number;
  outcome: number[];
}

const LABELS = ["Ada", "Bob", "Cy"];
const INTENTS = ["stop", "no, don't do that", "rename the button"];
const UNTOUCHED = 0;
const DELIVERED = 1;
const QUEUED = 2;
const CANCELLED = 3;
const ROOM_SIZES = ["one sub-agent", "two sub-agents", "three sub-agents"];

/** The text a user posts for a model message. */
function messageText(item: ModelCase): string {
  const intent = INTENTS[item.intent];
  const label = LABELS[item.target];
  switch (item.address) {
    case 0:
      return intent;
    case 1:
      return `${label}, ${intent}`;
    case 2:
      return `@${label} ${intent}`;
    case 3:
      return `<@1234567890> ${intent}`;
    case 4:
      return `@eliza ${intent}`;
    default:
      throw new Error(`Unknown address ${item.address}`);
  }
}

// "@Ada ..." in a crowded room names Ada; Bob and Cy are left alone.
const DEFAULT_CASES: ModelCase[] = [
  {
    rooms: 2,
    busy: [0, 1],
    address: 2,
    target: 0,
    intent: 0,
    outcome: [CANCELLED, UNTOUCHED],
  },
  {
    rooms: 2,
    busy: [],
    address: 2,
    target: 1,
    intent: 2,
    outcome: [UNTOUCHED, DELIVERED],
  },
  {
    rooms: 3,
    busy: [0, 1, 2],
    address: 2,
    target: 2,
    intent: 1,
    outcome: [UNTOUCHED, UNTOUCHED, CANCELLED],
  },
  {
    rooms: 3,
    busy: [1],
    address: 2,
    target: 0,
    intent: 2,
    outcome: [DELIVERED, UNTOUCHED, UNTOUCHED],
  },
  {
    rooms: 3,
    busy: [0, 2],
    address: 3,
    target: 0,
    intent: 0,
    outcome: [CANCELLED, DELIVERED, CANCELLED],
  },
  {
    rooms: 2,
    busy: [0],
    address: 4,
    target: 0,
    intent: 2,
    outcome: [QUEUED, DELIVERED],
  },
  {
    rooms: 1,
    busy: [0],
    address: 2,
    target: 0,
    intent: 0,
    outcome: [CANCELLED],
  },
];

const casesFile = process.env.ELIZA_PEER_MENTION_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

let modelCalls = 0;
const proseClassifier: Plugin = {
  name: "peer-mention-prose-classifier",
  description: "TEXT_SMALL that answers the interruption prompt in prose",
  models: {
    [ModelType.TEXT_SMALL]: async () => {
      modelCalls += 1;
      return "The user is talking to one of the sub-agents.";
    },
  },
};

/** The ACP subprocess boundary: lists sessions and records what reaches them. */
class ScriptedAcpBoundary extends Service {
  static override serviceType = AcpService.serviceType;
  override capabilityDescription = "Scripted ACP subprocess boundary";
  sessions: SessionInfo[] = [];
  prompts: Array<{ id: string; text: string }> = [];
  cancels: string[] = [];
  stamps: Array<{ id: string; patch: Record<string, unknown> }> = [];

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<ScriptedAcpBoundary> {
    return new ScriptedAcpBoundary(runtime);
  }

  override async stop(): Promise<void> {}

  listSessions(): SessionInfo[] {
    return this.sessions;
  }

  async sendPrompt(id: string, text: string) {
    this.prompts.push({ id, text });
    return { stopReason: "end_turn", finalText: "ok" };
  }

  async cancelSession(id: string): Promise<void> {
    this.cancels.push(id);
  }

  async updateSessionMetadata(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    this.stamps.push({ id, patch });
  }
}

let runtime: AgentRuntime;
let cleanup: (() => Promise<void>) | undefined;
let acp: ScriptedAcpBoundary;
const roomId = randomUUID() as UUID;
const userId = randomUUID() as UUID;

beforeAll(async () => {
  ({ runtime, cleanup } = await createRealTestRuntime({
    characterName: "Eliza",
    plugins: [
      proseClassifier,
      {
        name: "peer-mention-acp-boundary",
        description: "Registers the scripted ACP subprocess boundary",
        services: [ScriptedAcpBoundary as unknown as ServiceClass],
      },
    ],
  }));
  const loaded = await runtime.getServiceLoadPromise(AcpService.serviceType);
  if (!(loaded instanceof ScriptedAcpBoundary)) {
    throw new Error("Scripted ACP boundary did not start");
  }
  acp = loaded;
}, 60_000);

afterAll(async () => {
  await cleanup?.();
});

/** Posts one model message and reads back each sub-agent's outcome. */
async function replay(item: ModelCase): Promise<number[]> {
  const ids = LABELS.slice(0, item.rooms).map(
    (label) => `${label.toLowerCase()}-${randomUUID()}`,
  );
  acp.sessions = ids.map((id, index) => ({
    id,
    name: id,
    agentType: "codex",
    workdir: "/tmp/peer-mention-addressing",
    approvalPreset: "standard",
    status: item.busy.includes(index) ? "tool_running" : "ready",
    createdAt: new Date(0),
    lastActivityAt: new Date(0),
    metadata: { roomId, label: LABELS[index], task: "build the color app" },
  }));
  acp.prompts = [];
  acp.cancels = [];
  acp.stamps = [];
  const inbox = new SubAgentInbox();
  const handler = createActiveSessionForwardHandler(runtime, inbox);
  const text = messageText(item);
  const message = {
    id: randomUUID() as UUID,
    roomId,
    entityId: userId,
    agentId: runtime.agentId,
    content: { text, source: "client_chat", metadata: {} },
    createdAt: Date.now(),
  } as Memory;
  const callsBefore = modelCalls;
  await handler({ message });
  // A crowded room or a running turn asks the classifier; its prose leaves
  // the decision to decideInterruption.
  const classified = ids.filter(
    (_id, index) => item.rooms > 1 || item.busy.includes(index),
  ).length;
  expect(modelCalls - callsBefore, text).toBe(classified);
  return ids.map((id) => {
    const prompts = acp.prompts.filter((prompt) => prompt.id === id);
    const queued = inbox.drain(id);
    const cancelled = acp.cancels.includes(id);
    if (cancelled) {
      expect(
        acp.stamps.some(
          (stamp) =>
            stamp.id === id &&
            stamp.patch[ADMIN_STOP_META_KEY] === "user_interrupt",
        ),
        text,
      ).toBe(true);
    }
    // A sub-agent gets at most one of the three effects.
    expect(
      [prompts.length > 0, queued !== null, cancelled].filter(Boolean).length,
      text,
    ).toBeLessThanOrEqual(1);
    if (cancelled) return CANCELLED;
    if (prompts.length > 0) {
      expect(prompts, text).toEqual([{ id, text }]);
      return DELIVERED;
    }
    if (queued) {
      expect(queued, text).toBe(text);
      return QUEUED;
    }
    return UNTOUCHED;
  });
}

describe("peer mention addressing model", () => {
  it.each(ROOM_SIZES)("replays a room with %s", async (size) => {
    const rooms = ROOM_SIZES.indexOf(size) + 1;
    const group = cases.filter((item) => item.rooms === rooms);
    expect(group.length).toBeGreaterThan(0);
    for (const item of group) {
      const label = `${messageText(item)} busy=${JSON.stringify(item.busy)}`;
      expect(await replay(item), label).toEqual(item.outcome);
    }
  });
});
