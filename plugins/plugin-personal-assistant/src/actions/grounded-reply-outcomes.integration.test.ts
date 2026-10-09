/**
 * Preserves committed LifeOps outcomes when the reply renderer is unavailable.
 * Actions, receipt validation, and PGlite persistence are real; only reply
 * generation is a deterministic collaborator, so this is not live-model proof.
 */

import {
  type ActionResult,
  type AgentRuntime,
  type Memory,
  ModelType,
  runWithActionRoutingContext,
  type UUID,
} from "@elizaos/core";
import * as assistant from "@elizaos/plugin-assistant";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { renderGroundedActionReply } from "../../../plugin-assistant/src/actions/grounded-action-reply.ts";
import { runEvaluator } from "../../../plugin-assistant/src/runtime/evaluator.ts";
import { actionResultToPlannerToolResult } from "../../../plugin-assistant/src/runtime/planner-loop.ts";
import {
  DeviceActionService,
  withDeviceActionTurn,
} from "../../../plugin-assistant/src/services/device-actions/service.ts";
import { createV5MessageContextObject } from "../../../plugin-assistant/src/services/message/context-assembly.ts";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { readLifeOpsMeetingPreferences } from "../lifeops/owner-profile.js";
import { LifeOpsService } from "../lifeops/service.js";
import { entityAction } from "./entity.js";
import { runUpdateMeetingPreferencesHandler } from "./lib/scheduling-handler.js";
import { runLifeOperationHandler } from "./life.js";

const failure = {
  kind: "rate_limited" as const,
  code: "REPLY_RATE_LIMITED",
  message: "Reply provider rate limited.",
  transient: false as const,
};

function expectUnavailable(result: ActionResult) {
  expect(result).toMatchObject({
    success: true,
    replyFailure: failure,
    transcriptVisibility: "internal",
    turnComplete: false,
  });
  expect(result.text).toBeUndefined();
  expect(result.userFacingText).toBeUndefined();
  expect(result.verifiedUserFacing).toBeUndefined();
  expect(result.userFacingEffectReceiptIds).toBeUndefined();
}

