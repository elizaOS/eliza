/** Real executor, post-delivery lifecycle and PGlite ledger; no live models. */
import { registerCalendarTimeZoneResolver } from "@elizaos/contracts";
import {
  ActionMode,
  type ActionResult,
  attestDeliveryAudienceFromCanonicalRoom,
  ChannelType,
  createContextObject,
  executePlannedToolCall,
  type Memory,
  ModelType,
  RunTerminalOwner,
  type State,
  TaskService,
  type ToolDefinition,
  type UUID,
  withRoomDeliverySettlement,
} from "@elizaos/core";
import {
  __resetDefaultTriageServiceForTests,
  getDefaultTriageService,
} from "@elizaos/plugin-assistant";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  actionResultToPlannerToolResult,
  runPlannerLoop,
} from "../../../plugin-assistant/src/runtime/planner-loop.ts";
import {
  compactCanonicalToolMessagesForModel,
  projectToolResultForModel,
  trajectoryStepsToMessages,
} from "../../../plugin-assistant/src/runtime/planner-rendering.ts";
import {
  collectPlannerTools,
  collectPreviousActionResults,
  executeV5PlannedToolCall,
} from "../../../plugin-assistant/src/services/message/planned-tool.ts";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.ts";
import { resolveOwnerFactStore } from "../lifeops/owner/fact-store.ts";
import { LifeOpsRepository } from "../lifeops/repository.ts";
import { LifeOpsService } from "../lifeops/service.ts";
import { executeRawSql } from "../lifeops/sql.ts";
import {
  __resetBriefComposersForTests,
  briefAction,
  briefDeliveredImpressionsAction,
  setBriefComposers,
} from "./brief.ts";

let fixture: Awaited<ReturnType<typeof createLifeOpsTestRuntime>>;
let repository: LifeOpsRepository;
let roomId: UUID;
let ownerId: UUID;
const finalText =
  "Sort receipts is marked done. Board prep is at 7 pm; your inbox is not connected.";
const params = {
  action: "compose_evening",
  include: { calendar: true, inbox: true, life: true, commitments: false },
};

beforeAll(async () => {
  vi.stubEnv("ELIZA_DISABLE_LIFEOPS_SCHEDULER", "1");
  fixture = await createLifeOpsTestRuntime({ withLLM: false });
  await TaskService.stop(fixture.runtime);
  const service = new LifeOpsService(fixture.runtime);
  ownerId = service.ownerEntityId() as UUID;
  repository = new LifeOpsRepository(fixture.runtime);
  await LifeOpsRepository.bootstrapSchema(fixture.runtime);
  if (!(await fixture.runtime.getEntityById(ownerId))) {
    await fixture.runtime.createEntity({
      id: ownerId,
      agentId: fixture.runtime.agentId,
      names: ["Brief owner"],
      metadata: {},
    });
  }
  const worldId = crypto.randomUUID() as UUID;
  await fixture.runtime.ensureWorldExists({
    id: worldId,
    agentId: fixture.runtime.agentId,
    name: "Brief owner world",
    metadata: { ownership: { ownerId }, roles: { [ownerId]: "OWNER" } },
  });
  roomId = await fixture.runtime.createRoom({
    id: crypto.randomUUID() as UUID,
    worldId,
    source: "client_chat",
    type: ChannelType.DM,
    name: "Brief owner DM",
  });
  await fixture.runtime.createRoomParticipants(
    [ownerId, fixture.runtime.agentId],
    roomId,
  );
}, 120_000);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T01:30:00.000Z"));
  __resetBriefComposersForTests();
  __resetDefaultTriageServiceForTests();
  vi.spyOn(resolveOwnerFactStore(fixture.runtime), "read").mockResolvedValue(
    {},
  );
  registerCalendarTimeZoneResolver(
    fixture.runtime,
    async () => "America/Los_Angeles",
  );
  setBriefComposers({
    loadCalendar: async () => [
      {
        id: "meeting-exact-id",
        title: "Board prep",
        startAt: "2026-10-06T02:00:00.000Z",
        endAt: "2026-10-06T03:00:00.000Z",
      },
    ],
    loadInbox: async () => ({ items: [], coverage: "not_connected" }),
    loadLife: async () => [],
    loadCompletedToday: async () => [
      {
        id: "completed-exact-id",
        title: "Sort receipts",
        kind: "todo",
        dueAt: "2026-10-05T22:00:00.000Z",
        completedAt: "2026-10-06T00:00:00.000Z",
        state: "completed",
      },
    ],
    loadCommitments: async () => [],
    loadEngagementSummaries: async () => [],
  });
  vi.spyOn(fixture.runtime, "useModel").mockRejectedValue(
    new Error("No inner model call allowed"),
  );
  await executeRawSql(
    fixture.runtime,
    "DELETE FROM app_lifeops.life_brief_item_engagements",
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  __resetBriefComposersForTests();
});
afterAll(async () => {
  await fixture?.cleanup();
  vi.unstubAllEnvs();
});

