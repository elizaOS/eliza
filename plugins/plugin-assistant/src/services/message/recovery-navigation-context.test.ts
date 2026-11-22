/**
 * Live 2026-10-30 (tj-35f6b24bfaf1b0): "Can you go home?" prepared Home
 * navigation, but Stage 1 held only "On it.", so the host recovered the reply
 * from the selected history. The grounding judge read the complete originals
 * once and was then still offered the forbidden full-context branch on the
 * structured-output wire; it chose that branch and the turn failed with
 * REPLY_GROUNDING_REVIEW_FAILED (reviewStage=context_request).
 *
 * The controlled judge behaves like a strict-schema provider: every branch the
 * response schema offers is valid output, and it requests context whenever it
 * may.
 */
import {
  type ActionResult,
  hashString,
  type Memory,
  ModelType,
  normalizeEffectReceipt,
  type PlannerTrajectory,
  stringToUuid,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePlannedReplyEgress } from "./egress-policy";

const REVIEW_PREFIX = "Review recovered reply grounding.";
const REPLY = "Heading home.";
const FULL_CONTEXT =
  "prior_message:user: what's on my calendar today?\nprior_message:agent: drink coffeee at 9.\nprior_message:user: Can you open the calendar and show me that?\ncurrent_request: Can you go home?";
const SELECTED_CONTEXT = "current_request: Can you go home?";
const HANDOFF = "35c902f9-bc5d-4c20-a5d8-f03c713ab7cf";

const runtimes: ReturnType<typeof createSQLiteTestRuntime>[] = [];
afterEach(async () => {
  await Promise.all(
    runtimes.splice(0).map(async (runtime) => {
      await runtime.stop();
      await runtime.close();
    }),
  );
});

function preparedHomeNavigation(): ActionResult {
  const navigation = {
    effect: "view_navigation",
    status: "prepared",
    viewId: "chat",
    path: "/chat",
    label: "Home",
    stepId: "16e8d4dc-cd9d-4c51-af2f-c5529aab58f6",
    handoffId: HANDOFF,
  };
  return {
    success: true,
    text: JSON.stringify(navigation),
    transcriptVisibility: "internal",
    data: {
      actionName: "VIEWS_SHOW",
      awaitingDeviceExecution: true,
      navigation,
      view: { id: "chat", label: "Home", path: "/chat" },
    },
    values: {
      mode: "show",
      viewId: "chat",
      viewPath: "/chat",
      label: "Home",
      completedActionDelivered: false,
      completedActionHandoffId: HANDOFF,
      navigationPrepared: true,
    },
  } as ActionResult;
}

function fixture(judge: (offersContextRequest: boolean) => unknown) {
  const runtime = createSQLiteTestRuntime({
    character: { name: "Alpha", bio: "test", settings: {} },
    logLevel: "fatal",
  });
  runtimes.push(runtime);
  const renderPrompts: string[] = [];
  const reviewPrompts: string[] = [];
  runtime.registerModel(
    ModelType.TEXT_SMALL,
    async (_runtime, params) => {
      if (params.prompt.startsWith(REVIEW_PREFIX)) {
        reviewPrompts.push(params.prompt);
        return JSON.stringify(
          judge(
            JSON.stringify(params.responseSchema).includes("contextRequest"),
          ),
        );
      }
      renderPrompts.push(params.prompt);
      return JSON.stringify({ response: REPLY, effectReceiptIds: [] });
    },
    "navigation-context-test",
  );
  const message: Memory = {
    id: stringToUuid("navigation-context-turn"),
    roomId: stringToUuid("navigation-context-room"),
    entityId: stringToUuid("navigation-context-owner"),
    agentId: runtime.agentId,
    content: { text: "Can you go home?" },
  };
  const beforeContextRestore = vi.fn(async () => {});
  return {
    runtime,
    message,
    beforeContextRestore,
    renderPrompts,
    reviewPrompts,
    recover: () =>
      resolvePlannedReplyEgress({
        runtime,
        message,
        reply: "",
        providers: {
          VIEW_NAVIGATION: {
            data: {
              views: [
                { id: "chat", label: "Home", aliases: ["home"] },
                { id: "calendar", label: "Calendar" },
              ],
              currentViewId: "calendar",
            },
          },
        } as never,
        actionResults: [preparedHomeNavigation()],
        recovery: {
          context: FULL_CONTEXT,
          historySelection: {
            context: SELECTED_CONTEXT,
            fullContextHash: hashString(FULL_CONTEXT),
            contextHash: hashString(SELECTED_CONTEXT),
          },
          pendingToolCalls: [],
          evaluatorOutputs: [],
          ownerExclusiveDisclosureUsed: false,
        },
        beforeContextRestore,
      }),
  };
}

