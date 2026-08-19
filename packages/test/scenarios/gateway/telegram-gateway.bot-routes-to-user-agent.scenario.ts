/** Proves signed Telegram normalization, tenant ownership, and replay deduplication. */
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
  id: "telegram-gateway.bot-routes-to-user-agent",
  title: "Telegram signed ingress routes once to its owning tenant",
  domain: "gateway-contract",
  tags: ["gateway", "telegram", "auth", "dedupe", "deterministic-contract"],
  description:
    "Exercises the production Telegram adapter's secret verification and event normalization, then proves project-scoped ownership and replay suppression. It does not claim Telegram delivery.",
  isolation: "per-scenario",
  requires: { plugins: ["gateway-deterministic-contract"] },
  rooms: [
    {
      id: "main",
      source: "gateway-contract",
      channelType: "DM",
      title: "Telegram ingress contract",
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
      name: "reject-missing-signature",
      room: "main",
      actionName: "GATEWAY_HTTP_INGRESS_CONTRACT",
      options: {
        platform: "telegram",
        project: "project-owner-a",
        variant: "missing-signature",
      },
      assertTurn: (turn) =>
        data(turn).status === 401 && data(turn).effectCount === 0
          ? undefined
          : `missing signature crossed ingress: ${JSON.stringify(data(turn))}`,
    },
    {
      kind: "action",
      name: "accept-signed-update",
      room: "main",
      actionName: "GATEWAY_HTTP_INGRESS_CONTRACT",
      options: {
        platform: "telegram",
        project: "project-owner-a",
        variant: "valid",
      },
      assertTurn: (turn) =>
        data(turn).status === 200 &&
        data(turn).effectCount === 1 &&
        Number(data(turn).providerEgressCount) >= 1
          ? undefined
          : `signed update did not route: ${JSON.stringify(data(turn))}`,
    },
    {
      kind: "action",
      name: "dedupe-provider-retry",
      room: "main",
      actionName: "GATEWAY_HTTP_INGRESS_CONTRACT",
      options: {
        platform: "telegram",
        project: "project-owner-a",
        variant: "replay",
      },
      assertTurn: (turn) =>
        data(turn).status === 200 &&
        data(turn).effectCount === 0 &&
        data(turn).providerEgressCount === 0 &&
        data(turn).totalEffects === 1
          ? undefined
          : `replay was not suppressed: ${JSON.stringify(data(turn))}`,
    },
    {
      kind: "action",
      name: "isolate-cross-tenant-message-id",
      room: "main",
      actionName: "GATEWAY_HTTP_INGRESS_CONTRACT",
      options: {
        platform: "telegram",
        project: "project-owner-b",
        variant: "cross-tenant",
      },
      assertTurn: (turn) =>
        data(turn).status === 200 &&
        data(turn).effectCount === 1 &&
        Number(data(turn).providerEgressCount) >= 1 &&
        data(turn).totalEffects === 2
          ? undefined
          : `cross-tenant delivery collided: ${JSON.stringify(data(turn))}`,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly-one-owned-dispatch",
      predicate: () =>
        harness.dispatches.length === 2
          ? undefined
          : `unexpected dispatch ledger ${JSON.stringify(harness.dispatches)}`,
    },
  ],
});
