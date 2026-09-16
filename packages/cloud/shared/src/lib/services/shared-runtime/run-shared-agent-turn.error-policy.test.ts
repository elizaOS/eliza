/**
 * Pins the Shared turn boundary after AgentRuntime became its sole inference
 * engine. The deterministic harness verifies capability gating, runtime
 * delegation, memory commit ordering, and cause-preserving failures; provider
 * streaming mechanics are covered by shared-eliza-runtime.test.ts.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ChannelType, stableStringify } from "@elizaos/core/edge";
import type {
  RunSharedAgentTurnInput,
  SharedReminderOperation,
  SharedTurnMessage,
} from "./run-shared-agent-turn";

const TEST_REMINDER_DELIVERY = {
  platform: "telegram" as const,
  project: "eliza-app",
  connectorAccountId: "bot:123456789",
  chatId: "123456789",
};

function groundedReminderAssistant(
  content: string,
  receipt: {
    operation: SharedReminderOperation;
    success: boolean;
    taskIds?: string[];
    candidateTaskIds?: string[];
    requiresSelection?: boolean;
    requiresConfirmation?: boolean;
  },
) {
  return {
    role: "assistant" as const,
    content,
    reminderAction: {
      actionName: "REMINDERS" as const,
      operation: receipt.operation,
      success: receipt.success,
      taskIds: receipt.taskIds ?? [],
      ...(receipt.candidateTaskIds ? { candidateTaskIds: receipt.candidateTaskIds } : {}),
      ...(receipt.requiresSelection ? { requiresSelection: true as const } : {}),
      deliveryScope: stableStringify(TEST_REMINDER_DELIVERY),
      ...(receipt.requiresConfirmation ? { requiresConfirmation: true as const } : {}),
    },
  };
}

function assistantText(content: string): SharedTurnMessage {
  return { role: "assistant", content };
}

function reminderTurnInput(
  message: string,
  history: SharedTurnMessage[] = [],
  messageIds?: RunSharedAgentTurnInput["messageIds"],
): RunSharedAgentTurnInput {
  return {
    character: { name: "Eliza", system: "You are Eliza." },
    history,
    message,
    ...(messageIds ? { messageIds } : {}),
    execution: {
      agentKey: "personal:user-1",
      roomKey: "personal:user-1",
      authenticatedPersonalSharedUser: true,
      channel: { type: ChannelType.DM, source: "telegram" },
      reminders: {
        delivery: TEST_REMINDER_DELIVERY,
        runner: {} as never,
      },
    },
  };
}

let providerConfigured = true;
let runtimeFailure: Error | null = null;
let streamFailure: Error | null = null;
let runtimeActionResults: Array<Record<string, unknown>> | undefined;
const runtimeInputs: Array<Record<string, unknown>> = [];
const streamInputs: Array<Record<string, unknown>> = [];

mock.module("../../providers/language-model", () => ({
  hasLanguageModelProviderConfigured: () => providerConfigured,
}));

mock.module("./shared-eliza-runtime", () => ({
  runSharedElizaRuntimeTurn: async (input: Record<string, unknown>) => {
    runtimeInputs.push(input);
    if (runtimeFailure) throw runtimeFailure;
    const history = input.history as Array<{ role: string; content: string }>;
    return {
      reply: "runtime reply",
      history: [
        ...history,
        {
          id: (input.messageIds as { user?: string } | undefined)?.user,
          role: "user",
          content: String(input.message),
        },
        {
          id: (input.messageIds as { assistant?: string } | undefined)?.assistant,
          role: "assistant",
          content: "runtime reply",
        },
      ],
      model: String(input.model),
      degraded: false,
      ...(runtimeActionResults ? { actionResults: runtimeActionResults } : {}),
    };
  },
  runSharedElizaRuntimeTurnStream: async (input: Record<string, unknown>) => {
    streamInputs.push(input);
    if (streamFailure) throw streamFailure;
    return {
      model: String(input.model),
      degraded: false,
      parts: (async function* () {
        yield { type: "text-delta" as const, text: "runtime " };
        yield { type: "finish" as const, text: "runtime reply" };
      })(),
    };
  },
}));

const { runSharedAgentTurn, runSharedAgentTurnStream } = await import("./run-shared-agent-turn");

beforeEach(() => {
  providerConfigured = true;
  runtimeFailure = null;
  streamFailure = null;
  runtimeActionResults = undefined;
  runtimeInputs.length = 0;
  streamInputs.length = 0;
});

describe("Shared turn AgentRuntime boundary", () => {
  test("delegates every ordinary turn to AgentRuntime with a fail-closed guest execution", async () => {
    const result = await runSharedAgentTurn({
      character: { name: "Nova", system: "You are Nova.", model: "gpt-oss-120b" },
      history: [],
      message: "hello",
    });

    expect(result.reply).toBe("runtime reply");
    expect(runtimeInputs).toHaveLength(1);
    expect(runtimeInputs[0]).toMatchObject({
      agentKey: "shared:Nova",
      execution: {
        agentKey: "shared:Nova",
        roomKey: "shared:Nova",
        channel: { type: ChannelType.DM, source: "shared-runtime" },
      },
    });
    expect(JSON.stringify(runtimeInputs[0])).toContain("Shared runtime capabilities");
    expect(JSON.stringify(runtimeInputs[0])).toContain("prerequisites:");
  });

  test("preserves server-owned voice execution semantics", async () => {
    await runSharedAgentTurn({
      character: { name: "Eliza", system: "You are Eliza." },
      history: [],
      message: "hello",
      execution: {
        agentKey: "personal:user-1",
        roomKey: "personal:user-1",
        authenticatedPersonalSharedUser: true,
        channel: { type: ChannelType.VOICE_DM, source: "client_chat" },
      },
    });

    expect(runtimeInputs[0]?.execution).toMatchObject({
      agentKey: "personal:user-1",
      authenticatedPersonalSharedUser: true,
      channel: { type: ChannelType.VOICE_DM, source: "client_chat" },
    });
  });

  test("requires a grounded reminder action result before accepting an executable reminder reply", async () => {
    const reminderInput = {
      character: { name: "Eliza", system: "You are Eliza." },
      history: [],
      message: "Remind me in 2 minutes to stretch",
      execution: {
        agentKey: "personal:user-1",
        authenticatedPersonalSharedUser: true as const,
        channel: { type: ChannelType.DM, source: "telegram" },
        reminders: {
          delivery: {
            platform: "telegram" as const,
            project: "eliza-app",
            chatId: "123456789",
          },
          runner: {} as never,
        },
      },
    };

    const error = await runSharedAgentTurn(reminderInput).catch((caught) => caught as Error);
    expect(error.message).toContain("AgentRuntime turn failed");
    expect((error.cause as Error).message).toContain("without an action result");
    expect(JSON.stringify(runtimeInputs[0])).toContain("Call REMINDERS before any terminal answer");
    expect(JSON.stringify(runtimeInputs[0])).toContain("never invent success");

    runtimeActionResults = [
      {
        success: true,
        data: { actionName: "REMINDERS", operation: "create" },
      },
    ];
    const result = await runSharedAgentTurn(reminderInput);
    expect(result.reply).toBe("runtime reply");
  });

  test("attaches exact server reminder provenance to the assistant history message", async () => {
    runtimeActionResults = [
      {
        success: true,
        data: {
          actionName: "REMINDERS",
          operation: "create",
          task: { taskId: "created-reminder-1" },
        },
      },
    ];
    const result = await runSharedAgentTurn(
      reminderTurnInput("Remind me tomorrow to stretch", [], {
        user: "user-1",
        assistant: "assistant-1",
      }),
    );

    expect(result.history.at(-1)).toMatchObject({
      id: "assistant-1",
      role: "assistant",
      reminderAction: {
        actionName: "REMINDERS",
        operation: "create",
        success: true,
        taskIds: ["created-reminder-1"],
        deliveryScope: stableStringify(TEST_REMINDER_DELIVERY),
      },
    });

    runtimeActionResults = [
      {
        success: true,
        data: {
          actionName: "REMINDERS",
          operation: "update",
          task: { taskId: "replacement-reminder" },
        },
        effectReceipts: [
          {
            resource: {
              kind: "shared.reminder",
              id: "superseded-reminder",
            },
          },
        ],
      },
    ];
    const updated = await runSharedAgentTurn(
      reminderTurnInput("Update the reminder Stretch to 4pm"),
    );
    expect(updated.history.at(-1)?.reminderAction?.taskIds).toEqual(["replacement-reminder"]);
  });

  test.each([
    {
      message: "Can you clear the list?",
      previous:
        "Your reminders:\n• add something to your todo — on Aug 28, 2026 at 3:06 AM Europe/Paris",
      predecessor: { operation: "list" as const, success: true },
      expectedOperation: "clear",
    },
    {
      message: "3 06 no 1:06",
      previous:
        "Got it — I'll remind you on Aug 28, 2026 at 3:06 AM Europe/Paris: add something to your todo",
      predecessor: {
        operation: "create" as const,
        success: true,
        taskIds: ["grounded-reminder-1"],
      },
      expectedOperation: "update",
    },
    {
      message: "Change the reminder to 3:06, not 1:06",
      previous:
        "Got it — I'll remind you on Aug 28, 2026 at 1:06 AM Europe/Paris: add something to your todo",
      predecessor: {
        operation: "create" as const,
        success: true,
        taskIds: ["grounded-reminder-1"],
      },
      expectedOperation: "update",
    },
    {
      message: "Could you please change the reminder to 3:06, not 1:06",
      previous:
        "Got it — I'll remind you on Aug 28, 2026 at 1:06 AM Europe/Paris: add something to your todo",
      predecessor: {
        operation: "create" as const,
        success: true,
        taskIds: ["grounded-reminder-1"],
      },
      expectedOperation: "update",
    },
    {
      message: "yes",
      previous:
        "Clearing removes every active reminder. Please confirm by replying “yes, clear all reminders”.",
      predecessor: {
        operation: "clear" as const,
        success: false,
        requiresConfirmation: true,
      },
      expectedOperation: "clear",
    },
    {
      message: "Oui, je confirme, vas-y",
      previous:
        "Clearing removes every active reminder. Please confirm by replying “yes, clear all reminders”.",
      predecessor: {
        operation: "clear" as const,
        success: false,
        requiresConfirmation: true,
      },
      expectedOperation: "clear",
    },
    {
      message: "Oui, je confirme, vas-y, efface tous mes rappels",
      previous:
        "Clearing removes every active reminder. Please confirm by replying “yes, clear all reminders”.",
      predecessor: {
        operation: "clear" as const,
        success: false,
        requiresConfirmation: true,
      },
      expectedOperation: "clear",
    },
    {
      message: "Do it, clear all reminders",
      previous:
        "Clearing removes every active reminder. Please confirm by replying “yes, clear all reminders”.",
      predecessor: {
        operation: "clear" as const,
        success: false,
        requiresConfirmation: true,
      },
      expectedOperation: "clear",
    },
    {
      message: "Remove the reminder Stretch",
      previous:
        "Clearing removes every active reminder. Please confirm by replying “yes, clear all reminders”.",
      predecessor: {
        operation: "clear" as const,
        success: false,
        requiresConfirmation: true,
      },
      expectedOperation: "delete",
    },
    {
      message: "the 3:06 one",
      previous:
        "More than one reminder matches that. Which one do you mean?\n• Stretch — on Aug 28, 2026 at 3:06 AM Europe/Paris",
      predecessor: { operation: "list" as const, success: true },
      expectedOperation: "update",
    },
  ])(
    "keeps the contextual reminder follow-up '$message' on REMINDERS",
    async ({ message, previous, predecessor, expectedOperation }) => {
      runtimeActionResults = [
        {
          success: false,
          data: { actionName: "REMINDERS", operation: expectedOperation },
        },
      ];
      await runSharedAgentTurn({
        character: { name: "Eliza", system: "You are Eliza." },
        history: [groundedReminderAssistant(previous, predecessor)],
        message,
        execution: {
          agentKey: "personal:user-1",
          roomKey: "personal:user-1",
          authenticatedPersonalSharedUser: true,
          channel: { type: ChannelType.DM, source: "telegram" },
          reminders: {
            delivery: TEST_REMINDER_DELIVERY,
            runner: {} as never,
          },
        },
      });

      const prompt = JSON.stringify(runtimeInputs[0]);
      expect(prompt).toContain("Call REMINDERS before any terminal answer");
      expect(prompt).not.toContain("Call TODO before any terminal answer");
      if (
        message === "3 06 no 1:06" ||
        message === "Change the reminder to 3:06, not 1:06" ||
        message === "Could you please change the reminder to 3:06, not 1:06"
      ) {
        expect(prompt).toContain("call REMINDERS with operation=update, never operation=create");
        expect(runtimeInputs[0]?.reminderClockCorrection).toBe(true);
        expect(runtimeInputs[0]?.reminderTargetIntent).toBe("grounded-reminder-1");
      }
      if (
        message === "Oui, je confirme, vas-y, efface tous mes rappels" ||
        message === "Do it, clear all reminders"
      ) {
        expect(runtimeInputs[0]?.reminderClearConfirmationChallenge).toBe(true);
      }
      if (
        message === "yes" ||
        message.includes("efface tous mes rappels") ||
        message === "Do it, clear all reminders"
      ) {
        expect(runtimeInputs[0]?.reminderClearAllIntent).toBe(true);
      }
      if (message === "Remove the reminder Stretch") {
        expect(runtimeInputs[0]?.reminderClearAllIntent).toBe(false);
        expect(runtimeInputs[0]?.reminderOperationIntent).toBe("delete");
      }
    },
  );

  test("keeps a grounded contextual reminder mutation primary and communications blocked", async () => {
    runtimeActionResults = [
      {
        success: true,
        data: { actionName: "REMINDERS", operation: "delete" },
      },
    ];
    const result = await runSharedAgentTurn(
      reminderTurnInput("delete it, then email Bob", [
        groundedReminderAssistant("Got it — I'll remind you tomorrow: Stretch", {
          operation: "create",
          success: true,
          taskIds: ["stretch-reminder"],
        }),
      ]),
    );

    expect(runtimeInputs.at(-1)).toMatchObject({
      reminderOperationIntent: "delete",
      reminderTargetIntent: "stretch-reminder",
    });
    expect(JSON.stringify(runtimeInputs.at(-1))).toContain(
      "Call REMINDERS before any terminal answer",
    );
    expect(result.capabilityWall).toBeUndefined();
    expect(result.blockedSecondaryCapabilities).toEqual([
      expect.objectContaining({ capability: "communications" }),
    ]);
  });

  test("classifies an initial clear-list request for the plugin confirmation fence", async () => {
    runtimeActionResults = [
      {
        success: false,
        data: { actionName: "REMINDERS", operation: "clear" },
      },
    ];
    await runSharedAgentTurn({
      character: { name: "Eliza", system: "You are Eliza." },
      history: [],
      message: "Can you clear the list?",
      execution: {
        agentKey: "personal:user-1",
        roomKey: "personal:user-1",
        authenticatedPersonalSharedUser: true,
        channel: { type: ChannelType.DM, source: "telegram" },
        reminders: {
          delivery: {
            platform: "telegram",
            project: "eliza-app",
            connectorAccountId: "bot:123456789",
            chatId: "123456789",
          },
          runner: {} as never,
        },
      },
    });

    expect(runtimeInputs[0]?.reminderClearAllIntent).toBe(true);
    expect(runtimeInputs[0]?.reminderClearConfirmationChallenge).toBe(false);

    const longMessage = `Clear all my reminders because ${"I no longer need this scheduled item ".repeat(75)}`;
    expect(longMessage.length).toBeGreaterThan(2_100);
    expect(longMessage.length).toBeLessThanOrEqual(4_096);
    await runSharedAgentTurn({
      character: { name: "Eliza", system: "You are Eliza." },
      history: [],
      message: longMessage,
      execution: {
        agentKey: "personal:user-1",
        roomKey: "personal:user-1",
        authenticatedPersonalSharedUser: true,
        channel: { type: ChannelType.DM, source: "telegram" },
        reminders: {
          delivery: {
            platform: "telegram",
            project: "eliza-app",
            connectorAccountId: "bot:123456789",
            chatId: "123456789",
          },
          runner: {} as never,
        },
      },
    });
    expect(runtimeInputs.at(-1)?.reminderClearAllIntent).toBe(true);

    const overTransportMessage = `Clear all my reminders because ${"this extra app context must not disable the mutation fence ".repeat(90)}`;
    expect(overTransportMessage.length).toBeGreaterThan(4_096);
    await runSharedAgentTurn({
      character: { name: "Eliza", system: "You are Eliza." },
      history: [],
      message: overTransportMessage,
      execution: {
        agentKey: "personal:user-1",
        roomKey: "personal:user-1",
        authenticatedPersonalSharedUser: true,
        channel: { type: ChannelType.DM, source: "client_chat" },
        reminders: {
          delivery: {
            platform: "telegram",
            project: "eliza-app",
            connectorAccountId: "bot:123456789",
            chatId: "123456789",
          },
          runner: {} as never,
        },
      },
    });
    expect(runtimeInputs.at(-1)?.reminderClearAllIntent).toBe(true);
  });

  test.each(["Dismiss all reminders", "Cancel all my reminders"])(
    "routes the destructive all-target synonym through the clear confirmation fence: %s",
    async (message) => {
      runtimeActionResults = [
        {
          success: false,
          data: {
            actionName: "REMINDERS",
            operation: "clear",
            requiresConfirmation: true,
          },
        },
      ];
      await runSharedAgentTurn(reminderTurnInput(message));

      expect(runtimeInputs.at(-1)?.reminderClearAllIntent).toBe(true);
      expect(runtimeInputs.at(-1)?.reminderOperationIntent).toBeUndefined();
      expect(runtimeInputs.at(-1)?.reminderClearConfirmationChallenge).toBe(false);
    },
  );

  test.each(["Don't clear the list", "Explain how to clear all reminders"])(
    "does not treat negated or discussed clear text as a clear-all command: %s",
    async (message) => {
      runtimeActionResults = [
        {
          success: false,
          data: { actionName: "REMINDERS", operation: "list" },
        },
      ];
      await runSharedAgentTurn({
        character: { name: "Eliza", system: "You are Eliza." },
        history: [],
        message,
        execution: {
          agentKey: "personal:user-1",
          roomKey: "personal:user-1",
          authenticatedPersonalSharedUser: true,
          channel: { type: ChannelType.DM, source: "telegram" },
          reminders: {
            delivery: {
              platform: "telegram",
              project: "eliza-app",
              connectorAccountId: "bot:123456789",
              chatId: "123456789",
            },
            runner: {} as never,
          },
        },
      });

      expect(runtimeInputs.at(-1)?.reminderClearAllIntent).toBe(false);
    },
  );

  test.each([
    ["List my reminders", "list", undefined],
    ["Show me the reminders", "list", undefined],
    ["Remind me tomorrow to call mom", "create", undefined],
    ["Will you remind me tomorrow to call mom", "create", undefined],
    ["Remind me on August 30 to call mom", "create", undefined],
    ["Create a reminder to call mom", "create", undefined],
    ["Remove the reminder add something in my todo", "delete", "add something in my todo"],
    ["Could you please delete the reminder Stretch please", "delete", "stretch"],
    ["Update the reminder Stretch to 4pm", "update", "stretch"],
    ["Reschedule the reminder Stretch to 4pm", "update", "stretch"],
    ["Snooze my reminder Stretch for 5 minutes", "snooze", "stretch"],
    ["Complete the reminder Stretch", "complete", "stretch"],
    ["Dismiss the reminder Stretch", "dismiss", "stretch"],
    ["Cancel the reminder Stretch", "dismiss", "stretch"],
    ["Delete my Stretch reminder", "delete", "stretch"],
    ["Update my Stretch reminder to 4pm", "update", "stretch"],
    ["Complete my Stretch reminder", "complete", "stretch"],
    ["Snooze my Stretch reminder for 5 minutes", "snooze", "stretch"],
    ["Delete the reminder Stretch, then email Bob", "delete", "stretch"],
  ])(
    "derives trusted reminder operation intent for '%s'",
    async (message, expectedOperation, expectedTarget) => {
      runtimeActionResults = [
        {
          success: false,
          data: { actionName: "REMINDERS", operation: expectedOperation },
        },
      ];
      await runSharedAgentTurn({
        character: { name: "Eliza", system: "You are Eliza." },
        history: [],
        message,
        execution: {
          agentKey: "personal:user-1",
          roomKey: "personal:user-1",
          authenticatedPersonalSharedUser: true,
          channel: { type: ChannelType.DM, source: "telegram" },
          reminders: {
            delivery: {
              platform: "telegram",
              project: "eliza-app",
              connectorAccountId: "bot:123456789",
              chatId: "123456789",
            },
            runner: {} as never,
          },
        },
      });

      expect(runtimeInputs.at(-1)?.reminderOperationIntent).toBe(expectedOperation);
      expect(runtimeInputs.at(-1)?.reminderTargetIntent).toBe(expectedTarget);
    },
  );

  test("rejects a mismatched reminder result for an explicit update before any terminal reply", async () => {
    const input = reminderTurnInput("Update the reminder Stretch to 4pm");
    runtimeActionResults = [
      {
        success: true,
        data: { actionName: "REMINDERS", operation: "delete" },
      },
    ];

    const error = await runSharedAgentTurn(input).catch((caught) => caught as Error);
    expect((error.cause as Error).message).toContain("without an action result");
    expect(runtimeInputs.at(-1)).toMatchObject({
      reminderOperationIntent: "update",
      reminderTargetIntent: "stretch",
    });

    runtimeActionResults = [
      {
        success: true,
        data: { actionName: "REMINDERS", operation: "update" },
      },
    ];
    await expect(runSharedAgentTurn(input)).resolves.toMatchObject({
      reply: "runtime reply",
    });
  });

  test.each([
    "Don't remind me at 3pm",
    "Can you explain how to remind me at 3pm?",
    "Could you not update my reminder?",
    "I don't want you to update my reminder to 3pm",
    "Don’t update my reminder",
    "Update the reminder Stretch to 4pm, actually don't",
  ])("does not require or trust a negated or discussed reminder mutation: %s", async (message) => {
    await runSharedAgentTurn({
      character: { name: "Eliza", system: "You are Eliza." },
      history: [],
      message,
      execution: {
        agentKey: "personal:user-1",
        roomKey: "personal:user-1",
        authenticatedPersonalSharedUser: true,
        channel: { type: ChannelType.DM, source: "telegram" },
        reminders: {
          delivery: {
            platform: "telegram",
            project: "eliza-app",
            connectorAccountId: "bot:123456789",
            chatId: "123456789",
          },
          runner: {} as never,
        },
      },
    });

    expect(runtimeInputs.at(-1)?.reminderOperationIntent).toBeUndefined();
    expect(JSON.stringify(runtimeInputs.at(-1))).not.toContain(
      "Call REMINDERS before any terminal answer",
    );
  });

  test.each([
    { operation: "create" as const, success: true, taskIds: ["created-reminder"] },
    { operation: "list" as const, success: false, taskIds: [] },
    { operation: "complete" as const, success: false, taskIds: ["failed-target"] },
  ])("does not treat bare confirmation as contextual after $operation", async (receipt) => {
    await runSharedAgentTurn(
      reminderTurnInput("do it", [groundedReminderAssistant("Previous result", receipt)]),
    );

    expect(runtimeInputs.at(-1)?.reminderClearAllIntent).toBe(false);
    expect(runtimeInputs.at(-1)?.reminderOperationIntent).toBeUndefined();
    expect(runtimeInputs.at(-1)?.reminderTargetIntent).toBeUndefined();
    expect(JSON.stringify(runtimeInputs.at(-1))).not.toContain(
      "Call REMINDERS before any terminal answer",
    );
  });

  test.each([[], ["first-reminder", "second-reminder"]])(
    "does not authorize contextual delete with an unbound receipt target",
    async (taskIds) => {
      runtimeActionResults = [
        {
          success: false,
          data: { actionName: "REMINDERS", operation: "delete" },
        },
      ];
      await runSharedAgentTurn(
        reminderTurnInput("delete it", [
          groundedReminderAssistant("Previous reminder result", {
            operation: "list",
            success: true,
            taskIds,
          }),
        ]),
      );

      expect(runtimeInputs.at(-1)?.reminderTargetIntent).toBeUndefined();
      expect(JSON.stringify(runtimeInputs.at(-1))).not.toContain(
        "Call REMINDERS before any terminal answer",
      );
    },
  );

  test("preserves an ambiguous delete operation and exact candidates for an ordinal followup", async () => {
    runtimeActionResults = [
      {
        success: false,
        data: {
          actionName: "REMINDERS",
          operation: "delete",
          requiresSelection: true,
          candidateTaskIds: ["delete-candidate-a", "delete-candidate-b"],
        },
      },
    ];
    const ambiguous = await runSharedAgentTurn(reminderTurnInput("Delete the reminder Stretch"));
    expect(ambiguous.history.at(-1)?.reminderAction).toMatchObject({
      operation: "delete",
      success: false,
      taskIds: [],
      requiresSelection: true,
      candidateTaskIds: ["delete-candidate-a", "delete-candidate-b"],
    });

    runtimeActionResults = [
      {
        success: false,
        data: { actionName: "REMINDERS", operation: "delete" },
      },
    ];
    await runSharedAgentTurn(reminderTurnInput("the second one", ambiguous.history));

    expect(runtimeInputs.at(-1)).toMatchObject({
      reminderOperationIntent: "delete",
      reminderTargetIntent: "delete-candidate-b",
    });
  });

  test("keeps a long explicit create request inside the trusted operation fence", async () => {
    runtimeActionResults = [
      {
        success: false,
        data: { actionName: "REMINDERS", operation: "create" },
      },
    ];
    const message = `Remind me tomorrow to ${"review the detailed checklist ".repeat(50)}`;
    expect(message.length).toBeGreaterThan(120);
    expect(message.length).toBeLessThan(2_000);

    await runSharedAgentTurn({
      character: { name: "Eliza", system: "You are Eliza." },
      history: [],
      message,
      execution: {
        agentKey: "personal:user-1",
        roomKey: "personal:user-1",
        authenticatedPersonalSharedUser: true,
        channel: { type: ChannelType.DM, source: "telegram" },
        reminders: {
          delivery: {
            platform: "telegram",
            project: "eliza-app",
            connectorAccountId: "bot:123456789",
            chatId: "123456789",
          },
          runner: {} as never,
        },
      },
    });

    expect(runtimeInputs.at(-1)?.reminderOperationIntent).toBe("create");
  });

  test.each([
    {
      message: "Remind me at 3:06, not 1:06, to call mom",
      provenance: "reminderClockCorrection",
      history: [],
      expectedOperation: "create",
    },
    {
      message: "Remind me at 3:06, not 1:06, to call mom",
      provenance: "reminderClockCorrection",
      history: [assistantText("Got it — I'll remind you tomorrow: stretch")],
      expectedOperation: "create",
    },
    {
      message: "3:06, no 1:06",
      provenance: "reminderClockCorrection",
      history: [assistantText("Got it — I'll remind you tomorrow: Stretch")],
    },
    {
      message: "yes, clear all reminders",
      provenance: "reminderClearConfirmationChallenge",
      history: [],
      expectedOperation: "clear",
    },
    {
      message: "yes, clear all reminders",
      provenance: "reminderClearConfirmationChallenge",
      history: [assistantText("Got it — I'll remind you tomorrow: stretch")],
      expectedOperation: "clear",
    },
    {
      message: "yes, clear all reminders",
      provenance: "reminderClearConfirmationChallenge",
      history: [assistantText("Clearing removes every active reminder. Done.")],
      expectedOperation: "clear",
    },
    {
      message: "delete it",
      provenance: "reminderClockCorrection",
      history: [assistantText("Your reminders:\n• Stretch — tomorrow at 3:00 PM")],
    },
    {
      message: "3:06, no 1:06",
      provenance: "reminderClockCorrection",
      history: [
        {
          ...groundedReminderAssistant("Got it — I'll remind you tomorrow: Stretch", {
            operation: "create",
            success: true,
            taskIds: ["interrupted-task"],
          }),
          interrupted: true,
        },
      ],
    },
    {
      message: "3:06, no 1:06",
      provenance: "reminderClockCorrection",
      history: [
        {
          role: "assistant" as const,
          content: "Got it — I'll remind you tomorrow: Stretch",
          reminderAction: {
            actionName: "REMINDERS" as const,
            operation: "create" as const,
            success: true,
            taskIds: ["other-scope-task"],
            deliveryScope: stableStringify({
              ...TEST_REMINDER_DELIVERY,
              chatId: "different-chat",
            }),
          },
        },
      ],
    },
  ])(
    "does not trust first-turn text as server mutation provenance: $message",
    async ({ message, provenance, history, expectedOperation }) => {
      runtimeActionResults = expectedOperation
        ? [
            {
              success: false,
              data: {
                actionName: "REMINDERS",
                operation: expectedOperation,
              },
            },
          ]
        : undefined;
      await runSharedAgentTurn(reminderTurnInput(message, history));

      expect(runtimeInputs.at(-1)?.[provenance]).toBe(false);
      expect(JSON.stringify(runtimeInputs.at(-1))).not.toContain(
        "operation=update, never operation=create",
      );
      if (!expectedOperation) {
        expect(runtimeInputs.at(-1)?.reminderOperationIntent).toBeUndefined();
        expect(runtimeInputs.at(-1)?.reminderTargetIntent).toBeUndefined();
        expect(JSON.stringify(runtimeInputs.at(-1))).not.toContain(
          "Call REMINDERS before any terminal answer",
        );
      }
    },
  );

  test.each(["Clean the reminder list please", "Remove the reminder add something in my todo"])(
    "routes the exact reminder phrase to REMINDERS when Todo is enabled too: %s",
    async (message) => {
      const expectedOperation = message.startsWith("Clean") ? "clear" : "delete";
      runtimeActionResults = [
        {
          success: false,
          data: { actionName: "REMINDERS", operation: expectedOperation },
        },
      ];
      await runSharedAgentTurn({
        character: { name: "Eliza", system: "You are Eliza." },
        history: [],
        message,
        execution: {
          agentKey: "personal:user-1",
          roomKey: "personal:user-1",
          authenticatedPersonalSharedUser: true,
          channel: { type: ChannelType.DM, source: "telegram" },
          todos: {} as never,
          reminders: {
            delivery: {
              platform: "telegram",
              project: "eliza-app",
              connectorAccountId: "bot:123456789",
              chatId: "123456789",
            },
            runner: {} as never,
          },
        },
      });

      const prompt = JSON.stringify(runtimeInputs[0]);
      expect(prompt).toContain("Call REMINDERS before any terminal answer");
      expect(prompt).not.toContain("Call TODO before any terminal answer");
    },
  );

  test("requires a grounded media action result instead of accepting a model-invented tool failure", async () => {
    const mediaInput = {
      character: { name: "Eliza", system: "You are Eliza." },
      history: [
        {
          role: "assistant" as const,
          content: "The image tool had a billing problem earlier.",
        },
      ],
      message: "Generate an image of a golden retriever puppy",
      execution: {
        agentKey: "personal:user-1",
        authenticatedPersonalSharedUser: true as const,
        channel: { type: ChannelType.GROUP, source: "blooio" },
        media: {
          canGenerateMedia: async () => true,
          generateMedia: async () => ({ mediaType: "image" as const }),
        },
      },
    };

    const error = await runSharedAgentTurn(mediaInput).catch((caught) => caught as Error);
    expect(error.message).toContain("AgentRuntime turn failed");
    expect((error.cause as Error).message).toContain(
      "executable GENERATE_MEDIA request without an action result",
    );
    expect(JSON.stringify(runtimeInputs[0])).toContain(
      "Call GENERATE_MEDIA before any terminal answer",
    );
    expect(JSON.stringify(runtimeInputs[0])).toContain(
      "generation was attempted, unavailable, or failed is not an execution result",
    );

    runtimeActionResults = [
      {
        success: false,
        error: "provider rejected request",
        data: { actionName: "GENERATE_MEDIA", mediaType: "image" },
      },
    ];
    const groundedFailure = await runSharedAgentTurn(mediaInput);
    expect(groundedFailure.actionResults).toEqual(runtimeActionResults);
  });

  test("buffers explicit media streams so the required action receipt cannot be bypassed", async () => {
    runtimeActionResults = [
      {
        success: true,
        data: { actionName: "GENERATE_MEDIA", mediaType: "video" },
      },
    ];
    const result = await runSharedAgentTurnStream({
      character: { name: "Eliza", system: "You are Eliza." },
      history: [],
      message: "Create a video from this attached image",
      execution: {
        agentKey: "personal:user-1",
        authenticatedPersonalSharedUser: true,
        channel: { type: ChannelType.GROUP, source: "blooio" },
        media: {
          canGenerateMedia: async () => true,
          generateMedia: async () => ({ mediaType: "video" }),
        },
      },
    });

    expect(runtimeInputs).toHaveLength(1);
    expect(streamInputs).toHaveLength(0);
    const parts = [];
    if (!result.parts) throw new Error("Expected buffered media parts");
    for await (const part of result.parts) parts.push(part);
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      actionResults: runtimeActionResults,
    });
  });

  test("buffers reminder streams and emits no delta without the required grounded action result", async () => {
    const input = {
      character: { name: "Eliza", system: "You are Eliza." },
      history: [
        {
          role: "assistant" as const,
          content:
            "Clearing removes every active reminder. Please confirm by replying “yes, clear all reminders”.",
        },
      ],
      message: "yes, clear all reminders",
      execution: {
        agentKey: "personal:user-1",
        roomKey: "personal:user-1",
        authenticatedPersonalSharedUser: true as const,
        channel: { type: ChannelType.DM, source: "telegram" },
        reminders: {
          delivery: {
            platform: "telegram" as const,
            project: "eliza-app",
            connectorAccountId: "bot:123456789",
            chatId: "123456789",
          },
          runner: {} as never,
        },
      },
    };
    const observedParts: unknown[] = [];
    const streamError = (await runSharedAgentTurnStream(input).catch(
      (error) => error as Error,
    )) as Error;
    expect(streamError.message).toContain("AgentRuntime turn failed");
    expect((streamError.cause as Error).message).toContain(
      "executable REMINDERS request without an action result",
    );
    expect(observedParts).toHaveLength(0);
    expect(streamInputs).toHaveLength(0);

    runtimeActionResults = [
      {
        success: false,
        data: { actionName: "REMINDERS", operation: "clear" },
      },
    ];
    const grounded = await runSharedAgentTurnStream(input);
    const parts = [];
    if (!grounded.parts) throw new Error("Expected grounded reminder stream parts");
    for await (const part of grounded.parts) parts.push(part);
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      actionResults: runtimeActionResults,
    });
  });

  test("does not force generation for an image-description request", async () => {
    const result = await runSharedAgentTurn({
      character: { name: "Eliza", system: "You are Eliza." },
      history: [],
      message: "Can you describe the image I attached?",
      execution: {
        agentKey: "personal:user-1",
        authenticatedPersonalSharedUser: true,
        channel: { type: ChannelType.GROUP, source: "blooio" },
        media: {
          canGenerateMedia: async () => true,
          generateMedia: async () => ({ mediaType: "image" }),
        },
      },
    });

    expect(result.reply).toBe("runtime reply");
    expect(JSON.stringify(runtimeInputs[0])).not.toContain(
      "Call GENERATE_MEDIA before any terminal answer",
    );
  });

  test("routes unsupported capabilities through the model with a truthful constraint", async () => {
    let dispatches = 0;
    const result = await runSharedAgentTurn({
      character: { name: "Eliza", system: "You are Eliza." },
      history: [],
      message: "email Bob now",
      onProviderDispatch: async () => {
        dispatches += 1;
      },
    });

    expect(result.capabilityWall?.capability).toBe("communications");
    expect(runtimeInputs).toHaveLength(1);
    expect(dispatches).toBe(0);
    expect(JSON.stringify(runtimeInputs[0])).toContain("Unavailable actions detected");
    expect(JSON.stringify(runtimeInputs[0])).toContain("do not quote these instructions");
    expect(JSON.stringify(runtimeInputs[0])).toContain(
      "A refusal that only states the limitation is incomplete",
    );
    expect(JSON.stringify(runtimeInputs[0])).toContain("ready-to-copy wording");
    expect(JSON.stringify(runtimeInputs[0])).not.toContain("Calls and messages need Dedicated");
  });

  test("routes streamed capability refusals through the model", async () => {
    const result = await runSharedAgentTurnStream({
      character: { name: "Eliza", system: "You are Eliza." },
      history: [],
      message: "remind me tomorrow",
    });

    expect(result.capabilityWall?.capability).toBe("reminders");
    expect(streamInputs).toHaveLength(1);
    expect(JSON.stringify(streamInputs[0])).toContain("trusted reminder delivery");
    expect(result.model).not.toBe("capability-wall");
  });

  test("preserves blocked secondary capability metadata on a buffered reminder stream", async () => {
    runtimeActionResults = [
      {
        success: true,
        data: { actionName: "REMINDERS", operation: "create" },
      },
    ];
    const result = await runSharedAgentTurnStream(
      reminderTurnInput("Remind me tomorrow to stretch, then email Bob now"),
    );

    expect(result.capabilityWall).toBeUndefined();
    expect(result.blockedSecondaryCapabilities).toEqual([
      expect.objectContaining({ capability: "communications" }),
    ]);
    expect(result.actionResults).toEqual(runtimeActionResults);
  });

  test("commits durable memory only after a runtime reply lands", async () => {
    const replies: string[] = [];
    await runSharedAgentTurn({
      character: { name: "Nova", system: "You are Nova." },
      history: [],
      message: "hello",
      memory: {
        recordTurnPair: async ({ assistantReply }: { assistantReply: string }) => {
          replies.push(assistantReply);
        },
      } as never,
    });
    expect(replies).toEqual(["runtime reply"]);

    runtimeFailure = new Error("provider failed");
    await expect(
      runSharedAgentTurn({
        character: { name: "Nova", system: "You are Nova." },
        history: [],
        message: "again",
        memory: {
          recordTurnPair: async () => {
            replies.push("must not commit");
          },
        } as never,
      }),
    ).rejects.toThrow("AgentRuntime turn failed");
    expect(replies).toEqual(["runtime reply"]);
  });

  test("preserves the AgentRuntime failure as the turn error cause", async () => {
    runtimeFailure = new Error("provider failed");
    const error = await runSharedAgentTurn({
      character: { name: "Nova", system: "You are Nova." },
      history: [],
      message: "hello",
    }).catch((caught) => caught as Error);

    expect(error.message).toContain("AgentRuntime turn failed");
    expect(error.message).toContain("Nova");
    expect(error.cause).toBe(runtimeFailure);
  });

  test("keeps no-model configuration as the sole degraded result", async () => {
    providerConfigured = false;
    const result = await runSharedAgentTurn({
      character: { name: "Nova", system: "You are Nova." },
      history: [],
      message: "hello",
    });

    expect(result.degraded).toBe(true);
    expect(result.model).toBe("none");
    expect(runtimeInputs).toHaveLength(0);
  });

  test("delegates streaming setup to AgentRuntime and wraps setup failures", async () => {
    const result = await runSharedAgentTurnStream({
      character: { name: "Nova", system: "You are Nova." },
      history: [],
      message: "hello",
    });
    expect(streamInputs).toHaveLength(1);
    const parts = [];
    if (!result.parts) throw new Error("Expected runtime stream parts");
    for await (const part of result.parts) parts.push(part);
    expect(parts.at(-1)).toEqual({ type: "finish", text: "runtime reply" });

    streamFailure = new Error("stream setup failed");
    const error = await runSharedAgentTurnStream({
      character: { name: "Nova", system: "You are Nova." },
      history: [],
      message: "again",
    }).catch((caught) => caught as Error);
    expect(error.message).toContain("AgentRuntime stream setup failed");
    expect(error.cause).toBe(streamFailure);
  });
});
