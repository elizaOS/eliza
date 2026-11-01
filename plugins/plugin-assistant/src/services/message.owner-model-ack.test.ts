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
    acknowledgment = "Let me have a look.",
    toolCategories = [] as string[],
    guestInRoom = false,
    duringActivityRevalidation = undefined as
      | "guest-joins"
      | "lookup-fails"
      | "abort"
      | undefined,
  } = {},
) {
  const controller = new AbortController();
  let stage1Returned = false;
  let plannerReturned = false;
  const events: string[] = [];
  const acknowledgments: string[] = [];
  const statuses: Array<{ actionName: string; label: string }> = [];
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
  const addGuest = async () => {
    await runtime.createEntity({
      id: GUEST_ID,
      agentId: runtime.agentId,
      names: ["Guest"],
    });
    await runtime.addParticipant(GUEST_ID, ROOM_ID);
  };
  if (guestInRoom) await addGuest();
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
  const lookup = (
    name: string,
    event: string,
    contexts?: Action["contexts"],
  ): Action => ({
    name,
    description: "Looks up an entry.",
    ...(contexts ? { contexts } : {}),
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
      events.push(event);
      return { success: true, text: "private result" };
    },
  });
  // Notes is a plugin-registered category; Calendar is a default one. A
  // "web+calendar" entry is one action listing both categories.
  runtime.contexts.tryRegister({
    id: "notes",
    label: "Notes",
    sensitivity: "personal",
  });
  const tools = toolCategories.length
    ? toolCategories.map((category) =>
        lookup(
          `${category.toUpperCase().replace("+", "_")}_LOOKUP`,
          `tool:${category}`,
          category.split("+"),
        ),
      )
    : [lookup("LOOKUP", "tool")];
  for (const tool of tools) runtime.registerAction(tool);
  const readParticipants = runtime.getParticipantsForRoom.bind(runtime);
  if (
    changeAudienceBeforeAcknowledgment ||
    abortDuringRevalidation ||
    duringActivityRevalidation
  ) {
    vi.spyOn(runtime, "getParticipantsForRoom").mockImplementation(
      async (roomId) => {
        if (stage1Returned) {
          stage1Returned = false;
          if (changeAudienceBeforeAcknowledgment) await addGuest();
          if (abortDuringRevalidation) controller.abort();
        }
        // The first audience read after planning is the activity revalidation.
        const disturbance = plannerReturned
          ? duringActivityRevalidation
          : undefined;
        if (disturbance) {
          duringActivityRevalidation = undefined;
          if (disturbance === "lookup-fails")
            throw new Error("participant lookup unavailable");
          if (disturbance === "guest-joins") await addGuest();
          if (disturbance === "abort") controller.abort();
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
                  candidateActionNames: tools.map((tool) => tool.name),
                  // This fixture supplies no source originals, so Stage 1 declares
                  // plain reply text rather than source-backed reply parts.
                  replyText: acknowledgment,
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
        : // A multi-tool turn continues to its queued second activity.
          JSON.stringify(
            toolCategories.length > 1 && handlerCalls === 2
              ? {
                  thought: "Notes remain.",
                  success: true,
                  decision: "CONTINUE",
                  messageToUser: "",
                }
              : {
                  thought: "Covered.",
                  success: true,
                  decision: "FINISH",
                  messageToUser: "Nothing this week.",
                },
          );
    },
    "owner-tool-phase",
    300,
  );
  runtime.registerModel(
    ModelType.ACTION_PLANNER,
    async () => {
      plannerReturned = true;
      return {
        text: "",
        thought: "Look it up.",
        toolCalls: tools.map((tool, index) => ({
          id: `lookup-${index + 1}`,
          name: tool.name,
          arguments: { query: "private arg" },
        })),
      };
    },
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
        onActivityStatus: async (activity) => {
          events.push(`status:${activity.label}`);
          statuses.push(activity);
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
  return { chunks, acknowledgments, events, statuses };
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
    expect(result.acknowledgments).toEqual(["Let me have a look."]);
    expect(result.events).toEqual(["ack-start", "ack-end", "tool"]);
    expect(result.chunks).toEqual([]);
  });

  it("awaits an interjection-led model acknowledgment in its own words", async () => {
    const acknowledgment = "Sure! Let me check your calendar and notes.";
    const result = await ownerModelAcknowledgment(true, { acknowledgment });
    expect(result.acknowledgments).toEqual([acknowledgment]);
    expect(result.events).toEqual(["ack-start", "ack-end", "tool"]);
  });

  it.each([
    "I've saved that to your notes.",
    "You have no notes this week.",
    "All set.",
    "Nothing on your calendar today.",
    "Checking your calendar, your appointment starts soon.",
  ])(
    "keeps a completion or result claim out of early progress: %s",
    async (acknowledgment) => {
      const result = await ownerModelAcknowledgment(true, { acknowledgment });
      expect(result.acknowledgments).toEqual([]);
      expect(result.events).toEqual(["tool"]);
    },
  );

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

  it("shows one content-free status per activity, in order, after the one acknowledgment", async () => {
    const result = await ownerModelAcknowledgment(true, {
      toolCategories: ["calendar", "notes"],
    });
    expect(result.acknowledgments).toEqual(["Let me have a look."]);
    expect(result.events).toEqual([
      "ack-start",
      "ack-end",
      "status:Using Calendar",
      "tool:calendar",
      "status:Using Notes",
      "tool:notes",
    ]);
    expect(result.statuses).toEqual([
      { actionName: "CALENDAR_LOOKUP", label: "Using Calendar" },
      { actionName: "NOTES_LOOKUP", label: "Using Notes" },
    ]);
    expect(JSON.stringify(result.statuses)).not.toMatch(/private/u);
    expect(result.chunks).toEqual([]);
  });

  it("keeps a private category from a shared room and still shows a public one", async () => {
    const result = await ownerModelAcknowledgment(false, {
      toolCategories: ["calendar", "web"],
      guestInRoom: true,
    });
    expect(result.acknowledgments).toEqual(["Let me have a look."]);
    expect(result.events).toEqual([
      "ack-start",
      "ack-end",
      "tool:calendar",
      "status:Using Web",
      "tool:web",
    ]);
  });

  // An action is public only when every category it lists is public: a
  // public category beside a private or an unregistered one still revalidates.
  it.each(["web+calendar", "web+unregistered"])(
    "keeps a mixed-publicity action from a shared room: %s",
    async (mixed) => {
      const result = await ownerModelAcknowledgment(false, {
        toolCategories: [mixed, "web"],
        guestInRoom: true,
      });
      expect(result.acknowledgments).toEqual(["Let me have a look."]);
      expect(result.events).toEqual([
        "ack-start",
        "ack-end",
        `tool:${mixed}`,
        "status:Using Web",
        "tool:web",
      ]);
    },
  );

  it("does not send an acknowledgment after cancellation during revalidation", async () => {
    const result = await ownerModelAcknowledgment(true, {
      abortDuringRevalidation: true,
    });
    expect(result.acknowledgments).toEqual([]);
  });

  // A public category on an owner-exclusive turn still revalidates, and the
  // status waits for a live turn after the audience read.
  it.each(["guest-joins", "lookup-fails", "abort"] as const)(
    "withholds an owner-turn activity status when its revalidation sees: %s",
    async (duringActivityRevalidation) => {
      const result = await ownerModelAcknowledgment(true, {
        toolCategories: ["web"],
        duringActivityRevalidation,
      });
      expect(result.acknowledgments).toEqual(["Let me have a look."]);
      expect(result.statuses).toEqual([]);
    },
  );
});
