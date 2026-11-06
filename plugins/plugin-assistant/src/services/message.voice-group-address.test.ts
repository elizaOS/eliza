/**
 * Multi-party voice-room turn-taking on the real message pipeline (AgentRuntime
 * + SQLite; only the model surface is a deterministic registered handler). A
 * VOICE_GROUP turn that Stage 1 tags as addressed to another participant must
 * stay silent even when the client's turn signal says agentShouldSpeak — the
 * respond gate sets that for any substantive, non-echo transcript, so it does
 * not mean the turn was addressed to this agent.
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
import { afterEach, describe, expect, it } from "vitest";
import { stage1Response } from "../__tests__/stage1/fixtures.js";
import { createAssistantPlugin } from "../index.ts";
import { DefaultMessageService } from "./message.ts";

const AGENT_NAME = "Aria";
const REPLY = "I think the plan is fine.";
const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  await Promise.all(
    runtimes.splice(0).map(async (runtime) => {
      await runtime.stop();
      await runtime.close();
    }),
  );
});

async function deliveredReplies(addressedTo: string[]) {
  const runtime = createSQLiteTestRuntime({
    plugins: [createAssistantPlugin()],
    character: createCharacter({ name: AGENT_NAME }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  runtimes.push(runtime);
  await runtime.initialize();
  runtime.registerModel(
    ModelType.RESPONSE_HANDLER,
    async () =>
      stage1Response({
        shouldRespond: "RESPOND",
        replyText: REPLY,
        thought: "Answer the room.",
        contexts: ["simple"],
        addressedTo,
      }),
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
    type: ChannelType.VOICE_GROUP,
  });
  const service = new DefaultMessageService();
  runtime.messageService = service;
  const message: Memory = {
    id: asUUID(v4()),
    entityId,
    agentId: runtime.agentId,
    roomId,
    content: {
      text: `${addressedTo.join(" and ")}, what do you think about the plan?`,
      source: "test",
      channelType: ChannelType.VOICE_GROUP,
      // What the chat route persists for a voice client: buildVoiceTurnSignal
      // output for a substantive transcript with no wake word.
      metadata: {
        voiceTurnSignal: {
          endOfTurnProbability: 0.92,
          nextSpeaker: "agent",
          agentShouldSpeak: true,
          source: "client-ambient",
        },
      },
    },
    createdAt: Date.now(),
  };
  const delivered: string[] = [];
  const result = await service.handleMessage(
    runtime,
    message,
    async (content) => {
      if (content.text) delivered.push(content.text);
      return [];
    },
  );
  return { didRespond: result.didRespond, delivered };
}

describe("voice group address on the message pipeline", () => {
  it("stays silent when the turn is addressed to another participant", async () => {
    const result = await deliveredReplies(["Bob"]);
    expect(result.delivered).toEqual([]);
    expect(result.didRespond).toBe(false);
  });

  it("replies when the turn is addressed to this agent", async () => {
    const result = await deliveredReplies([AGENT_NAME]);
    expect(result.delivered).toEqual([REPLY]);
    expect(result.didRespond).toBe(true);
  });
});
