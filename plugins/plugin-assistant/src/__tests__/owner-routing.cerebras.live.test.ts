/**
 * Live Cerebras proof that possessive owner reads bind to the noun in the
 * owning clause. The real PGlite-backed message loop has unrelated owner and
 * web surfaces available so contextual nouns can challenge the deterministic
 * routing floor.
 */

import {
  type Action,
  ChannelType,
  createMessageMemory,
  type HandlerCallback,
  type Memory,
  type Plugin,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "@elizaos/testing/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface LiveTrajectoryDetail {
  metrics?: { finalStatus?: string };
  steps?: Array<{ llmCalls?: Array<{ response?: string }> }>;
}

interface LiveTrajectoryService {
  flushWriteQueue?: (trajectoryId: string) => Promise<void>;
  getTrajectoryDetail?: (
    trajectoryId: string,
  ) => Promise<LiveTrajectoryDetail | null>;
}

const invokedActions: string[] = [];

function proofAction(name: string): Action {
  return {
    name,
    description: `Deterministic live owner-read proof surface for ${name}.`,
    validate: async () => true,
    handler: async () => {
      invokedActions.push(name);
      return { success: true, text: `${name} selected` };
    },
  };
}

const routingProofPlugin: Plugin = {
  name: "owner-read-routing-live-proof",
  description:
    "Registers private owner readers and adversarial generic surfaces.",
  actions: [
    proofAction("OWNER_TODOS"),
    proofAction("OWNER_GOALS"),
    proofAction("OWNER_ALARMS"),
    proofAction("OWNER_ROUTINES"),
    proofAction("OWNER_REMINDERS"),
    proofAction("OWNER_FINANCES"),
    proofAction("VIEWS"),
    proofAction("WEB_SEARCH"),
  ],
};

const liveDescribe =
  process.env.ELIZA_RUN_LIVE_TESTS === "1" &&
  process.env.CEREBRAS_API_KEY?.trim()
    ? describe
    : describe.skip;

liveDescribe("possessive owner reads — live Cerebras", () => {
  let harness: RealTestRuntimeResult;

  beforeAll(async () => {
    harness = await createRealTestRuntime({
      characterName: "OwnerReadProofAgent",
      plugins: [routingProofPlugin],
      preferredProvider: "cerebras",
      withLLM: true,
    });
    expect(harness.providerName).toBe("cerebras");
    expect(harness.runtime.getSetting("OPENAI_BASE_URL")).toBe(
      harness.providerConfig?.baseUrl,
    );
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  async function runTurn(text: string): Promise<string[]> {
    invokedActions.length = 0;
    const roomId = stringToUuid(`owner-read-room:${text}`) as UUID;
    const entityId = stringToUuid(`owner-read-user:${text}`) as UUID;
    const worldId = stringToUuid("owner-read-world") as UUID;
    await harness.runtime.ensureConnection({
      channelId: roomId,
      entityId,
      roomId,
      worldId,
      source: "api_private",
      type: ChannelType.DM,
      userName: "Owner",
    });
    const message: Memory = createMessageMemory({
      entityId,
      id: stringToUuid(`owner-read-message:${text}`) as UUID,
      roomId,
      content: { channelType: ChannelType.DM, source: "api_private", text },
    });
    const callback: HandlerCallback = async () => [];
    const service = harness.runtime.messageService;
    if (!service) throw new Error("message service was not initialized");
    await service.handleMessage(harness.runtime, message, callback, {});
    const trajectoryId = (message.metadata as { trajectoryId?: unknown } | null)
      ?.trajectoryId;
    if (typeof trajectoryId !== "string") {
      throw new Error("live turn did not create a trajectory");
    }
    const trajectories = harness.runtime.getService(
      "trajectories",
    ) as LiveTrajectoryService | null;
    let trajectory: LiveTrajectoryDetail | null = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await trajectories?.flushWriteQueue?.(trajectoryId);
      trajectory =
        (await trajectories?.getTrajectoryDetail?.(trajectoryId)) ?? null;
      if (trajectory?.metrics?.finalStatus === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(trajectory?.metrics?.finalStatus).toBe("completed");
    return [...invokedActions];
  }

  it.each([
    ["What are my todos?", "OWNER_TODOS"],
    ["Show my reminders about goal planning.", "OWNER_REMINDERS"],
    ["Show my finances.", "OWNER_FINANCES"],
    ["add a todo: water the ferns. no due date.", "OWNER_TODOS"],
    ["set an alarm for 7am tomorrow", "OWNER_ALARMS"],
  ])(
    "executes the owner action for %s",
    async (text, action) => {
      const invoked = await runTurn(text);
      expect(invoked).toContain(action);
      expect(invoked).not.toContain("VIEWS");
      expect(invoked).not.toContain("WEB_SEARCH");
    },
    240_000,
  );
});
