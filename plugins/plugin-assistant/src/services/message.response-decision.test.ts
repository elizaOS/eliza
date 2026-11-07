/**
 * The host respond-decision signal on the real message pipeline (AgentRuntime +
 * SQLite; only the model surface is a deterministic registered handler). It
 * fires once when Stage 1 commits to a response, before delivery, and never
 * for an ignored turn.
 */

import {
  type AgentRuntime,
  asUUID,
  ChannelType,
  createCharacter,
  type Memory,
  ModelType,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { v4 } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stage1Response } from "../__tests__/stage1/fixtures.js";
import { createAssistantPlugin } from "../index.ts";
import { DefaultMessageService } from "./message.ts";

const QUESTION = "where is the picnic now?";
const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  await Promise.all(
    runtimes.splice(0).map(async (runtime) => {
      await runtime.stop();
      await runtime.close();
    }),
  );
});

const decision =
  (shouldRespond: "RESPOND" | "IGNORE", replyText: string) => () =>
    stage1Response({
      shouldRespond,
      replyText,
      thought: "Decide.",
      contexts: ["simple"],
    });

async function createHarness(stage1: () => object) {
  const runtime = createSQLiteTestRuntime({
    plugins: [createAssistantPlugin()],
    character: createCharacter({ name: `Decision${v4().slice(0, 8)}` }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  runtimes.push(runtime);
  await runtime.initialize();
  runtime.registerModel(
    ModelType.RESPONSE_HANDLER,
    async () => stage1(),
    "deterministic-test",
  );
  const roomId = asUUID(v4());
  const entityId = asUUID(v4());
  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId: asUUID(v4()),
    userName: "tester",
    name: "tester",
    source: "test",
    type: ChannelType.DM,
  });
  const service = new DefaultMessageService();
  runtime.messageService = service;
  const message: Memory = {
    id: asUUID(v4()),
    entityId,
    agentId: runtime.agentId,
    roomId,
    content: { text: QUESTION, source: "test", channelType: ChannelType.DM },
    createdAt: Date.now(),
  };
  return { runtime, service, message };
}

describe("message respond-decision signal", () => {
  it("fires once when Stage 1 commits to a response, before the reply is delivered", async () => {
    const h = await createHarness(decision("RESPOND", "on the north lawn."));
    const order: string[] = [];
    const result = await h.service.handleMessage(
      h.runtime,
      h.message,
      async (content) => {
        if (content.text) order.push(`deliver:${content.text}`);
        return [];
      },
      { onResponseDecision: () => order.push("decision") },
    );
    expect(result.didRespond).toBe(true);
    expect(order).toEqual(["decision", "deliver:on the north lawn."]);
  });

  it("never fires for a turn Stage 1 ignores", async () => {
    const stage1 = vi.fn(decision("IGNORE", ""));
    const h = await createHarness(stage1);
    const onResponseDecision = vi.fn();
    const delivered: string[] = [];
    const result = await h.service.handleMessage(
      h.runtime,
      h.message,
      async (content) => {
        if (content.text) delivered.push(content.text);
        return [];
      },
      { onResponseDecision },
    );
    expect(stage1).toHaveBeenCalled();
    expect(result.didRespond).toBe(false);
    expect(delivered).toEqual([]);
    expect(onResponseDecision).not.toHaveBeenCalled();
  });
});
