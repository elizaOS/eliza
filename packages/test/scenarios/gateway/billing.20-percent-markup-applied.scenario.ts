/** Proves the production gateway's segment-based Twilio SMS markup calculation. */
import type { AgentRuntime } from "@elizaos/core";
import {
  type ScenarioTurnExecution,
  scenario,
} from "@elizaos/scenario-runner/schema";
import { createGatewayContractHarness } from "./_fixtures/gateway-contract-plugin.ts";

const harness = createGatewayContractHarness();
const longBody = "A".repeat(500);
export default scenario({
  lane: "pr-deterministic",
  executionProfile: "simulated",
  evidenceScope: "domain-contract",
  id: "billing.20-percent-markup-applied",
  title: "Gateway Twilio SMS billing applies exact 20 percent markup",
  domain: "gateway-contract",
  tags: ["gateway", "billing", "twilio", "deterministic-contract"],
  description:
    "Calls the production gateway billing function and checks exact segment, raw-cost, markup, and billed-cost arithmetic. It does not claim a provider charge.",
  isolation: "per-scenario",
  requires: { plugins: ["gateway-deterministic-contract"] },
  rooms: [
    {
      id: "main",
      source: "gateway-contract",
      channelType: "DM",
      title: "Gateway billing",
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
      name: "calculate-multisegment-billing",
      room: "main",
      actionName: "TWILIO_BILLING_CONTRACT",
      options: { body: longBody, costPerSegment: 0.25 },
      assertTurn: (turn: ScenarioTurnExecution) => {
        const billing = (
          turn.responseBody as {
            data?: {
              billing?: {
                segments?: number;
                rawCost?: number;
                markup?: number;
                billedCost?: number;
                markupRate?: number;
                costPerSegment?: number;
              };
            };
          }
        )?.data?.billing;
        return billing?.segments === 4 &&
          billing.costPerSegment === 0.25 &&
          billing.rawCost === 1 &&
          billing.markup === 0.2 &&
          billing.billedCost === 1.2 &&
          billing.markupRate === 0.2
          ? undefined
          : `unexpected billing ${JSON.stringify(billing)}`;
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "billing-has-no-provider-effect",
      predicate: () =>
        harness.dispatches.length === 0
          ? undefined
          : `billing unexpectedly dispatched ${harness.dispatches.length} request(s)`,
    },
  ],
});
