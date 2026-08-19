/** Proves WhatsApp HMAC verification, normalized sender ownership, and replay deduplication. */
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
  id: "whatsapp-gateway.bot-routes-to-user-agent",
  title: "WhatsApp signed ingress routes once to its owning tenant",
  domain: "gateway-contract",
  tags: ["gateway", "whatsapp", "auth", "dedupe", "deterministic-contract"],
  description:
    "Exercises the production WhatsApp adapter's HMAC verification and payload normalization, then proves project-scoped ownership and replay suppression. It does not claim Meta delivery.",
  isolation: "per-scenario",
  requires: { plugins: ["gateway-deterministic-contract"] },
  rooms: [
    {
      id: "main",
      source: "gateway-contract",
      channelType: "DM",
      title: "WhatsApp ingress contract",
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
      name: "reject-invalid-signature",
      room: "main",
      actionName: "GATEWAY_HTTP_INGRESS_CONTRACT",
      options: {
        platform: "whatsapp",
        project: "project-owner-b",
        variant: "invalid-signature",
      },
      assertTurn: (turn) =>
        data(turn).status === 401 && data(turn).effectCount === 0
          ? undefined
          : `invalid signature crossed ingress: ${JSON.stringify(data(turn))}`,
    },
    {
      kind: "action",
      name: "reject-wrong-phone-account",
      room: "main",
      actionName: "GATEWAY_HTTP_INGRESS_CONTRACT",
      options: {
        platform: "whatsapp",
        project: "project-owner-b",
        variant: "wrong-account",
      },
      assertTurn: (turn) =>
        data(turn).status === 401 && data(turn).effectCount === 0
          ? undefined
          : `wrong account crossed ingress: ${JSON.stringify(data(turn))}`,
    },
    {
      kind: "action",
      name: "accept-signed-message",
      room: "main",
      actionName: "GATEWAY_HTTP_INGRESS_CONTRACT",
      options: {
        platform: "whatsapp",
        project: "project-owner-b",
        variant: "valid",
      },
      assertTurn: (turn) =>
        data(turn).status === 200 &&
        data(turn).effectCount === 1 &&
        Number(data(turn).providerEgressCount) >= 1
          ? undefined
          : `valid WhatsApp route failed: ${JSON.stringify(data(turn))}`,
    },
    {
      kind: "action",
      name: "dedupe-meta-retry",
      room: "main",
      actionName: "GATEWAY_HTTP_INGRESS_CONTRACT",
      options: {
        platform: "whatsapp",
        project: "project-owner-b",
        variant: "replay",
      },
      assertTurn: (turn) =>
        data(turn).status === 200 &&
        data(turn).effectCount === 0 &&
        data(turn).providerEgressCount === 0 &&
        data(turn).totalEffects === 1
          ? undefined
          : `unexpected replay ${JSON.stringify(data(turn))}`,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly-one-owned-dispatch",
      predicate: () =>
        harness.dispatches.length === 1
          ? undefined
          : `expected one dispatch, saw ${harness.dispatches.length}`,
    },
  ],
});