async function invoke(
  replyOwner: "planner" | "action" = "planner",
  format?: "json",
  options: {
    text?: string;
    parameters?: Record<string, unknown>;
    toolName?: string;
  } = {},
) {
  const message: Memory = {
    id: crypto.randomUUID() as UUID,
    agentId: fixture.runtime.agentId,
    entityId: ownerId,
    roomId,
    content: {
      text: options.text ?? "Give me my evening dossier including my inbox.",
      source: "client_chat",
      channelType: ChannelType.DM,
    },
  };
  await attestDeliveryAudienceFromCanonicalRoom(fixture.runtime, message);
  const callback = vi.fn(async () => []);
  const result = await executePlannedToolCall(
    fixture.runtime,
    {
      message,
      replyOwner: replyOwner === "planner" ? "planner" : undefined,
      userRoles: ["OWNER"],
      activeContexts: ["productivity"],
      callback,
    },
    {
      name: options.toolName ?? "BRIEF",
      params: {
        ...params,
        ...options.parameters,
        ...(format ? { format } : {}),
      },
    },
  );
  return { message, callback, result };
}

async function deliver(
  message: Memory,
  result: ActionResult,
  failure?: Error,
  responseText = finalText,
) {
  const runtime = fixture.runtime;
  const response: Memory = {
    id: crypto.randomUUID() as UUID,
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId,
    content: { text: responseText, actions: ["REPLY"], simple: true },
  };
  // Use the same conversion as finalPlannerState, which intentionally omits
  // some planner-only flags while retaining canonical action data.
  const actionResults = collectPreviousActionResults(
    {
      archivedSteps: [],
      steps: [
        {
          toolCall: { name: String(result.data?.actionName ?? "BRIEF") },
          result: actionResultToPlannerToolResult(result),
        },
      ],
      context: { events: [] },
    } as never,
    [briefAction],
  );
  const state: State = { values: {}, data: { actionResults }, text: "" };
  const queue = runtime.roomHandlerQueue;
  await queue.withLease(roomId, async (lease) => {
    await withRoomDeliverySettlement(runtime, roomId, lease, async () => {
      const owner = new RunTerminalOwner(
        runtime,
        crypto.randomUUID() as UUID,
        message,
        Date.now(),
        lease,
      );
      owner.trackAfterDelivery("post_turn", async () => {
        await runtime.runActionsByMode(
          ActionMode.ALWAYS_AFTER,
          message,
          state,
          { didRespond: true, responses: [response] },
        );
      });
      owner.request({ status: "completed", effects: [] });
      await Promise.resolve();
      expect(
        await repository.listBriefItemEngagements(runtime.agentId),
      ).toHaveLength(0);
      if (failure) throw failure;
    });
  });
}

