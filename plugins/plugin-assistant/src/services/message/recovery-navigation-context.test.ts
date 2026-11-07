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
  stringToUuid,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, expect, it, vi } from "vitest";
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
