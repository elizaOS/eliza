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

function assertExactSmsDispatch(
  value: Record<string, unknown>,
): string | undefined {
  const receipt = value.receipt as Record<string, unknown> | undefined;
  const request = receipt?.request as
    | { url?: unknown; init?: Record<string, unknown> }
    | undefined;
  const headers = request?.init?.headers as Record<string, unknown> | undefined;
  const result = receipt?.result as Record<string, unknown> | undefined;
  const billing = result?.billing as Record<string, unknown> | undefined;
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
    draft?.draftId === "draft-sms-91" &&
    draft.channel === "sms" &&
    draft.to === "+15551112222" &&
    draft.body === "Running 10 minutes late." &&
    draft.ownerId === "owner-1" &&
    draft.status === "sent" &&
    receipt?.channel === "sms" &&
    receipt.ownerId === "owner-1" &&
    receipt.draftId === "draft-sms-91" &&
    url?.pathname === "/2010-04-01/Accounts/AC_scenario/Messages.json" &&
    request?.init?.method === "POST" &&
    JSON.stringify(headerEntries) ===
      JSON.stringify([
        ["Authorization", expectedAuthorization],
        ["Content-Type", "application/x-www-form-urlencoded"],
      ]) &&
    body?.size === 3 &&
    body.get("To") === "+15551112222" &&
    body.get("From") === "+15555550000" &&
    body.get("Body") === "Running 10 minutes late." &&
    result?.ok === true &&
    result.status === 201 &&
    result.sid === "SM_scenario" &&
    result.retryCount === 0 &&
    billing?.segments === 1 &&
    billing.rawCost === 0.01 &&
    billing.markup === 0 &&
    billing.billedCost === 0.01 &&
    billing.markupRate === 0.2 &&
    billing.costPerSegment === 0.0075;

  return exact ? undefined : `unexpected SMS dispatch ${JSON.stringify(value)}`;
}

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
    "Runs the production Twilio SMS helper against a deterministic HTTP boundary and proves exact request, Basic auth, application-level confirmation ordering, and replay suppression. It does not claim provider delivery.",
  isolation: "per-scenario",
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
      assertTurn: (turn) => assertExactSmsDispatch(data(turn)),
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
