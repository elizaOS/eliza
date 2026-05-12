import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { expectTurnToCallAction } from "../_helpers/action-assertions.ts";

function assertTwilioBillingResult(ctx: ScenarioContext): string | undefined {
  const action = ctx.turns?.[1]?.actionsCalled.find((entry) =>
    ["MESSAGE", "MESSAGE"].includes(entry.actionName),
  );
  if (!action?.result?.data || typeof action.result.data !== "object") {
    return "expected a Twilio send action with structured billing data";
  }

  const data = action.result.data as {
    result?: {
      billing?: {
        rawCost: number;
        markup: number;
        billedCost: number;
        markupRate: number;
        segments: number;
      };
    };
  };
  const billing = data.result?.billing;
  if (!billing) {
    return "expected Twilio SMS billing details in the send result";
  }
  if (billing.markupRate !== 0.2) {
    return `expected 20% markup, saw ${billing.markupRate}`;
  }
  if (billing.segments < 4) {
    return "expected a multi-segment Twilio SMS so the markup is visible";
  }
  if (billing.rawCost <= 0) {
    return "expected a positive raw SMS cost";
  }
  if (billing.billedCost <= billing.rawCost) {
    return "expected billed SMS cost to exceed raw cost";
  }
  const expectedMarkup = billing.billedCost - billing.rawCost;
  if (Math.abs(expectedMarkup - billing.markup) > 1e-6) {
    return "expected billedCost - rawCost to equal markup";
  }
}

export default scenario({
  id: "billing.20-percent-markup-applied",
  title: "Gateway SMS usage is billed with 20% markup",
  domain: "gateway",
  tags: ["gateway", "billing", "credentials-missing-edge"],
  description:
    "Agent drafts and sends a Twilio SMS with a structured billing breakdown that includes raw, markup, and billed amounts.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Billing 20 Percent Markup",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "send-sms-for-billing",
      room: "main",
      text: 'Draft a Twilio SMS to my coworker and hold it for approval. Exact SMS: "I checked the plan, the vendor push is complete, the updated deck is in the shared folder, the QA notes are attached, the launch checklist is green, the finance numbers have been reconciled, and we are still on track for the afternoon review as long as nobody adds new scope before noon or changes the agenda without telling me. Please reply in the thread if anything changes, because I need a clean handoff, a stable agenda, and no surprises before the meeting starts. I am intentionally keeping this note detailed so the Twilio SMS spans multiple segments, exercises the markup path, and leaves a clear audit trail for billing. Add that the backup approval path is the same as last week, the escalation contact is still Sam, the summary needs to include the delta from the morning notes, and the final send should happen only after we confirm the exact recipient and time window."',
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "twilio sms draft",
        includesAny: ["sms", "draft", "coworker", "approval"],
      }),
      responseIncludesAny: ["sms", "draft", "coworker", "approval"],
    },
    {
      kind: "message",
      name: "confirm-send",
      room: "main",
      text: "Yes, send that SMS exactly as drafted.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "twilio sms send confirmed",
        includesAny: ["sms", "send", "confirmed", "sent"],
      }),
      responseIncludesAny: ["sent", "sending", "SMS"],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "MESSAGE",
    },
    {
      type: "custom",
      name: "billing-markup-structured-result",
      predicate: async (ctx) => assertTwilioBillingResult(ctx),
    },
  ],
});
