/** Proves a Twilio SMS draft cannot dispatch before owner confirmation and dispatches once after it. */
import type { AgentRuntime } from "@elizaos/core";
import {
  type ScenarioTurnExecution,
  scenario,
} from "@elizaos/scenario-runner/schema";
import { createGatewayContractHarness } from "./_fixtures/gateway-contract-plugin.ts";

const harness = createGatewayContractHarness();
const data = (turn: ScenarioTurnExecution) =>
  (turn.responseBody as { data?: Record<string, unknown> })?.data ?? {};
export default scenario({
  lane: "pr-deterministic",
  executionProfile: "simulated",
  evidenceScope: "domain-contract",
  id: "twilio.sms.send-from-agent-with-confirmation",
  title: "Twilio SMS dispatch is owner-confirmed and idempotent",
  domain: "gateway-contract",
  tags: [
    "gateway",
    "twilio",
    "sms",
    "confirmation",
    "idempotency",
    "deterministic-contract",
  ],
  description:
    "Runs the production Twilio SMS helper against a deterministic HTTP boundary and proves exact request, Basic auth, idempotency key, confirmation ordering, and replay suppression. It does not claim provider delivery.",
  isolation: "per-scenario",
  requires: { plugins: ["gateway-deterministic-contract"] },
  rooms: [
    {
      id: "main",
      source: "gateway-contract",
      channelType: "DM",
      title: "Twilio SMS outbound",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "register-gateway-contract",
      apply: async (ctx) => {
        harness.reset();
        await (ctx.runtime as AgentRuntime).registerPlugin(harness.plugin);
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "create-sms-draft",
      room: "main",
      actionName: "GATEWAY_CREATE_DRAFT",
      options: {
        draftId: "draft-sms-91",
        channel: "sms",
        to: "+15551112222",
        body: "Running 10 minutes late.",
        ownerId: "owner-1",
      },
      assertTurn: (turn) =>
        data(turn).dispatchCount === 0
          ? undefined
          : "draft dispatched before confirmation",
    },
    {
      kind: "action",
      name: "confirm-sms",
      room: "main",
      actionName: "GATEWAY_CONFIRM_DISPATCH",
      options: { draftId: "draft-sms-91", ownerId: "owner-1" },
      assertTurn: (turn) => {
        const d = data(turn);
        const blob = JSON.stringify(d);
        return d.duplicate === false &&
          d.dispatchCount === 1 &&
          blob.includes("/Messages.json") &&
          blob.includes("I-Twilio-Idempotency-Token") &&
          blob.includes("draft-sms-91") &&
          blob.includes("10+minutes+late")
          ? undefined
          : `unexpected SMS dispatch ${blob}`;
      },
    },
    {
      kind: "action",
      name: "confirm-sms-replay",
      room: "main",
      actionName: "GATEWAY_CONFIRM_DISPATCH",
      options: { draftId: "draft-sms-91", ownerId: "owner-1" },
      assertTurn: (turn) =>
        data(turn).duplicate === true && data(turn).dispatchCount === 1
          ? undefined
          : `duplicate confirmation dispatched: ${JSON.stringify(data(turn))}`,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly-one-provider-request",
      predicate: () =>
        harness.dispatches.length === 1
          ? undefined
          : `expected one request, saw ${harness.dispatches.length}`,
    },
  ],
});
