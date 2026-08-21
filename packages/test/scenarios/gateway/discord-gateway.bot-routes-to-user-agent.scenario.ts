/** Proves Discord's production managed-route retry seam returns a typed owner-bound reply. */
import type { AgentRuntime } from "@elizaos/core";
import {
  type ScenarioTurnExecution,
  scenario,
} from "@elizaos/scenario-runner/schema";
import { createGatewayContractHarness } from "./_fixtures/gateway-contract-plugin.ts";

const harness = createGatewayContractHarness();
export default scenario({
  lane: "pr-deterministic",
  executionProfile: "simulated",
  evidenceScope: "domain-contract",
  id: "discord-gateway.bot-routes-to-user-agent",
  title: "Discord managed ingress retries and preserves agent ownership",
  domain: "gateway-contract",
  tags: ["gateway", "discord", "ownership", "retry", "deterministic-contract"],
  description:
    "Runs the production Discord bounded-routing helper across a transient failure and typed success response. It does not claim Discord API delivery.",
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "gateway-contract",
      channelType: "DM",
      title: "Discord route contract",
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
      name: "route-with-bounded-retry",
      room: "main",
      actionName: "DISCORD_GATEWAY_ROUTE_CONTRACT",
      assertTurn: (turn: ScenarioTurnExecution) => {
        const d = (
          turn.responseBody as {
            data?: {
              outcome?: { ok?: boolean; attempts?: number };
              invalidIngressStatus?: number;
              validIngressStatus?: number;
              durableJobs?: number;
              owner?: string;
              channelId?: string;
            };
          }
        )?.data;
        return d?.invalidIngressStatus === 401 &&
          d.validIngressStatus === 204 &&
          d.durableJobs === 1 &&
          d.outcome?.ok === true &&
          d.outcome.attempts === 2 &&
          d.owner === "agent-owner-1" &&
          d.channelId === "discord-dm:444"
          ? undefined
          : `unexpected route result ${JSON.stringify(d)}`;
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "one-owner-bound-route",
      predicate: () =>
        harness.dispatches.length === 1
          ? undefined
          : `expected one route effect, saw ${harness.dispatches.length}`,
    },
  ],
});
