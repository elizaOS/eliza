/** Proves BlueBubbles webhook authentication and message-guid deduplication. */
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
  id: "bluebubbles.imessage.receive",
  title: "BlueBubbles authenticates and deduplicates inbound iMessage identity",
  domain: "gateway-contract",
  tags: [
    "gateway",
    "bluebubbles",
    "imessage",
    "auth",
    "dedupe",
    "deterministic-contract",
  ],
  description:
    "Exercises the production constant-time BlueBubbles webhook-secret verifier and a stable chat/message identity ledger. It does not claim a live macOS BlueBubbles server.",
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "gateway-contract",
      channelType: "DM",
      title: "BlueBubbles ingress contract",
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
      name: "reject-wrong-secret",
      room: "main",
      actionName: "BLUEBUBBLES_INGRESS_CONTRACT",
      options: {
        secret: "correct-secret",
        provided: "wrong-secret",
        messageGuid: "msg-91",
        chatGuid: "iMessage;-;+15551112222",
      },
      assertTurn: (turn) =>
        data(turn).status === 401 &&
        data(turn).authorized === false &&
        data(turn).dispatchCount === 0
          ? undefined
          : `unauthorized webhook dispatched: ${JSON.stringify(data(turn))}`,
    },
    {
      kind: "action",
      name: "accept-authenticated-message",
      room: "main",
      actionName: "BLUEBUBBLES_INGRESS_CONTRACT",
      options: {
        secret: "correct-secret",
        provided: "correct-secret",
        messageGuid: "msg-91",
        chatGuid: "iMessage;-;+15551112222",
      },
      assertTurn: (turn) =>
        data(turn).status === 200 &&
        data(turn).acknowledged === true &&
        data(turn).authorized === true &&
        data(turn).duplicate === false &&
        data(turn).dispatchCount === 1
          ? undefined
          : `authenticated webhook failed: ${JSON.stringify(data(turn))}`,
    },
    {
      kind: "action",
      name: "dedupe-replay",
      room: "main",
      actionName: "BLUEBUBBLES_INGRESS_CONTRACT",
      options: {
        secret: "correct-secret",
        provided: "correct-secret",
        messageGuid: "msg-91",
        chatGuid: "iMessage;-;+15551112222",
      },
      assertTurn: (turn) =>
        data(turn).status === 200 &&
        data(turn).duplicate === true &&
        data(turn).dispatchCount === 1
          ? undefined
          : `replay was not deduplicated: ${JSON.stringify(data(turn))}`,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly-one-inbound-effect",
      predicate: () =>
        harness.dispatches.length === 1
          ? undefined
          : `expected one effect, saw ${harness.dispatches.length}`,
    },
  ],
});
