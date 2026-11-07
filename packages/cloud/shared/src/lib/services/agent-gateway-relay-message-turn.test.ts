/**
 * A local runtime's message turn that takes longer than 30 s still reaches the
 * sender through the cloud relay. Real relay service and in-memory store; the
 * local runtime is played by a poll/respond loop like the desktop relay's.
 */
import { afterEach, expect, test } from "bun:test";
import { agentGatewayRelayService } from "./agent-gateway-relay";

afterEach(() => {
  agentGatewayRelayService.resetForTests(null);
});

test("a message turn answered after 31 seconds is delivered, not timed out", async () => {
  agentGatewayRelayService.resetForTests();
  const session = await agentGatewayRelayService.registerSession({
    organizationId: "00000000-0000-0000-0000-00000000e001",
    userId: "00000000-0000-0000-0000-00000000e002",
    runtimeAgentId: "00000000-0000-0000-0000-00000000e003",
  });

  // The local runtime takes the request, works on the turn for 31 s without
  // polling (it handles one request at a time), then answers.
  const runtime = (async () => {
    const request = await agentGatewayRelayService.pollNextRequest(session.id, 5_000);
    if (!request) throw new Error("the relay never delivered the request");
    await new Promise((resolve) => setTimeout(resolve, 31_000));
    await agentGatewayRelayService.respondToRequest({
      sessionId: session.id,
      requestId: request.requestId,
      response: {
        jsonrpc: "2.0",
        id: request.rpc.id,
        result: { text: "Here is the report you asked for." },
      },
    });
  })();

  const response = await agentGatewayRelayService.routeToSession(session, {
    jsonrpc: "2.0",
    id: "turn-1",
    method: "message.send",
    params: { text: "Write me the report." },
  });
  await runtime;

  expect(response.error).toBeUndefined();
  expect(response.result).toEqual({ text: "Here is the report you asked for." });
}, 90_000);
