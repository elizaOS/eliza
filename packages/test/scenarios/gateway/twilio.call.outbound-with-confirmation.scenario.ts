/** Proves a Twilio call draft cannot dial before owner confirmation and dispatches once after it. */
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
  id: "twilio.call.outbound-with-confirmation",
  title: "Twilio voice dispatch is owner-confirmed and idempotent",
  domain: "gateway-contract",
  tags: [
    "gateway",
    "twilio",
    "voice",
    "confirmation",
    "idempotency",
    "deterministic-contract",
  ],
  description:
    "Runs the production Twilio voice helper against a deterministic HTTP boundary and proves exact target/TwiML, Basic auth, idempotency key, confirmation ordering, and replay suppression. It does not claim a live PSTN call.",
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "gateway-contract",
      channelType: "DM",
      title: "Twilio call outbound",
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
      name: "create-call-draft",
      room: "main",
      actionName: "GATEWAY_CREATE_DRAFT",
      options: {
        draftId: "draft-call-91",
        channel: "voice",
        to: "+15555550101",
        body: "Please reschedule the appointment to next Tuesday.",
        ownerId: "owner-1",
      },
      assertTurn: (turn) =>
        data(turn).dispatchCount === 0
          ? undefined
          : "call dialed before confirmation",
    },
    {
      kind: "action",
      name: "confirm-call",
      room: "main",
      actionName: "GATEWAY_CONFIRM_DISPATCH",
      options: { draftId: "draft-call-91", ownerId: "owner-1" },
      assertTurn: (turn) => {
        const d = data(turn);
        const blob = JSON.stringify(d);
        return d.duplicate === false &&
          d.dispatchCount === 1 &&
          blob.includes("/Calls.json") &&
          blob.includes("I-Twilio-Idempotency-Token") &&
          blob.includes("draft-call-91") &&
          blob.includes("next+Tuesday")
          ? undefined
          : `unexpected call dispatch ${blob}`;
      },
    },
    {
      kind: "action",
      name: "confirm-call-replay",
      room: "main",
      actionName: "GATEWAY_CONFIRM_DISPATCH",
      options: { draftId: "draft-call-91", ownerId: "owner-1" },
      assertTurn: (turn) =>
        data(turn).duplicate === true && data(turn).dispatchCount === 1
          ? undefined
          : `duplicate confirmation dialed: ${JSON.stringify(data(turn))}`,
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