const prospectiveVerdict = {
  grounded: true,
  claims: [
    {
      quote: REPLY,
      actor: "assistant",
      change: false,
      supported: true,
      evidence: '"status":"prepared"',
    },
  ],
};

it("grounds a prepared navigation reply after the judge restores complete originals", async () => {
  const f = fixture((offersContextRequest) =>
    offersContextRequest ? { contextRequest: "full" } : prospectiveVerdict,
  );
  await expect(f.recover()).resolves.toEqual({
    text: REPLY,
    effectReceiptIds: [],
  });
  expect(f.renderPrompts).toHaveLength(1);
  expect(f.reviewPrompts).toHaveLength(2);
  expect(f.reviewPrompts[0]).toContain(JSON.stringify(SELECTED_CONTEXT));
  expect(f.reviewPrompts[1]).toContain(JSON.stringify(FULL_CONTEXT));
  expect(f.reviewPrompts[1]).toContain(
    "All available original evidence is supplied.",
  );
  expect(f.beforeContextRestore).toHaveBeenCalledTimes(1);
});

it("still fails closed when the judge requests context it was not offered", async () => {
  const f = fixture(() => ({ contextRequest: "full" }));
  await expect(f.recover()).rejects.toMatchObject({
    code: "REPLY_GROUNDING_REVIEW_FAILED",
    context: { reviewStage: "context_request" },
  });
  expect(f.reviewPrompts).toHaveLength(2);
});

it("still rejects an unsupported navigation claim after restoration", async () => {
  const f = fixture((offersContextRequest) =>
    offersContextRequest
      ? { contextRequest: "full" }
      : {
          grounded: false,
          claims: [{ ...prospectiveVerdict.claims[0], supported: false }],
        },
  );
  await expect(f.recover()).rejects.toMatchObject({
    code: "REPLY_GROUNDING_FAILED",
    message: "Recovered reply asserts an unsupported outcome",
  });
});

