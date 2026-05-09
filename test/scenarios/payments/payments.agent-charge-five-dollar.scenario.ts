import type { AgentRuntime, Plugin } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { expectTurnToCallAction } from "../_helpers/action-assertions.ts";
import { expectScenarioActionResultData } from "../_helpers/action-result-assertions.ts";
import { appChargeTestPlugin } from "./_fixtures/app-charge-test-plugin.ts";

function asRuntime(value: unknown): AgentRuntime {
  if (!value || typeof value !== "object" || !("registerPlugin" in value)) {
    throw new Error(
      "payments scenario seed: runtime did not expose registerPlugin",
    );
  }
  return value as AgentRuntime;
}

function assertPaymentCallback(ctx: ScenarioContext): string | undefined {
  const confirmation = ctx.actionsCalled.find(
    (action) => action.actionName === "CHECK_PAYMENT",
  );
  const data = confirmation?.result?.data as
    | {
        amountUsd?: number;
        status?: string;
        callbackStatus?: string;
        callbackChannel?: { roomId?: string };
      }
    | undefined;

  if (!data) return "expected CHECK_PAYMENT to return structured payment data";
  if (data.amountUsd !== 5)
    return `expected $5 confirmed charge, saw ${String(data.amountUsd)}`;
  if (data.status !== "confirmed")
    return `expected confirmed payment status, saw ${data.status}`;
  if (data.callbackStatus !== "delivered") {
    return `expected successful channel callback, saw ${String(data.callbackStatus)}`;
  }
  if (data.callbackChannel?.roomId !== "room_payment_5") {
    return "expected callback to return to the initiating channel";
  }
}

export default scenario({
  id: "payments.agent-charge-five-dollar",
  title: "Agent creates and verifies a $5 app charge",
  domain: "payments",
  tags: ["payments", "app-charge", "stripe", "oxapay", "callback", "smoke"],
  description:
    "Registers app-charge test actions, asks the agent to create a $5 payment request, then verifies payment confirmation produces the initiating-channel callback payload.",

  requires: {
    plugins: ["app-charge-test"],
  },
  isolation: "per-scenario",

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Payment Request",
    },
  ],

  seed: [
    {
      type: "custom",
      name: "register-app-charge-test-plugin",
      apply: async (ctx) => {
        const runtime = asRuntime(ctx.runtime);
        await runtime.registerPlugin(appChargeTestPlugin satisfies Plugin);
        return undefined;
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "create-five-dollar-charge",
      room: "main",
      text: 'The agent should reply to this user request by creating a payment request: "sure but please send me $5". Create a Cloud app charge payment link that can be paid by card or crypto.',
      expectedActions: ["CREATE_APP_CHARGE"],
      timeoutMs: 120_000,
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CREATE_APP_CHARGE"],
        description: "$5 app charge request",
        includesAll: ["5", "stripe", "oxapay", "/payment/app-charge/"],
      }),
      responseIncludesAny: ["$5", "payment", "charge"],
    },
    {
      kind: "message",
      name: "verify-paid-charge",
      room: "main",
      text: "The user paid it. Check whether the payment went through and report back to this same channel before doing any paid work.",
      expectedActions: ["CHECK_PAYMENT"],
      timeoutMs: 120_000,
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CHECK_PAYMENT"],
        description: "$5 charge confirmation",
        includesAll: ["confirmed", "room_payment_5"],
      }),
      responseIncludesAny: ["paid", "confirmed", "went through"],
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: "CREATE_APP_CHARGE",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "CHECK_PAYMENT",
      status: "success",
      minCount: 1,
    },
    {
      type: "custom",
      name: "charge-result-has-payment-link",
      predicate: expectScenarioActionResultData({
        actionName: "CREATE_APP_CHARGE",
        description: "created charge payment link",
        includesAll: [
          "app_scenario_payments",
          "charge_scenario_five",
          "oxapay",
          "stripe",
        ],
      }),
    },
    {
      type: "custom",
      name: "payment-confirmation-callback",
      predicate: async (ctx) => assertPaymentCallback(ctx),
    },
  ],
});