describe("grounded reply outcomes — real PGlite", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let service: LifeOpsService;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    service = new LifeOpsService(runtime, { ownerEntityId: runtime.agentId });
  }, 180_000);

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  function message(text: string): Memory {
    return {
      id: crypto.randomUUID() as UUID,
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId: crypto.randomUUID() as UUID,
      content: { source: "autonomy", text },
    } as Memory;
  }

  it.each(["unavailable", "deferred"] as const)(
    "keeps one persisted definition and receipt with %s presentation",
    async (kind) => {
      const renderReply = vi
        .spyOn(assistant, "renderGroundedActionReply")
        .mockResolvedValue(
          kind === "unavailable"
            ? { kind, failure }
            : { kind, grounding: "All action facts and reply rules" },
        );
      const callback = vi.fn(async () => []);
      const title = `Reply ${kind} daily task`;
      const result = await runLifeOperationHandler(
        runtime,
        message(`Remind me about ${title}`),
        undefined,
        {
          parameters: {
            action: "create",
            kind: "definition",
            title,
            intent: `Remind me about ${title}`,
            details: {
              confirmed: true,
              kind: "habit",
              cadence: { kind: "daily", windows: ["morning"] },
              timeZone: "UTC",
            },
          },
        },
        callback,
      );

      if (kind === "unavailable") {
        expectUnavailable(result);
      } else {
        expect(result).toMatchObject({
          success: true,
          transcriptVisibility: "internal",
          turnComplete: false,
          data: { replyGrounding: "All action facts and reply rules" },
        });
        expect(result.replyFailure).toBeUndefined();
        expect(result.userFacingText).toBeUndefined();
      }
      const records = (await service.listDefinitions()).filter(
        (record) => record.definition.title === title,
      );
      expect(records).toHaveLength(1);
      expect(result.data).toMatchObject({
        definition: { id: records[0].definition.id },
      });
      expect(result.effectReceipts).toMatchObject([
        {
          outcome: "applied",
          operation: "lifeops.definition.create",
          resource: { id: records[0].definition.id },
          commit: { kind: "durable" },
          idempotency: { replayed: false },
        },
      ]);
      expect(renderReply).toHaveBeenCalledOnce();
      expect(callback).not.toHaveBeenCalled();
    },
  );

  it("grounds reminder confirmation in the persisted timezone, channel and absent native projection", async () => {
    const renderReply = vi
      .spyOn(assistant, "renderGroundedActionReply")
      .mockResolvedValue({
        kind: "deferred",
        grounding: "Saved reminder facts",
      });
    const callback = vi.fn(async () => []);
    const result = await runLifeOperationHandler(
      runtime,
      message("Remind me in 2 minutes, in-app only, using Tokyo time"),
      undefined,
      {
        parameters: {
          action: "create",
          kind: "definition",
          ownerSurface: "OWNER_REMINDERS",
          confirmed: true,
          intent: "Remind me in 2 minutes, in-app only, using Tokyo time",
          createPlan: {
            mode: "create",
            requestKind: "reminder",
            nativeProjection: "in_app_only",
            title: "Drink water",
            description: null,
            cadenceKind: "once",
            dueInMinutes: 2,
            timeZone: "Asia/Tokyo",
            multiStep: false,
          },
        },
      },
      callback,
    );
    const id = result.effectReceipts?.[0]?.resource.id;
    expect(result.success).toBe(true);
    expect(result.effectReceipts?.[0]).toMatchObject({
      outcome: "applied",
      commit: { kind: "durable" },
    });
    if (!id) throw new Error("Missing saved reminder receipt");
    const saved = await service.getDefinition(id);
    expect(saved.definition.timezone).toBe("Asia/Tokyo");
    expect(saved.definition.metadata.nativeAppleReminder).toBeUndefined();
    expect(renderReply).toHaveBeenCalledOnce();
    expect(renderReply.mock.calls[0]?.[0].context).toMatchObject({
      created: {
        title: saved.definition.title,
        cadence: saved.definition.cadence,
        timezone: saved.definition.timezone,
        notificationChannels: ["in_app"],
        nativeAppleReminderId: null,
      },
    });
    expect(callback).not.toHaveBeenCalled();
    expect(result.userFacingText).toBeUndefined();
  });

  it("carries app notification semantics into actual create and update completion inputs without claiming push readiness", async () => {
    // The package setup stubs rendering; this case exercises its real deferred path.
    vi.spyOn(assistant, "renderGroundedActionReply").mockImplementation(
      renderGroundedActionReply,
    );
    const useModel = vi.spyOn(runtime, "useModel");
    const createMessage = message(
      "Remind me once in two minutes in Eliza, using my in-app and Android notifications.",
    );
    const created = await runWithActionRoutingContext(
      {
        actionName: "OWNER_REMINDERS_CREATE",
        modelClass: undefined,
        messageId: createMessage.id,
        replyOwner: "planner",
      },
      () =>
        runLifeOperationHandler(runtime, createMessage, undefined, {
          parameters: {
            action: "create",
            ownerSurface: "OWNER_REMINDERS",
            createPlan: {
              mode: "create",
              requestKind: "reminder",
              nativeProjection: "in_app_only",
              title: "Notification grounding fixture",
              description: "\n  The exact saved alert body.  \n",
              cadenceKind: "once",
              dueInMinutes: 2,
              timeZone: "UTC",
              multiStep: false,
            },
          },
        }),
    );
    expect(created.success).toBe(true);
    expect(useModel).not.toHaveBeenCalled();
    const definitionId = created.effectReceipts?.[0]?.resource.id;
    if (!definitionId) throw new Error("Missing real create receipt");
    const saved = await service.getDefinition(definitionId);
    expect(saved.definition.description).toBe(
      "\n  The exact saved alert body.  \n",
    );
    const updateMessage = message(
      "In two minutes, remind me here with the exact requested alert body.",
    );
    const updated = await runWithActionRoutingContext(
      {
        actionName: "OWNER_REMINDERS_UPDATE",
        modelClass: undefined,
        messageId: updateMessage.id,
        replyOwner: "planner",
      },
      () =>
        runLifeOperationHandler(runtime, updateMessage, undefined, {
          parameters: {
            action: "update",
            target: definitionId,
            details: {
              description: "\n  Updated fixture note  \n",
            },
          },
        }),
    );
    expect(updated.success).toBe(true);
    expect(useModel).not.toHaveBeenCalled();
    const afterUpdate = await service.getDefinition(definitionId);
    expect(afterUpdate.definition.description).toBe(
      "\n  Updated fixture note  \n",
    );
    expect(afterUpdate.definition.cadence).toEqual(saved.definition.cadence);
    expect(afterUpdate.definition.title).toBe(saved.definition.title);
    const recurring = await service.createDefinition({
      title: "Recurring reminder conversion",
      description: "Recurring context",
      kind: "habit",
      cadence: { kind: "daily", windows: ["morning"] },
      timezone: "UTC",
      metadata: { ownerSurface: "OWNER_REMINDERS" },
      reminderPlan: {
        steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
      },
    });
    const convertedBody = "\n  Exact converted one-off body  \n";
    const convertedCadence = {
      kind: "once" as const,
      dueAt: new Date(Date.now() + 120_000).toISOString(),
    };
    const convertMessage = message(
      "Make this reminder once with the exact body.",
    );
    const converted = await runWithActionRoutingContext(
      {
        actionName: "OWNER_REMINDERS_UPDATE",
        modelClass: undefined,
        messageId: convertMessage.id,
        replyOwner: "planner",
      },
      () =>
        runLifeOperationHandler(runtime, convertMessage, undefined, {
          parameters: {
            action: "update",
            target: recurring.definition.id,
            details: {
              description: convertedBody,
              cadence: convertedCadence,
            },
          },
        }),
    );
    expect(converted.success).toBe(true);
    const convertedRecord = await service.getDefinition(
      recurring.definition.id,
    );
    expect(convertedRecord.definition.description).toBe(convertedBody);
    expect(convertedRecord.definition.cadence).toEqual(convertedCadence);
    expect(convertedRecord.definition.title).toBe(recurring.definition.title);
    const recurringMessage = message("Make this reminder recurring again.");
    const recurringAgain = await runWithActionRoutingContext(
      {
        actionName: "OWNER_REMINDERS_UPDATE",
        modelClass: undefined,
        messageId: recurringMessage.id,
        replyOwner: "planner",
      },
      () =>
        runLifeOperationHandler(runtime, recurringMessage, undefined, {
          parameters: {
            action: "update",
            target: recurring.definition.id,
            details: {
              description: convertedBody,
              cadence: { kind: "daily", windows: ["morning"] },
            },
          },
        }),
    );
    expect(recurringAgain.success).toBe(true);
    const recurringRecord = await service.getDefinition(
      recurring.definition.id,
    );
    expect(recurringRecord.definition.description).toBe(convertedBody.trim());
    expect(recurringRecord.definition.cadence.kind).toBe("daily");
    expect(useModel).not.toHaveBeenCalled();
    for (const [result, recordKey] of [
      [created, "created"],
      [updated, "updated"],
    ] as const) {
      expect(result.transcriptVisibility).toBe("internal");
      expect(result.userFacingText).toBeUndefined();
      expect(result.effectReceipts?.[0]).toMatchObject({
        outcome: "applied",
        commit: { kind: "durable" },
      });
      const receipt = result.effectReceipts?.[0];
      if (!receipt) throw new Error("Missing committed action receipt");
      useModel.mockResolvedValueOnce(
        JSON.stringify({
          thought:
            "The record is saved; no OS delivery result has been observed.",
          decision: "FINISH",
          success: true,
          messageToUser: "The reminder schedule is saved.",
          replyEffectStatus: "applied",
          effectReceiptIds: [receipt.receiptId],
        }),
      );
      const context = { id: `notification-grounding-${recordKey}`, events: [] };
      await runEvaluator({
        runtime,
        context,
        trajectory: {
          context,
          steps: [
            {
              iteration: 1,
              toolCall: {
                id: `reminder-${recordKey}`,
                name: "OWNER_REMINDERS",
              },
              result: actionResultToPlannerToolResult(result),
            },
          ],
          archivedSteps: [],
          plannedQueue: [],
          evaluatorOutputs: [],
        },
      });
      const call = useModel.mock.calls.at(-1);
      if (!call) throw new Error("Missing completion input");
      const [type, parameters] = call;
      expect(type).toBe(ModelType.RESPONSE_HANDLER);
      const tool = parameters.messages?.find((entry) => entry.role === "tool");
      expect(tool, JSON.stringify(parameters.messages)).toBeDefined();
      const content = tool?.content;
      const encoded =
        typeof content === "string"
          ? content
          : content?.find((part) => part.type === "tool-result")?.output;
      const wireResult = JSON.parse(
        typeof encoded === "string" ? encoded : (encoded?.value ?? "{}"),
      );
      const grounding = JSON.parse(wireResult.data.replyGrounding);
      expect(grounding.context[recordKey]).toMatchObject({
        description:
          recordKey === "created"
            ? "\n  The exact saved alert body.  \n"
            : "\n  Updated fixture note  \n",
        notificationChannels: ["in_app"],
        nativeProjection: "in_app_only",
        nativeAppleReminderId: null,
      });
      expect(grounding.context[recordKey]).not.toHaveProperty(
        "deliveryEnabled",
      );
      expect(grounding.instructions.join("\n")).toContain(
        "excludes Apple Reminders record projection, not this app's Android or iOS notifications",
      );
      expect(grounding.instructions.join("\n")).toContain(
        "only from explicit platform delivery status or error evidence",
      );
      expect(grounding.instructions.join("\n")).toContain(
        "unassessed readiness is unknown, not unavailable",
      );
      expect(grounding.instructions.join("\n")).toContain(
        "not attempted tool arguments",
      );
    }
    expect(useModel).toHaveBeenCalledTimes(2);
  });

  it("keeps the same native capability scope distinct from app records, push and recall in response and planning contexts", async () => {
    const credential = {
      subjectUserId: runtime.agentId,
      installationId: crypto.randomUUID(),
      deviceKey: "c".repeat(64),
      capabilities: ["clock.handoff.v1", "clock.handoff.v2"],
    };
    await new DeviceActionService(runtime).register(
      credential,
      "Scope fixture",
    );
    const instructions: string[] = [];
    for (const phase of ["response", "planning"] as const) {
      const context = await withDeviceActionTurn(runtime, credential, () =>
        createV5MessageContextObject({
          runtime,
          message: message(
            "Read current app records and recall the requested past note.",
          ),
          state: { values: {}, data: {}, text: "" },
          providerPhase: phase,
          includeTools: phase === "planning",
          selectedContexts: ["general"],
          preselectedActions: [],
          userRoles: ["OWNER"],
        }),
      );
      const event = context.events.find(
        (entry) => entry.id === "authenticated-phone-capability",
      );
      if (event?.type !== "instruction")
        throw new Error("Missing native capability instruction");
      instructions.push(event.content);
      const serialized = JSON.stringify(context);
      expect(serialized).toContain(
        "Other app domains and OS notification delivery retain their own availability and authorization gates",
      );
      expect(serialized).toContain(
        "use authorized current app record sources rather than historical dialogue as a proxy",
      );
      expect(serialized).toContain(
        "Use authorized targeted or full historical recall when requested or needed to resolve references and constraints",
      );
    }
    expect(instructions[0]).toBe(instructions[1]);
  });

  it("keeps one persisted entity contact and its applied receipt after reply failure", async () => {
    const renderReply = vi
      .spyOn(assistant, "renderGroundedActionReply")
      .mockResolvedValue({ kind: "unavailable", failure });
    const callback = vi.fn(async () => []);
    const result = await entityAction.handler(
      runtime,
      message("Add Reply Contact to my contacts"),
      undefined,
      {
        parameters: {
          subaction: "create",
          name: "Reply Contact",
          channel: "telegram",
          handle: "@reply_contact",
        },
      },
      callback,
    );

    expectUnavailable(result);
    const records = (await service.listRelationships({})).filter(
      (record) => record.primaryHandle === "@reply_contact",
    );
    expect(records).toHaveLength(1);
    expect(result.data).toMatchObject({ relationship: { id: records[0].id } });
    expect(result.effectReceipts).toMatchObject([
      {
        outcome: "applied",
        operation: "lifeops.entity.contact.save",
        resource: { id: records[0].id },
        commit: { kind: "durable" },
      },
    ]);
    expect(renderReply).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
  });

  it("keeps the scheduling preference write and task evidence after reply failure", async () => {
    const renderReply = vi
      .spyOn(assistant, "renderGroundedActionReply")
      .mockResolvedValue({ kind: "unavailable", failure });
    const callback = vi.fn(async () => []);
    const result = await runUpdateMeetingPreferencesHandler(
      runtime,
      message("Make my default meetings 47 minutes"),
      undefined,
      { parameters: { defaultDurationMinutes: 47 } },
      callback,
    );

    expectUnavailable(result);
    expect(await readLifeOpsMeetingPreferences(runtime)).toMatchObject({
      defaultDurationMinutes: 47,
    });
    expect(result.data).toMatchObject({
      preferences: { defaultDurationMinutes: 47 },
      preferenceTaskId: expect.any(String),
      updatedFields: ["defaultDurationMinutes"],
    });
    expect(renderReply).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
  });

  it("delivers the exact model reply once and keeps its canonical entity receipt", async () => {
    const text = "Your contacts are ready to review.";
    const renderReply = vi
      .spyOn(assistant, "renderGroundedActionReply")
      .mockResolvedValue({ kind: "model", text });
    const callback = vi.fn(async () => []);
    const result = await entityAction.handler(
      runtime,
      message("List my contacts"),
      undefined,
      { parameters: { subaction: "read" } },
      callback,
    );

    expect(result).toMatchObject({
      success: true,
      text,
      userFacingText: text,
      verifiedUserFacing: true,
    });
    expect(result.replyFailure).toBeUndefined();
    expect(result.effectReceipts).toHaveLength(1);
    expect(result.userFacingEffectReceiptIds).toEqual([
      result.effectReceipts?.[0].receiptId,
    ]);
    expect(callback).toHaveBeenCalledExactlyOnceWith({ text });
    expect(renderReply).toHaveBeenCalledOnce();
  });
});