// A leading state assertion rejected the entire live answer before the
// prepared Calendar handoff could reach the originating renderer.
describe("a prepared view with a settled, independent read", () => {
  const readReply = "You have one event tomorrow, the camera rehearsal.";
  const rejectedReply = `Calendar is open. ${readReply}`;
  const fixedReply = `I’ll open Calendar. ${readReply}`;

  function calendarReply() {
    const f = fixture(() => prospectiveVerdict);
    f.message.content.text = "Open Calendar and tell me what’s on tomorrow.";
    f.runtime.registerAction({
      name: "CALENDAR_FEED",
      description: "Read the current Calendar agenda.",
      historicalObservationOperations: ["calendar.feed.read"],
      validate: async () => true,
      handler: async () => {
        throw Error("Reply egress must not execute any action");
      },
    });
    const required = {
      viewId: "calendar",
      clientId: "origin-client",
      installationId: "install-1",
    };
    const navigation = {
      effect: "view_navigation",
      status: "prepared",
      viewId: "calendar",
      path: "/calendar",
      label: "Calendar",
      handoffId: HANDOFF,
      stepId: null,
    };
    const prepared = {
      success: true,
      transcriptVisibility: "internal" as const,
      modelReplyRequired: true,
      data: {
        actionName: "VIEWS_SHOW",
        view: {
          id: "calendar",
          label: "Calendar",
          installationId: "install-1",
        },
        navigation,
        awaitingDeviceExecution: true,
        values: {
          mode: "show",
          viewId: "calendar",
          viewPath: "/calendar",
          completedActionHandoffId: HANDOFF,
          navigationPrepared: true,
          navigationBinding: {
            requestId: HANDOFF,
            viewId: "calendar",
            viewType: "gui",
            clientId: "origin-client",
            installationId: "install-1",
          },
        },
      },
    };
    const read = {
      success: true,
      transcriptVisibility: "internal" as const,
      modelReplyRequired: true,
      data: {
        actionName: "CALENDAR_FEED",
        events: [{ title: "Camera rehearsal" }],
      },
      effectReceipts: [
        normalizeEffectReceipt({
          receiptId: "calendar-agenda-read",
          operation: "calendar.feed.read",
          resource: { kind: "calendar.feed", id: "snapshot", version: "v1" },
          artifacts: [],
          idempotency: { key: null, replayed: false },
          observedAt: "2026-11-19T08:53:21.703Z",
          outcome: "noop",
          reason: "Observed without changes.",
        }),
      ],
    };
    const trajectory: PlannerTrajectory = {
      context: { events: [], metadata: { requiredViewNavigation: required } },
      outcomeIntents: ["Open Calendar", "Read tomorrow’s agenda"],
      steps: [
        {
          iteration: 1,
          toolCall: { name: "VIEWS_SHOW", params: { view: "calendar" } },
          result: prepared,
        },
        { iteration: 2, toolCall: { name: "CALENDAR_FEED" }, result: read },
      ],
      archivedSteps: [],
      evaluatorOutputs: [],
      plannedQueue: [],
    };
    const input = {
      runtime: f.runtime,
      message: f.message,
      reply: rejectedReply,
      actionResults: [prepared, read],
      trajectory,
      providers: {
        VIEW_NAVIGATION: {
          data: {
            currentViewId: "chat",
            views: [
              { id: "calendar", label: "Calendar" },
              { id: "inbox", label: "Inbox" },
            ],
          },
        },
      },
    };
    return {
      input,
      trajectory,
      required,
      prepared,
      read,
      renderPrompts: f.renderPrompts,
    };
  }

  it("changes the false Calendar opening and keeps the agenda answer without another model call", async () => {
    const f = calendarReply();
    await expect(resolvePlannedReplyEgress(f.input)).resolves.toEqual({
      text: fixedReply,
      effectReceiptIds: [],
    });
    expect(f.renderPrompts).toHaveLength(0);
    expect(f.prepared.data.navigation.status).toBe("prepared");
  });

  it.each([
    [
      "wrong view in the reply",
      (f: ReturnType<typeof calendarReply>) => {
        f.input.reply = `Inbox is open. ${readReply}`;
      },
    ],
    [
      "wrong renderer binding",
      (f: ReturnType<typeof calendarReply>) => {
        f.required.clientId = "another-client";
      },
    ],
    [
      "no prepare receipt",
      (f: ReturnType<typeof calendarReply>) => {
        f.trajectory.steps.shift();
      },
    ],
    [
      "no unconditional navigation obligation",
      (f: ReturnType<typeof calendarReply>) => {
        delete f.trajectory.context.metadata?.requiredViewNavigation;
      },
    ],
    [
      "unproved read",
      (f: ReturnType<typeof calendarReply>) => {
        f.read.effectReceipts = [];
      },
    ],
    [
      "unsupported mutation in the remainder",
      (f: ReturnType<typeof calendarReply>) => {
        f.input.reply = "Calendar is open. I deleted your event.";
      },
    ],
    [
      "another premature claim in the remainder",
      (f: ReturnType<typeof calendarReply>) => {
        f.input.reply = `Calendar is open. Inbox is open. ${readReply}`;
      },
    ],
    [
      "navigation only",
      (f: ReturnType<typeof calendarReply>) => {
        f.input.reply = "Calendar is open.";
      },
    ],
  ] as const)("keeps ordinary recovery for %s", async (_reason, mutate) => {
    const f = calendarReply();
    mutate(f);
    await expect(resolvePlannedReplyEgress(f.input)).resolves.toEqual({
      text: REPLY,
      effectReceiptIds: [],
    });
    expect(f.renderPrompts).toHaveLength(1);
  });
});
