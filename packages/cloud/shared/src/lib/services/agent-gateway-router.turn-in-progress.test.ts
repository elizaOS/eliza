/**
 * When the sandbox is still running an inbound turn past the bridge deadline,
 * the gateway router must report the message as handled with an unknown
 * outcome. Reporting `bridge_failed` let the webhook routes run the same
 * message a second time on another runtime, or answer with canned text.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AgentGatewayRouterService } from "./agent-gateway-router";
import { elizaSandboxService } from "./eliza-sandbox";
import { BRIDGE_TURN_IN_PROGRESS_CODE } from "./eliza-sandbox/bridge/contracts";

type StagedBridgeResponse = {
  error?: { code: number; message: string };
  result?: { text: string };
};

function stageBridgeResponse(response: StagedBridgeResponse) {
  spyOn(elizaSandboxService, "bridge").mockResolvedValue({
    jsonrpc: "2.0",
    id: "turn-1",
    ...response,
  });
}

// A non-uuid agent id is never a cut-over personal Dedicated agent, so the
// traffic-access check answers without a database read.
const sandbox = {
  id: "gateway-test-agent",
  organization_id: "22222222-2222-4222-8222-222222222222",
};
const rpc = {
  jsonrpc: "2.0" as const,
  id: "turn-1",
  method: "message.send",
  params: { text: "plan my week", roomId: "room-1" },
};

function routeToTarget(service: InstanceType<typeof AgentGatewayRouterService>) {
  return (
    service as unknown as {
      routeToTarget(
        target: { kind: "sandbox"; sandbox: typeof sandbox },
        rpc: typeof rpc,
      ): Promise<unknown>;
    }
  ).routeToTarget({ kind: "sandbox", sandbox }, rpc);
}

describe("gateway router and a turn still running in the sandbox", () => {
  afterEach(() => {
    spyOn(elizaSandboxService, "bridge").mockRestore();
  });

  test("a turn past the bridge deadline is handled with an unknown outcome", async () => {
    stageBridgeResponse({
      error: { code: BRIDGE_TURN_IN_PROGRESS_CODE, message: "Sandbox turn still running" },
    });

    await expect(routeToTarget(new AgentGatewayRouterService())).resolves.toEqual({
      handled: true,
      outcome: "unknown",
      agentId: sandbox.id,
      organizationId: sandbox.organization_id,
      roomId: "room-1",
    });
  });

  test("an unreachable sandbox is still a bridge failure", async () => {
    stageBridgeResponse({
      error: { code: -32000, message: "Sandbox bridge is unreachable" },
    });

    await expect(routeToTarget(new AgentGatewayRouterService())).resolves.toMatchObject({
      handled: false,
      reason: "bridge_failed",
    });
  });
});
