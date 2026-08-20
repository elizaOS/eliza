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

function assertExactCallDispatch(
  value: Record<string, unknown>,
): string | undefined {
  const receipt = value.receipt as Record<string, unknown> | undefined;
  const request = receipt?.request as
    | { url?: unknown; init?: Record<string, unknown> }
    | undefined;
  const headers = request?.init?.headers as Record<string, unknown> | undefined;
  const result = receipt?.result as Record<string, unknown> | undefined;
  const draft = value.draft as Record<string, unknown> | undefined;
  const url = typeof request?.url === "string" ? new URL(request.url) : null;
  const body =
    typeof request?.init?.body === "string"
      ? new URLSearchParams(request.init.body)
      : null;
  const headerEntries = headers ? Object.entries(headers).sort() : [];
  const expectedAuthorization = `Basic ${Buffer.from(
    "AC_scenario:scenario_auth_token",
  ).toString("base64")}`;

  const exact =
    value.duplicate === false &&
    value.dispatchCount === 1 &&
    draft?.draftId === "draft-call-91" &&
    draft.channel === "voice" &&
    draft.to === "+15555550101" &&
    draft.body === "Please reschedule the appointment to next Tuesday." &&
    draft.ownerId === "owner-1" &&
    draft.status === "sent" &&
    receipt?.channel === "voice" &&
    receipt.ownerId === "owner-1" &&
    receipt.draftId === "draft-call-91" &&
    url?.pathname === "/2010-04-01/Accounts/AC_scenario/Calls.json" &&
    request?.init?.method === "POST" &&
    JSON.stringify(headerEntries) ===
      JSON.stringify([
        ["Authorization", expectedAuthorization],
        ["Content-Type", "application/x-www-form-urlencoded"],
      ]) &&
    body?.size === 3 &&
    body.get("To") === "+15555550101" &&
    body.get("From") === "+15555550000" &&
    body.get("Twiml") ===
      "<Response><Say>Please reschedule the appointment to next Tuesday.</Say></Response>" &&
    result?.ok === true &&
    result.status === 201 &&
    result.sid === "CA_scenario" &&
    result.retryCount === 0;

  return exact
    ? undefined
    : `unexpected call dispatch ${JSON.stringify(value)}`;
}

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
    "Runs the production Twilio voice helper against a deterministic HTTP boundary and proves exact target/TwiML, Basic auth, application-level confirmation ordering, and replay suppression. It does not claim a live PSTN call.",
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
      assertTurn: (turn) => assertExactCallDispatch(data(turn)),
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