describe("planner-owned BRIEF", () => {
  it.each([
    ["2026-10-06T01:48:00.000Z", "America/Los_Angeles", undefined, "evening"],
    ["2026-10-05T23:59:59.000Z", "America/Los_Angeles", undefined, "morning"],
    ["2026-10-06T00:00:00.000Z", "America/Los_Angeles", undefined, "evening"],
    ["2026-10-06T01:48:00.000Z", "Asia/Tokyo", undefined, "morning"],
    ["2026-10-06T01:48:00.000Z", "America/Los_Angeles", "19:15", "morning"],
    ["2026-10-06T02:15:00.000Z", "America/Los_Angeles", "19:15", "evening"],
  ])(
    "uses the owner-local daily default at %s in %s with evening start %s",
    async (instant, timeZone, eveningStart, kind) => {
      vi.setSystemTime(new Date(instant));
      registerCalendarTimeZoneResolver(fixture.runtime, async () => timeZone);
      if (eveningStart)
        vi.mocked(
          resolveOwnerFactStore(fixture.runtime).read,
        ).mockResolvedValue({
          eveningWindow: {
            value: { startLocal: eveningStart, endLocal: "23:00" },
            provenance: { source: "first_run", recordedAt: instant },
          },
        });
      const completed = vi.fn(async () => [
        {
          id: "completed-daily",
          title: "Sort receipts",
          kind: "todo" as const,
          dueAt: instant,
          completedAt: instant,
          state: "completed" as const,
        },
      ]);
      const inbox = vi.fn(async ({ explicit }: { explicit?: boolean }) =>
        explicit
          ? { items: [], coverage: "not_connected" as const }
          : undefined,
      );
      setBriefComposers({ loadCompletedToday: completed, loadInbox: inbox });
      const { result } = await invoke("planner", undefined, {
        text: "Give me my daily dossier using the connected sources available now.",
        parameters: { action: "compose_morning", period: "this_week" },
      });
      expect(result).toMatchObject({
        success: true,
        data: {
          subaction: `compose_${kind}`,
          briefing: { kind, period: "today", generatedAt: instant },
        },
      });
      expect(inbox).toHaveBeenCalledWith(
        expect.objectContaining({ explicit: false }),
      );
      expect(completed).toHaveBeenCalledTimes(kind === "evening" ? 1 : 0);
      const briefing = result.data?.briefing as {
        sections: object;
        sourceErrors?: object;
      };
      expect(briefing.sections).not.toHaveProperty("inbox");
      expect(briefing.sourceErrors).toBeUndefined();
      const grounding = JSON.parse(String(result.data?.replyGrounding))
        .prompt as string;
      expect(grounding).toContain(`owner's ${kind} briefing for today`);
      expect(grounding).toContain(timeZone);
      if (kind === "evening") expect(grounding).toContain('"completedToday"');
      expect(fixture.runtime.useModel).not.toHaveBeenCalled();
    },
  );

  it("does not let invented exclusions remove ordinary briefing sources", async () => {
    const calendar = vi.fn(async () => []);
    const life = vi.fn(async () => []);
    const commitments = vi.fn(async () => []);
    const inbox = vi.fn(async () => ({
      items: [],
      coverage: "complete" as const,
    }));
    setBriefComposers({
      loadCalendar: calendar,
      loadLife: life,
      loadCommitments: commitments,
      loadInbox: inbox,
    });
    const { result } = await invoke("planner", undefined, {
      text: "Give me my daily dossier using the connected sources available now.",
      parameters: {
        include: {
          calendar: false,
          inbox: false,
          life: false,
          commitments: false,
        },
      },
    });
    expect(result.success).toBe(true);
    for (const load of [calendar, life, commitments, inbox])
      expect(load).toHaveBeenCalledTimes(1);
    expect(inbox).toHaveBeenCalledWith(
      expect.objectContaining({ explicit: false }),
    );
    expect(result.data?.briefing).toMatchObject({
      sections: { calendar: [], inbox: [], life: [], commitments: [] },
    });
    expect(fixture.runtime.useModel).not.toHaveBeenCalled();
  });

  it.each([
    ["Give me my morning briefing.", "compose_morning", "morning", "today"],
    ["Give me my evening briefing.", "compose_evening", "evening", "today"],
    ["Give me my weekly briefing.", "compose_weekly", "weekly", "this_week"],
    [
      "Give me my morning briefing for tomorrow.",
      "compose_morning",
      "morning",
      "tomorrow",
    ],
  ])(
    "retains an explicitly named kind/period at night: %s",
    async (text, action, kind, period) => {
      vi.setSystemTime(new Date("2026-10-06T05:48:00.000Z"));
      const { result } = await invoke("planner", undefined, {
        text,
        parameters: { action, period },
      });
      expect(result.data?.briefing).toMatchObject({ kind, period });
      expect(fixture.runtime.useModel).not.toHaveBeenCalled();
    },
  );

  it.each([
    "disconnected",
    "named-morning",
    "named-evening",
    "explicit",
    "failed",
  ])("retains actual registered inbox coverage for %s", async (mode) => {
    // Restore the real adapter-selection loader, keeping the other sources local.
    __resetBriefComposersForTests();
    setBriefComposers({
      loadCalendar: async () => [],
      loadLife: async () => [],
      loadCompletedToday: async () => [],
      loadCommitments: async () => [],
      loadEngagementSummaries: async () => [],
    });
    const failedRead = vi.fn(async () => {
      throw new Error("Configured inbox failed");
    });
    if (mode === "failed")
      getDefaultTriageService().register({
        source: "slack",
        isAvailable: () => true,
        capabilities: () => ({
          list: true,
          search: false,
          manage: {},
          send: { reply: false, new: false, schedule: false },
          worlds: "single",
          channels: "none",
        }),
        listMessages: failedRead,
      } as never);
    const text =
      mode === "explicit"
        ? "Give me my daily dossier including my inbox."
        : mode === "named-morning"
          ? "Give me my morning briefing."
          : mode === "named-evening"
            ? "Give me my evening briefing."
            : "Give me my daily dossier using the connected sources available now.";
    const { result } = await invoke("planner", undefined, { text });
    const briefing = result.data?.briefing as {
      sections: object;
      sourceErrors?: object;
    };
    if (mode === "disconnected" || mode.startsWith("named-")) {
      expect(briefing.sections).not.toHaveProperty("inbox");
      expect(briefing.sourceErrors).toBeUndefined();
    } else {
      expect(briefing.sourceErrors).toEqual({
        inbox: mode === "failed" ? "unavailable" : "not_connected",
      });
    }
    if (mode === "failed") expect(failedRead).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.useModel).not.toHaveBeenCalled();
  });

  it("leaves the reply to the planner when it passes JSON format", async () => {
    const { result, callback } = await invoke("planner", "json", {
      text: "Give me my daily dossier as JSON.",
    });
    expect(result).toMatchObject({
      success: true,
      modelReplyRequired: true,
      turnComplete: false,
    });
    expect(result.text).toBeUndefined();
    expect(result.userFacingText).toBeUndefined();
    expect(result.verifiedUserFacing).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
    expect(fixture.runtime.useModel).not.toHaveBeenCalled();
  });

  it("retains standalone parameters for a generic request and explicit source exclusion", async () => {
    const result = await invoke("action", "json", {
      text: "Give me my daily dossier using the connected sources available now.",
      parameters: { action: "compose_morning", period: "this_week" },
    });
    expect(result.result.data?.briefing).toMatchObject({
      kind: "morning",
      period: "this_week",
      sourceErrors: { inbox: "not_connected" },
    });
    const excluded = await invoke("planner", undefined, {
      text: "Give me my daily dossier without the inbox.",
      parameters: { include: { inbox: false } },
    });
    expect(excluded.result.data?.briefing).toMatchObject({ sections: {} });
    expect(excluded.result.data?.briefing).not.toHaveProperty("sections.inbox");
    expect(fixture.runtime.useModel).not.toHaveBeenCalled();
  });

  it.each([
    ["Give me my morning briefing.", "compose_evening", "compose_morning"],
    ["Give me my evening briefing.", "compose_morning", "compose_evening"],
    ["Give me my daily dossier.", "recalibrate", "compose_evening"],
    ["Give me my daily dossier.", "reset_recalibration", "compose_evening"],
  ])(
    "honors the whole request before contradictory control/kind parameters: %s / %s",
    async (text, action, expected) => {
      const controlRead = vi.spyOn(
        LifeOpsRepository.prototype,
        "summarizeBriefItemEngagements",
      );
      const preferenceWrite = vi.spyOn(
        LifeOpsRepository.prototype,
        "recordBriefItemEngagement",
      );
      const { result } = await invoke("planner", undefined, {
        text,
        parameters: { action },
      });
      expect(result).toMatchObject({
        success: true,
        data: { subaction: expected },
        modelReplyRequired: true,
        turnComplete: false,
      });
      expect(controlRead).not.toHaveBeenCalled();
      expect(preferenceWrite).not.toHaveBeenCalled();
      expect(fixture.runtime.useModel).not.toHaveBeenCalled();
    },
  );

  it.each([
    "BRIEF_COMPOSE_MORNING",
    "BRIEF_RECALIBRATE",
    "BRIEF_RESET_RECALIBRATION",
  ])(
    "records delivery for %s normalized to an evening generic dossier",
    async (toolName) => {
      vi.setSystemTime(new Date("2026-10-06T01:48:00.000Z"));
      const { message, result } = await invoke("planner", undefined, {
        text: "Give me my daily dossier using the connected sources available now.",
        parameters: { action: toolName.slice("BRIEF_".length).toLowerCase() },
        toolName,
      });
      expect(result.data).toMatchObject({
        actionName: toolName,
        subaction: "compose_evening",
      });
      await deliver(message, result);
      expect(
        await repository.listBriefItemEngagements(fixture.runtime.agentId),
      ).toHaveLength(1);
    },
  );

  it("hands the final composer an as-of preview without moving today's source window", async () => {
    vi.setSystemTime(new Date("2026-10-06T05:00:00.000Z"));
    const calendar = vi.fn(async () => []);
    const dueTimes = [
      "2026-10-06T01:01:00.000Z",
      "2026-10-06T01:11:00.000Z",
      "2026-10-06T02:23:00.000Z",
      "2026-10-06T03:17:00.000Z",
      "2026-10-06T04:51:00.000Z",
    ];
    setBriefComposers({
      loadCalendar: calendar,
      loadInbox: async () => undefined,
      loadLife: async () =>
        dueTimes.map((dueAt, index) => ({
          id: `preview-${index}`,
          title: `Delivery check ${index}`,
          kind: "reminder" as const,
          dueAt,
          state: "visible" as const,
        })),
    });
    const { result } = await invoke("planner", undefined, {
      text: "Give me my morning briefing.",
      parameters: { action: "compose_morning", period: "today" },
    });
    expect(calendar).toHaveBeenCalledWith(
      expect.objectContaining({ period: "today" }),
    );
    const wire = projectToolResultForModel(
      actionResultToPlannerToolResult(result),
    );
    const prompt = JSON.parse(String(wire.data?.replyGrounding))
      .prompt as string;
    const payload = JSON.parse(prompt.split("Data:\n")[1]);
    expect(payload).toMatchObject({
      kind: "morning",
      period: "today",
      localAsOfDate: "2026-10-05",
      asOf: "2026-10-06T05:00:00.000Z",
      sections: { calendar: [] },
    });
    expect(
      payload.sections.life.map(
        (item: { timeContext: { dueAt: { dateRelationToAsOf: string } } }) =>
          item.timeContext.dueAt.dateRelationToAsOf,
      ),
    ).toEqual(dueTimes.map(() => "same_local_date"));
    expect(prompt).toContain("identify it as a preview as of localAsOf");
    expect(result.data?.briefing).toMatchObject({
      kind: "morning",
      period: "today",
      sections: { calendar: [] },
    });
    expect(fixture.runtime.useModel).not.toHaveBeenCalled();
  });

  it("defers complete local-time grounding once", async () => {
    const { result, callback } = await invoke();
    expect(result).toMatchObject({
      success: true,
      transcriptVisibility: "internal",
      modelReplyRequired: true,
      turnComplete: false,
      promptDataMode: "replace-data",
    });
    expect(callback).not.toHaveBeenCalled();
    expect(fixture.runtime.useModel).not.toHaveBeenCalled();
    expect(result.text).toBeUndefined();
    expect(result.userFacingText).toBeUndefined();
    expect(result.verifiedUserFacing).toBeUndefined();
    expect(result.data?.briefing).toMatchObject({
      sections: { completedToday: [{ title: "Sort receipts" }] },
      sourceErrors: { inbox: "not_connected" },
    });
    const projected = projectToolResultForModel(
      actionResultToPlannerToolResult(result),
    );
    expect(projected.data).not.toHaveProperty("briefing");
    expect(projected).not.toHaveProperty("promptData");
    const prompt = JSON.parse(String(projected.data?.replyGrounding))
      .prompt as string;
    expect(prompt.match(/You are composing the owner's/g)).toHaveLength(1);
    expect(prompt).toContain("Obey the editorial block");
    expect(prompt).toContain(
      "not_connected means no readable inbox connection",
    );
    expect(prompt).toContain(
      "Completion and delivery cannot be inferred from a timestamp",
    );
    const encoded = prompt.split("\nData:\n")[1];
    const payload = JSON.parse(encoded);
    expect(encoded).toBe(JSON.stringify(payload));
    const native = compactCanonicalToolMessagesForModel(
      trajectoryStepsToMessages([
        {
          iteration: 1,
          toolCall: { id: "brief-complete-data", name: "BRIEF" },
          result: actionResultToPlannerToolResult(result),
        },
      ]),
    );
    const tool = native.find((message) => message.role === "tool");
    if (!tool || !Array.isArray(tool.content))
      throw new Error("Missing native result");
    const part = tool.content.find((part) => part.type === "tool-result");
    if (part?.type !== "tool-result" || part.output.type !== "text")
      throw new Error("Missing native text result");
    expect(JSON.parse(part.output.value).data.replyGrounding).toBe(
      projected.data?.replyGrounding,
    );
    expect(payload).toMatchObject({
      asOf: "2026-10-06T01:30:00.000Z",
      timeZone: "America/Los_Angeles",
      sourceErrors: { inbox: "not_connected" },
    });
    expect(payload.sections.calendar[0]).toMatchObject({
      id: "meeting-exact-id",
      startAt: "2026-10-06T02:00:00.000Z",
      timeContext: {
        startAt: { localDate: "2026-10-05", relationToAsOf: "after_as_of" },
      },
    });
    expect(
      payload.sections.completedToday[0].timeContext.completedAt.localDate,
    ).toBe("2026-10-05");
    expect(JSON.stringify(projected).match(/Data:/g)).toHaveLength(1);
    expect(fixture.runtime.useModel).not.toHaveBeenCalled();
  });

  it("requires the operation on the canonical planner wire and executes one authorized brief before final composition", async () => {
    const message: Memory = {
      id: crypto.randomUUID() as UUID,
      agentId: fixture.runtime.agentId,
      entityId: ownerId,
      roomId,
      content: {
        text: "Give me my morning brief using the connected sources available now.",
        source: "client_chat",
        channelType: ChannelType.DM,
      },
    };
    await attestDeliveryAudienceFromCanonicalRoom(fixture.runtime, message);
    const actions = fixture.runtime.actions.filter(
      (action) =>
        action.name === "BRIEF" ||
        briefAction.subActions?.includes(action.name),
    );
    const context = createContextObject({
      id: "brief-native-operation",
      events: actions.map((action) => ({
        id: `tool:${action.name}`,
        type: "tool",
        tool: { name: action.name, action },
      })),
    });
    const tools = collectPlannerTools(context, actions, {
      canonicalFamilies: true,
    });
    expect(tools.filter((tool) => tool.name.startsWith("BRIEF"))).toHaveLength(
      1,
    );
    const plan = vi.fn(
      async (_type: string, input: Record<string, unknown>) => {
        const wire = (input.tools as ToolDefinition[]).find(
          (tool) => tool.name === "BRIEF",
        );
        expect(wire?.parameters?.required).toContain("action");
        expect(wire?.parameters?.properties?.action.enum).toEqual([
          "compose_morning",
          "compose_evening",
          "compose_weekly",
          "recalibrate",
          "reset_recalibration",
        ]);
        return {
          text: "",
          toolCalls: [
            {
              id: "brief",
              name: "BRIEF",
              arguments: {
                action: "compose_morning",
                eliza_turn_scope: "final",
              },
            },
          ],
        };
      },
    );
    const evaluate = vi.fn(async () => ({
      success: true,
      decision: "FINISH" as const,
      messageToUser: finalText,
    }));
    const executions: unknown[] = [];
    const outcome = await runPlannerLoop({
      context,
      tools,
      runtime: { useModel: plan },
      executeToolCall: async (toolCall) => {
        const result = await executeV5PlannedToolCall({
          runtime: fixture.runtime,
          plannerRuntime: { useModel: plan },
          plannerContext: context,
          toolCall,
          executorCtx: {
            message,
            replyOwner: "planner",
            userRoles: ["OWNER"],
            activeContexts: ["productivity"],
            state: { values: {}, data: {}, text: "" },
          },
          executorOptions: { actions },
        });
        executions.push(result);
        return result;
      },
      deferInternalReplyRecoveryToCaller: true,
      evaluate,
    });
    expect(plan).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(executions).toEqual([
      expect.objectContaining({ success: true, modelReplyRequired: true }),
    ]);
    expect(outcome.finalMessage).toBe(finalText);
    expect(fixture.runtime.useModel).not.toHaveBeenCalled();
  });

  it.each([undefined, "not-a-brief-operation"])(
    "does not complete or replay BRIEF when the planner supplies operation %s",
    async (operation) => {
      const message: Memory = {
        id: crypto.randomUUID() as UUID,
        agentId: fixture.runtime.agentId,
        entityId: ownerId,
        roomId,
        content: {
          text: "Give me my morning brief using the connected sources available now.",
          source: "client_chat",
          channelType: ChannelType.DM,
        },
      };
      await attestDeliveryAudienceFromCanonicalRoom(fixture.runtime, message);
      const actions = fixture.runtime.actions.filter(
        (action) =>
          action.name === "BRIEF" ||
          briefAction.subActions?.includes(action.name),
      );
      const parent = actions.find((action) => action.name === "BRIEF");
      if (!parent) throw new Error("Missing registered BRIEF");
      const handler = vi.spyOn(parent, "handler");
      const context = createContextObject({
        id: "brief-missing-operation",
        events: actions.map((action) => ({
          id: `tool:${action.name}`,
          type: "tool",
          tool: { name: action.name, action },
        })),
      });
      const execute = executeV5PlannedToolCall({
        runtime: fixture.runtime,
        plannerRuntime: fixture.runtime,
        plannerContext: context,
        toolCall: {
          name: "BRIEF",
          params: operation === undefined ? {} : { action: operation },
        },
        executorCtx: {
          message,
          replyOwner: "planner",
          userRoles: ["OWNER"],
          activeContexts: ["productivity"],
          state: { values: {}, data: {}, text: "" },
        },
        executorOptions: { actions },
      });
      if (operation === undefined) {
        // Missing operation still enters the existing family subplanner; its
        // model is blocked locally, so no handler or successful receipt exists.
        await expect(execute).rejects.toThrow("No inner model call allowed");
        expect(fixture.runtime.useModel).toHaveBeenCalledTimes(1);
        const input = vi.mocked(fixture.runtime.useModel).mock.calls[0]?.[1];
        const tool = ((input?.tools ?? []) as ToolDefinition[]).find(
          (entry) => entry.name === "BRIEF",
        );
        expect(tool?.parameters?.required).toContain("action");
      } else {
        const result = await execute;
        expect(result.success).toBe(false);
        expect(result.modelReplyRequired).not.toBe(true);
        expect(result.verifiedUserFacing).not.toBe(true);
        expect(result.turnComplete).not.toBe(true);
        expect(fixture.runtime.useModel).not.toHaveBeenCalled();
      }
      expect(handler).not.toHaveBeenCalled();
      expect(
        await repository.listBriefItemEngagements(fixture.runtime.agentId),
      ).toHaveLength(0);
    },
  );

  it.each([
    new Error("delivery rejected"),
    new DOMException("cancelled", "AbortError"),
  ])(
    "does not record impressions on failed or cancelled delivery: %s",
    async (failure) => {
      const { message, result } = await invoke();
      await expect(deliver(message, result, failure)).rejects.toThrow(
        failure.message,
      );
      expect(
        await repository.listBriefItemEngagements(fixture.runtime.agentId),
      ).toHaveLength(0);
      expect(fixture.runtime.useModel).not.toHaveBeenCalled();
    },
  );

  it("records actual delivered titles only after settlement and idempotently on replay", async () => {
    const { message, result } = await invoke();
    expect(
      fixture.runtime.actions.find(
        (a) => a.name === briefDeliveredImpressionsAction.name,
      )?.mode,
    ).toBe(ActionMode.ALWAYS_AFTER);
    await deliver(message, result);
    const rows = await repository.listBriefItemEngagements(
      fixture.runtime.agentId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "rendered",
      sourceId: "meeting-exact-id",
      briefingId: result.data?.briefingId,
    });
    const state: State = {
      values: {},
      data: { actionResults: [result] },
      text: "",
    };
    await fixture.runtime.runActionsByMode(
      ActionMode.ALWAYS_AFTER,
      message,
      state,
      {
        responses: [
          {
            id: crypto.randomUUID() as UUID,
            entityId: fixture.runtime.agentId,
            roomId,
            content: { text: finalText, simple: true },
          } as Memory,
        ],
      },
    );
    expect(
      await repository.listBriefItemEngagements(fixture.runtime.agentId),
    ).toEqual(rows);
    expect(fixture.runtime.useModel).not.toHaveBeenCalled();
  });

  it.each(["early-only", "internal", "synthetic", "different-room"])(
    "does not count an unqualified final delivery: %s",
    async (kind) => {
      const { message, result } = await invoke();
      const early = {
        id: crypto.randomUUID() as UUID,
        entityId: fixture.runtime.agentId,
        roomId,
        content: { text: finalText, actions: ["REPLY"] },
      } as Memory;
      const final = {
        ...early,
        content: {
          ...early.content,
          simple: true,
          ...(kind === "internal"
            ? { transcriptVisibility: "internal" as const }
            : {}),
          ...(kind === "synthetic" ? { elizaSyntheticFailure: true } : {}),
        },
        ...(kind === "different-room"
          ? { roomId: crypto.randomUUID() as UUID }
          : {}),
      };
      await fixture.runtime.runActionsByMode(
        ActionMode.ALWAYS_AFTER,
        message,
        { values: {}, data: { actionResults: [result] }, text: "" },
        { responses: kind === "early-only" ? [early] : [early, final] },
      );
      expect(
        await repository.listBriefItemEngagements(fixture.runtime.agentId),
      ).toHaveLength(0);
    },
  );

  it("keeps standalone narrative composition and callback delivery", async () => {
    vi.mocked(fixture.runtime.useModel).mockResolvedValue(finalText as never);
    const { result, callback } = await invoke("action");
    expect(fixture.runtime.useModel).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.useModel).toHaveBeenCalledWith(
      ModelType.TEXT_LARGE,
      expect.objectContaining({
        prompt: expect.stringContaining(
          "You are composing the owner's evening briefing",
        ),
      }),
    );
    expect(callback).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: true,
      text: finalText,
      userFacingText: finalText,
      turnComplete: true,
    });
    expect(result.modelReplyRequired).toBeUndefined();
  });

  it("preserves collected facts when local-time grounding fails", async () => {
    registerCalendarTimeZoneResolver(fixture.runtime, async () => {
      throw new Error("owner timezone unavailable");
    });
    const { result, callback } = await invoke();
    expect(result).toMatchObject({
      success: true,
      turnComplete: false,
      replyFailure: { code: "BRIEF_REPLY_GROUNDING_FAILED" },
      data: {
        briefing: { sections: { calendar: [{ id: "meeting-exact-id" }] } },
      },
    });
    expect(callback).not.toHaveBeenCalled();
    expect(fixture.runtime.useModel).not.toHaveBeenCalled();
  });
});
