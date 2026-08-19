/** Proves Twilio voice call direction mapping and bounded realtime TwiML generation. */
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
  id: "twilio.call.receive",
  title: "Twilio inbound voice maps caller and produces scoped realtime TwiML",
  domain: "gateway-contract",
  tags: ["gateway", "twilio", "voice", "twiml", "deterministic-contract"],
  description:
    "Exercises production voice direction and TwiML helpers at the authenticated route's domain seam. It does not place or receive a live PSTN call.",
  isolation: "per-scenario",
  requires: { plugins: ["gateway-deterministic-contract"] },
  rooms: [
    {
      id: "main",
      source: "gateway-contract",
      channelType: "DM",
      title: "Twilio voice ingress",
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
      name: "reject-invalid-voice-signature",
      room: "main",
      actionName: "TWILIO_VOICE_INGRESS_CONTRACT",
      options: {
        callSid: "CA_invalid_91",
        direction: "inbound",
        from: "+15551112222",
        to: "+15555550000",
        variant: "invalid-signature",
      },
      assertTurn: (turn: ScenarioTurnExecution) =>
        (turn.responseBody as { data?: { status?: number } })?.data?.status ===
        403
          ? undefined
          : `invalid voice signature was not rejected: ${JSON.stringify(turn.responseBody)}`,
    },
    {
      kind: "action",
      name: "reject-wrong-voice-account",
      room: "main",
      actionName: "TWILIO_VOICE_INGRESS_CONTRACT",
      options: {
        callSid: "CA_wrong_91",
        direction: "inbound",
        from: "+15551112222",
        to: "+15555550000",
        variant: "wrong-account",
      },
      assertTurn: (turn: ScenarioTurnExecution) =>
        (turn.responseBody as { data?: { status?: number } })?.data?.status ===
        403
          ? undefined
          : `wrong voice account was not rejected: ${JSON.stringify(turn.responseBody)}`,
    },
    {
      kind: "action",
      name: "map-inbound-call",
      room: "main",
      actionName: "TWILIO_VOICE_INGRESS_CONTRACT",
      options: {
        callSid: "CA_inbound_91",
        direction: "inbound",
        from: "+15551112222",
        to: "+15555550000",
        variant: "valid",
      },
      assertTurn: (turn: ScenarioTurnExecution) => {
        const d = (
          turn.responseBody as {
            data?: {
              status?: number;
              ingressBody?: string;
              participants?: {
                callerNumber?: string;
                publicLineNumber?: string;
                outbound?: boolean;
              };
              twiml?: string;
              persistedCall?: { callSid?: string };
            };
          }
        )?.data;
        return d?.status === 200 &&
          d.ingressBody?.includes("not configured") &&
          d.participants?.callerNumber === "+15551112222" &&
          d.participants.publicLineNumber === "+15555550000" &&
          d.participants.outbound === false &&
          d.persistedCall?.callSid === "CA_inbound_91" &&
          d.twiml?.includes("voice-session-91") &&
          d.twiml.includes("scoped-media-token")
          ? undefined
          : `unexpected voice mapping ${JSON.stringify(d)}`;
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "one-call-record-effect",
      predicate: () =>
        harness.dispatches.length === 1
          ? undefined
          : `expected one call effect, saw ${harness.dispatches.length}`,
    },
  ],
});
