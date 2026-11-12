import type { Action, AgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  attestAuthenticatedApiDeliveryAudience,
  authorizeOwnerExclusiveDisclosure,
  ChannelType,
  createCharacter,
  GazetteerEntityRecognizer,
  getTrajectoryContext,
  ModelType,
  PseudonymSession,
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
    toolCategories = [] as string[],
    toolName = "LOOKUP",
    guestInRoom = false,
    contextRead = false,
    contextReference = "CHOICE",
    requestSilence = false,
    abortAfterContextRead = false,
    restorePii = false,
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
  let plannerCalls = 0;
  let contextReadIssued = false;
  let readCompositions = 0;
  const stage1Wires: string[] = [];
  const providerText =
    "PRIVATE_CONTEXT_TEST_VALUE authorized complete guide. ".repeat(20);
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
  const piiSession = restorePii
    ? new PseudonymSession({
        salt: "read-context-ack-fixture",
        recognizer: new GazetteerEntityRecognizer([
          { kind: "person", value: "Dana Whitfield" },
        ]),
      })
    : undefined;
  if (piiSession) {
    await piiSession.learn("Dana Whitfield owns this guide.");
    const restore = piiSession.restoreInValue.bind(piiSession);
    vi.spyOn(piiSession, "restoreInValue").mockImplementation((value) => {
      if (value === acknowledgment) events.push("restore-ack");
      return restore(value);
    });
  }
  if (contextRead)
    runtime.providers.push({
      name: "CHOICE",
      description: "Authorized complete guide.",
      get: async () => ({ text: providerText }),
    });
  runtime.composeState = vi.fn(async (message: Memory) => {
    compositions++;
    if (piiSession) {
      const current = getTrajectoryContext();
      if (!current) throw new Error("Expected actual turn trajectory context");
      current.piiSwapSession = piiSession;
    }
    if (contextReadIssued && readCompositions === 0) {
      readCompositions++;
      events.push("read-compose");
      if (abortAfterContextRead) controller.abort();
    }
    if (ownerPrivatePlannerState && compositions === 1) {
      expect(
        (await authorizeOwnerExclusiveDisclosure(runtime, message)).allowed,
      ).toBe(true);
    }
    return {
      values: { availableContexts: "general" },
      data: contextRead
        ? {
            providers: {
              CHOICE: {
                text: providerText,
                discoveryText: "context_discovery: CHOICE",
              },
            },
          }
        : {},
      text: "",
    };
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
    : [lookup(toolName, "tool")];
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
    async (_rt, params) => {
      const first = handlerCalls++ === 0;
      if (first) stage1Returned = true;
      if (contextRead && handlerCalls <= 2) {
        stage1Wires.push(
          JSON.stringify({ messages: params.messages, tools: params.tools }),
        );
      }
      if (contextRead && first) {
        contextReadIssued = true;
        return {
          text: "",
          toolCalls: [
            {
              id: "read-choice",
              name: "READ_CONTEXT",
              arguments: {
                contextRequests: [contextReference],
                acknowledgment,
              },
            },
          ],
          finishReason: "tool_calls",
        };
      }
      if (contextRead && handlerCalls === 2)
        events.push("read-handle-response");
      return (contextRead ? handlerCalls === 2 : first)
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
                  // No source originals: preserve current main plain reply text.
                  replyText: contextRead ? "" : acknowledgment,
                  ...(contextRead ? { contextRequests: [] } : {}),
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
      plannerCalls++;
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
      text: contextRead
        ? requestSilence || !acknowledgment
          ? "Open Calendar and look up this week without saying anything or acknowledging it."
          : "Open Calendar and look up this week."
        : acknowledgment
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
          // Every events assertion also proves the acknowledgment left before
          // the planner model ran.
          if (plannerReturned) events.push("planner-before-ack");
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
  return {
    chunks,
    acknowledgments,
    events,
    statuses,
    handlerCalls,
    plannerCalls,
    stage1Wires,
    readCompositions,
    providerText,
  };
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

  it("awaits a wait-cue-led model acknowledgment in its own words", async () => {
    const acknowledgment = "One sec! Let me check your calendar and notes.";
    const result = await ownerModelAcknowledgment(true, { acknowledgment });
    expect(result.acknowledgments).toEqual([acknowledgment]);
    expect(result.events).toEqual(["ack-start", "ack-end", "tool"]);
  });

  it("awaits a view-opening model acknowledgment before planner and tool work", async () => {
    const acknowledgment = "Let me open Calendar.";
    const result = await ownerModelAcknowledgment(true, { acknowledgment });
    expect(result.acknowledgments).toEqual([acknowledgment]);
    expect(result.events).toEqual(["ack-start", "ack-end", "tool"]);
    expect(result.chunks).toEqual([]);
  });

  // #743 (step-1793690771434-bnctbd): the model named work after the view.
  // The draft is dropped whole, nothing is spoken in its place, and the
  // authorized work still runs.
  it("drops a compound view-plus-work draft whole and still runs the tool", async () => {
    const result = await ownerModelAcknowledgment(true, {
      acknowledgment:
        "Let me open Calendar and take another shot at the rename.",
    });
    expect(result.acknowledgments).toEqual([]);
    expect(result.events).toEqual(["tool"]);
    expect(result.chunks).toEqual([]);
  });

  it.each([
    "I've saved that to your notes.",
    "You have no notes this week.",
    "All set.",
    "Nothing on your calendar today.",
    "Checking your calendar, your appointment starts soon.",
    "Looking good, let me pull up the rest of your notes.",
    "checking your calendar yep all good",
    "Checking your calendar and nada",
    "Checking your flight on time",
    "checking your package on schedule for delivery today",
    "checking your calendar friday work from home",
    "Pulling up an event for tomorrow.",
    "No problem, checking your account.",
    "Scheduling it for tomorrow.",
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

  it.each(["Let me check.", "Let me open Calendar."])(
    "does not send private model words to a changed audience: %s",
    async (acknowledgment) => {
      const result = await ownerModelAcknowledgment(true, {
        acknowledgment,
        changeAudienceBeforeAcknowledgment: true,
      });
      expect(result.acknowledgments).toEqual([]);
    },
  );

  it("shows one content-free status per activity, in order, after the one acknowledgment", async () => {
    const result = await ownerModelAcknowledgment(true, {
      toolCategories: ["calendar", "notes"],
    });
    expect(result.acknowledgments).toEqual(["Let me check."]);
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

  it.each([
    ["notes+calendar", "NOTES_CALENDAR_LOOKUP"],
    ["notes+unregistered_app", "NOTES_UNREGISTERED_APP_LOOKUP"],
  ])(
    "does not name the first app for a multi-category action (%s)",
    async (category, actionName) => {
      const result = await ownerModelAcknowledgment(true, {
        toolCategories: [category],
      });
      expect(result.statuses).toEqual([{ actionName, label: "Working" }]);
      expect(result.acknowledgments).toEqual(["Let me check."]);
    },
  );

  // Catalog-derived actions retain all categories too; a mixed-domain tool
  // must not imply that its first category is the actual selected resource.
  it.each([
    ["WEB_SEARCH", "Working"],
    ["SEARCH_WEB", "Working"],
    ["SEARCH", "Working"],
  ])(
    "labels an uncategorized %s from its catalog entry",
    async (toolName, label) => {
      const result = await ownerModelAcknowledgment(true, { toolName });
      expect(result.statuses).toEqual([{ actionName: toolName, label }]);
    },
  );

  it("keeps an uncategorized web search status from a shared room", async () => {
    const result = await ownerModelAcknowledgment(false, {
      toolName: "WEB_SEARCH",
      guestInRoom: true,
    });
    expect(result.events).toEqual(["ack-start", "ack-end", "tool"]);
    expect(result.statuses).toEqual([]);
  });

  it("keeps a private category from a shared room and still shows a public one", async () => {
    const result = await ownerModelAcknowledgment(false, {
      toolCategories: ["calendar", "web"],
      guestInRoom: true,
    });
    expect(result.acknowledgments).toEqual(["Let me check."]);
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
      expect(result.acknowledgments).toEqual(["Let me check."]);
      expect(result.events).toEqual([
        "ack-start",
        "ack-end",
        `tool:${mixed}`,
        "status:Using Web",
        "tool:web",
      ]);
    },
  );

  it.each(["Let me check.", "Let me open Calendar."])(
    "does not send an acknowledgment after cancellation during revalidation: %s",
    async (acknowledgment) => {
      const result = await ownerModelAcknowledgment(true, {
        acknowledgment,
        abortDuringRevalidation: true,
      });
      expect(result.acknowledgments).toEqual([]);
    },
  );

  // A public category on an owner-exclusive turn still revalidates, and the
  // status waits for a live turn after the audience read.
  it.each(["guest-joins", "lookup-fails", "abort"] as const)(
    "withholds an owner-turn activity status when its revalidation sees: %s",
    async (duringActivityRevalidation) => {
      const result = await ownerModelAcknowledgment(true, {
        toolCategories: ["web"],
        duringActivityRevalidation,
      });
      expect(result.acknowledgments).toEqual(["Let me check."]);
      expect(result.statuses).toEqual([]);
    },
  );

  describe("actual READ_CONTEXT whole-draft progress admission", () => {
    it.each([
      "Let me check.",
      "Checking your calendar.",
      "Let me open Calendar.",
      "I’ll open Calendar.",
    ])(
      "publishes an admitted native read cue verbatim and awaits it before the next model: %s",
      async (acknowledgment) => {
        const result = await ownerModelAcknowledgment(true, {
          contextRead: true,
          acknowledgment,
        });
        expect(result.acknowledgments).toEqual([acknowledgment]);
        expect(result.readCompositions).toBe(1);
        expect(result.stage1Wires).toHaveLength(2);
        expect(result.stage1Wires[0]).toContain("READ_CONTEXT");
        expect(result.stage1Wires[0]).not.toContain(result.providerText.trim());
        expect(result.stage1Wires[1]).toContain(result.providerText.trim());
        expect(result.events.indexOf("read-compose")).toBeLessThan(
          result.events.indexOf("ack-start"),
        );
        expect(result.events.indexOf("ack-start")).toBeLessThan(
          result.events.indexOf("ack-end"),
        );
        expect(result.events.indexOf("ack-end")).toBeLessThan(
          result.events.indexOf("read-handle-response"),
        );
        expect(result.events.indexOf("read-handle-response")).toBeLessThan(
          result.events.indexOf("tool"),
        );
        expect(result.events).not.toContain("planner-before-ack");
        // Native read + HANDLE_RESPONSE + existing post-tool evaluation, not a
        // new acknowledgement inference. Planning still uses its existing call.
        expect(result.handlerCalls).toBe(3);
        expect(result.plannerCalls).toBe(1);
        expect(result.chunks).toEqual([]);
      },
    );

    it.each([
      "Let me pull the latest.",
      "I'll pull the latest.",
      "I’ll pull the latest!",
      "On it. Let me pull the latest.",
      "Let me open Calendar and take another shot at the rename.",
      "Let me open Calendar only if you confirm.",
      "Let me open Calendar? No, I won't.",
      "Let me open the draft Sarah sent.",
      "I'll update the appointment to 3pm",
      "Your event is at 3 PM.",
      "I renamed the event.",
      "I opened Calendar.",
      "Let me open Messages.",
      "Let me open Reminders.",
      "Let me open the calendar.",
      "Let me open Calendar again.",
      "Let me open PRIVATE_CONTEXT_TEST_VALUE.",
      "Let me open Calendar. <analysis>PRIVATE_CONTEXT_TEST_VALUE</analysis>",
    ])(
      "withholds the whole malformed native read draft while the authorized read and work continue: %s",
      async (acknowledgment) => {
        const result = await ownerModelAcknowledgment(true, {
          contextRead: true,
          acknowledgment,
        });
        expect(result.acknowledgments).toEqual([]);
        expect(result.events).not.toContain("ack-start");
        expect(result.events).toContain("read-compose");
        expect(result.events).toContain("tool");
        expect(result.readCompositions).toBe(1);
        expect(result.stage1Wires).toHaveLength(2);
        expect(result.stage1Wires[1]).toContain(result.providerText.trim());
        expect(result.handlerCalls).toBe(3);
        expect(result.plannerCalls).toBe(1);
        expect(result.chunks).toEqual([]);
      },
    );

    it("does not publish an acknowledgment or source body from a rejected native reference", async () => {
      const result = await ownerModelAcknowledgment(true, {
        contextRead: true,
        contextReference: "forged-unadvertised",
        acknowledgment: "Let me open Calendar.",
      });
      expect(result.acknowledgments).toEqual([]);
      expect(result.events).not.toContain("ack-start");
      expect(result.stage1Wires).toHaveLength(2);
      expect(result.stage1Wires[1]).toContain("context_read_repair");
      expect(result.stage1Wires[1]).not.toContain(result.providerText.trim());
      expect(result.handlerCalls).toBe(3);
      expect(result.plannerCalls).toBe(1);
      expect(result.events).toContain("tool");
    });

    it("honors an empty model opt-out cue without suppressing the authorized context read", async () => {
      const result = await ownerModelAcknowledgment(true, {
        contextRead: true,
        acknowledgment: "",
        requestSilence: true,
      });
      expect(result.acknowledgments).toEqual([]);
      expect(result.readCompositions).toBe(1);
      expect(result.stage1Wires).toHaveLength(2);
      expect(result.stage1Wires[0]).toContain(
        "If the user requests silence or no acknowledgment",
      );
      expect(result.events).toContain("tool");
      expect(result.handlerCalls).toBe(3);
      expect(result.plannerCalls).toBe(1);
    });

    it("does not claim a new runtime opt-out parser when the model violates the authoring rule", async () => {
      const acknowledgment = "Let me check.";
      const result = await ownerModelAcknowledgment(true, {
        contextRead: true,
        acknowledgment,
        requestSilence: true,
      });
      // This change reuses the existing text classifier; it does not add a
      // natural-language parser for the user's silence request. The normative
      // rule is present on the wire and remains the model's responsibility.
      expect(result.stage1Wires[0]).toContain(
        "If the user requests silence or no acknowledgment",
      );
      expect(result.acknowledgments).toEqual([acknowledgment]);
      expect(result.handlerCalls).toBe(3);
      expect(result.plannerCalls).toBe(1);
    });

    it("retains actual authorized PII restoration after whole-cue admission and before delivery", async () => {
      const acknowledgment = "Let me check.";
      const result = await ownerModelAcknowledgment(true, {
        contextRead: true,
        acknowledgment,
        restorePii: true,
      });
      expect(result.acknowledgments).toEqual([acknowledgment]);
      expect(result.events).toContain("restore-ack");
      expect(result.events.indexOf("restore-ack")).toBeLessThan(
        result.events.indexOf("ack-start"),
      );
      expect(result.events.indexOf("ack-end")).toBeLessThan(
        result.events.indexOf("read-handle-response"),
      );
      expect(result.handlerCalls).toBe(3);
    });

    it.each(["Let me check.", "Let me open Calendar."])(
      "revalidates the actual owner-exclusive audience before publishing a native read cue: %s",
      async (acknowledgment) => {
        const result = await ownerModelAcknowledgment(true, {
          contextRead: true,
          acknowledgment,
          changeAudienceBeforeAcknowledgment: true,
          restorePii: true,
        });
        expect(result.acknowledgments).toEqual([]);
        expect(result.chunks.join(" ")).not.toContain(
          "PRIVATE_CONTEXT_TEST_VALUE",
        );
        expect(result.events).not.toContain("ack-start");
      },
    );

    it.each(["Let me check.", "Let me open Calendar."])(
      "retains cancellation during actual native-read audience revalidation: %s",
      async (acknowledgment) => {
        const result = await ownerModelAcknowledgment(true, {
          contextRead: true,
          acknowledgment,
          abortDuringRevalidation: true,
        });
        expect(result.acknowledgments).toEqual([]);
        expect(result.events).not.toContain("ack-start");
        expect(result.plannerCalls).toBe(0);
      },
    );

    it("does not publish after a turn is cancelled by the completed context-read boundary", async () => {
      const result = await ownerModelAcknowledgment(true, {
        contextRead: true,
        acknowledgment: "Let me open Calendar.",
        abortAfterContextRead: true,
      });
      expect(result.acknowledgments).toEqual([]);
      expect(result.events).not.toContain("ack-start");
      expect(result.plannerCalls).toBe(0);
    });
  });
});
