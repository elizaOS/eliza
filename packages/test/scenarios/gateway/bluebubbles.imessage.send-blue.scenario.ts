/** Proves an iMessage draft cannot dispatch before owner confirmation and dispatches once after it. */
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
  id: "bluebubbles.imessage.send-blue",
  title: "BlueBubbles iMessage dispatch is owner-confirmed and idempotent",
  domain: "gateway-contract",
  tags: [
    "gateway",
    "bluebubbles",
    "imessage",
    "confirmation",
    "idempotency",
    "deterministic-contract",
  ],
  description:
    "Runs the production BlueBubbles REST client against a deterministic HTTP boundary and proves exact target/body, credential-at-fetch, confirmation ordering, and replay suppression. It does not claim live iMessage delivery.",
  isolation: "per-scenario",
  requires: { plugins: ["gateway-deterministic-contract"] },
  rooms: [
    {
      id: "main",
      source: "gateway-contract",
      channelType: "DM",
      title: "BlueBubbles outbound",
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
      name: "create-draft",
      room: "main",
      actionName: "GATEWAY_CREATE_DRAFT",
      options: {
        draftId: "draft-bb-91",
        channel: "imessage",
        to: "iMessage;-;+15551112222",
        body: "I'll be there in 10 minutes.",
        ownerId: "owner-1",
      },
      assertTurn: (turn) =>
        data(turn).dispatchCount === 0
          ? undefined
          : "draft dispatched before confirmation",
    },
    {
      kind: "action",
      name: "confirm-once",
      room: "main",
      actionName: "GATEWAY_CONFIRM_DISPATCH",
      options: { draftId: "draft-bb-91", ownerId: "owner-1" },
      assertTurn: (turn) => {
        const d = data(turn);
        const blob = JSON.stringify(d);
        return d.duplicate === false &&
          d.dispatchCount === 1 &&
          blob.includes("/api/v1/message/text") &&
          blob.includes("password=secret") &&
          blob.includes("10 minutes")
          ? undefined
          : `unexpected BlueBubbles dispatch ${blob}`;
      },
    },
    {
      kind: "action",
      name: "confirm-replay",
      room: "main",
      actionName: "GATEWAY_CONFIRM_DISPATCH",
      options: { draftId: "draft-bb-91", ownerId: "owner-1" },
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
