import type { Action, AgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  attestAuthenticatedApiDeliveryAudience,
  authorizeOwnerExclusiveDisclosure,
  ChannelType,
  createCharacter,
  ModelType,
  TurnAbortedError,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantPlugin } from "../index.ts";
import { DefaultMessageService } from "./message.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-0000000000a2" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000a3" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-0000000000a4" as UUID;
const GUEST_ID = "00000000-0000-0000-0000-0000000000a6" as UUID;

const runtimes: AgentRuntime[] = [];

async function ownerModelAcknowledgment(
  ownerPrivatePlannerState: boolean,
  {
    changeAudienceBeforeAcknowledgment = false,
    abortDuringRevalidation = false,
    acknowledgment = "Let me check.",
  } = {},
) {
  const controller = new AbortController();
  let stage1Returned = false;
  const events: string[] = [];
  const acknowledgments: string[] = [];
  const runtime = createSQLiteTestRuntime({
    plugins: [createAssistantPlugin()],
    character: createCharacter({
      id: AGENT_ID,
      name: "Owner tool phase",
      bio: "test",
      settings: {},
    }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  await runtime.initialize({ skipMigrations: true });
  runtimes.push(runtime);
  await runtime.createWorld({
    id: WORLD_ID,
    agentId: runtime.agentId,
    name: "Owner world",
    metadata: {
      ownership: { ownerId: OWNER_ID },
      roles: { [OWNER_ID]: "OWNER" },
    },
  });
  await runtime.ensureRoomExists({
    id: ROOM_ID,
    source: "client_chat",
    type: ChannelType.DM,
    worldId: WORLD_ID,
  });
  await runtime.addParticipant(OWNER_ID, ROOM_ID);
  await runtime.addParticipant(runtime.agentId, ROOM_ID);
  runtime.actions.length = 0;
  runtime.evaluators.length = 0;
  let compositions = 0;
  runtime.composeState = vi.fn(async (message: Memory) => {
    compositions++;
    if (ownerPrivatePlannerState && compositions === 1) {
      expect(
        (await authorizeOwnerExclusiveDisclosure(runtime, message)).allowed,
      ).toBe(true);
    }
    return { values: { availableContexts: "general" }, data: {}, text: "" };
  }) as AgentRuntime["composeState"];
  const lookup: Action = {
    name: "LOOKUP",
    description: "Looks up an entry.",
    parameters: [
      {
        name: "query",
        description: "Entry",
        required: true,
        schema: { type: "string" },
      },
    ],
    validate: async () => true,
    handler: async () => {
      events.push("tool");
      return { success: true, text: "private result" };
    },
  };
  runtime.registerAction(lookup);
  const readParticipants = runtime.getParticipantsForRoom.bind(runtime);
  if (changeAudienceBeforeAcknowledgment || abortDuringRevalidation) {
    vi.spyOn(runtime, "getParticipantsForRoom").mockImplementation(
      async (roomId) => {
        if (stage1Returned) {
          stage1Returned = false;
          if (changeAudienceBeforeAcknowledgment) {
            await runtime.createEntity({
              id: GUEST_ID,
              agentId: runtime.agentId,
              names: ["Guest"],
            });
            await runtime.addParticipant(GUEST_ID, ROOM_ID);
          }
          if (abortDuringRevalidation) controller.abort();
        }
        return readParticipants(roomId);
      },
    );
  }
  let handlerCalls = 0;
  runtime.registerModel(
    ModelType.RESPONSE_HANDLER,
    async () => {
      const first = handlerCalls++ === 0;
      if (first) stage1Returned = true;
      return first
        ? {
            text: "",
            toolCalls: [
              {
                id: "handle-response-1",
                name: "HANDLE_RESPONSE",
                arguments: {
                  shouldRespond: "RESPOND",
                  thought: "Look it up.",
                  contexts: ["general"],
                  intents: ["look up entry"],
                  candidateActionNames: ["LOOKUP"],
                  replyText: acknowledgment
                    ? [{ kind: "text", value: acknowledgment }]
                    : [],
                  replyEffectStatus: "pending",
                  facts: [],
                  relationships: [],
                  addressedTo: [],
                  requiresTool: true,
                },
              },
            ],
            finishReason: "tool_calls",
          }
        : JSON.stringify({
            thought: "Covered.",
            success: true,
            decision: "FINISH",
            messageToUser: "Nothing this week.",
          });
    },
    "owner-tool-phase",
    300,
  );
  runtime.registerModel(
    ModelType.ACTION_PLANNER,
    async () => ({
      text: "",
      thought: "Look it up.",
      toolCalls: [
        { id: "lookup-1", name: "LOOKUP", arguments: { query: "private arg" } },
      ],
    }),
    "owner-tool-phase",
    300,
  );
  const message: Memory = {
    id: "00000000-0000-4000-8000-0000000000a5" as UUID,
    entityId: OWNER_ID,
    agentId: runtime.agentId,
    roomId: ROOM_ID,
    content: {
      text: acknowledgment
        ? "Look up this week."
        : "Look up this week without saying anything or acknowledging it.",
      source: "client_chat",
      channelType: ChannelType.DM,
    },
    createdAt: Date.now(),
  };
  await attestAuthenticatedApiDeliveryAudience(runtime, message, {
    kind: "owner_api_token",
  } as never);
  const chunks: string[] = [];
  try {
    await new DefaultMessageService().handleMessage(
      runtime,
      message,
      async () => [],
      {
        abortSignal: controller.signal,
        onPlanningAcknowledgment: async (text) => {
          events.push("ack-start");
          await Promise.resolve();
          acknowledgments.push(text);
          events.push("ack-end");
        },
        onStreamChunk: async (chunk) => {
          chunks.push(chunk);
        },
      },
    );
  } catch (error) {
    if (
      !controller.signal.aborted ||
      !(
        error instanceof TurnAbortedError ||
        (error instanceof Error && error.name === "AbortError")
      )
    )
      throw error;
  }
  return { chunks, acknowledgments, events };
}

describe("awaited owner model acknowledgments", () => {
  beforeEach(() => vi.stubEnv("ELIZA_TRAJECTORY_LOGGING", "0"));
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      runtimes.splice(0).map(async (runtime) => {
        await runtime.stop();
        await runtime.close();
      }),
    );
  });

  it("awaits one original model acknowledgment before private tool work", async () => {
    const result = await ownerModelAcknowledgment(true);
    expect(result.acknowledgments).toEqual(["Let me check."]);
    expect(result.events).toEqual(["ack-start", "ack-end", "tool"]);
    expect(result.chunks).toEqual([]);
  });

  it("still performs authorized tool work when the model supplies no acknowledgment", async () => {
    const result = await ownerModelAcknowledgment(true, { acknowledgment: "" });
    expect(result.acknowledgments).toEqual([]);
    expect(result.events).toEqual(["tool"]);
  });

  it("does not send private model words to a changed audience", async () => {
    const result = await ownerModelAcknowledgment(true, {
      changeAudienceBeforeAcknowledgment: true,
    });
    expect(result.acknowledgments).toEqual([]);
  });

  it("does not send an acknowledgment after cancellation during revalidation", async () => {
    const result = await ownerModelAcknowledgment(true, {
      abortDuringRevalidation: true,
    });
    expect(result.acknowledgments).toEqual([]);
  });
});
