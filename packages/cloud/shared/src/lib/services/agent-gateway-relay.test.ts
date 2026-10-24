/**
 * Only the local runtime keeps its relay session alive (register, poll,
 * respond). Routing an inbound message to a session must not refresh it: a
 * runtime that died would otherwise look online for as long as traffic
 * arrives, and every message would wait the full response timeout.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type {
  AgentGatewayRelayRequestEnvelope,
  AgentGatewayRelaySession,
} from "./agent-gateway-relay";
import type { BridgeResponse } from "./eliza-sandbox";

type RelayModule = typeof import("./agent-gateway-relay");
let relay: RelayModule["agentGatewayRelayService"];

/** Like the Redis store: a session read returns whatever was last written; nothing prunes on read. */
function redisLikeStore() {
  const sessions = new Map<string, AgentGatewayRelaySession>();
  const owners = new Map<string, Set<string>>();
  const queues = new Map<string, AgentGatewayRelayRequestEnvelope[]>();
  const responses = new Map<string, BridgeResponse>();
  return {
    async getSession(id: string) {
      return sessions.get(id) ?? null;
    },
    async setSession(session: AgentGatewayRelaySession) {
      sessions.set(session.id, session);
    },
    async deleteSession(id: string) {
      sessions.delete(id);
      queues.delete(id);
    },
    async addOwnerSession(ownerKey: string, id: string) {
      (owners.get(ownerKey) ?? owners.set(ownerKey, new Set()).get(ownerKey))?.add(id);
    },
    async removeOwnerSession(ownerKey: string, id: string) {
      owners.get(ownerKey)?.delete(id);
    },
    async listOwnerSessionIds(ownerKey: string) {
      return [...(owners.get(ownerKey) ?? [])];
    },
    async enqueueRequest(id: string, request: AgentGatewayRelayRequestEnvelope) {
      (queues.get(id) ?? queues.set(id, []).get(id))?.push(request);
    },
    async dequeueRequest(id: string) {
      return queues.get(id)?.shift() ?? null;
    },
    async setResponse(requestId: string, response: BridgeResponse) {
      responses.set(requestId, response);
    },
    async getResponse(requestId: string) {
      return responses.get(requestId) ?? null;
    },
    async deleteResponse(requestId: string) {
      responses.delete(requestId);
    },
  };
}

const rpc = { jsonrpc: "2.0" as const, id: "rpc-1", method: "message.send", params: {} };
const store = redisLikeStore();

beforeAll(async () => {
  ({ agentGatewayRelayService: relay } = await import("./agent-gateway-relay"));
  relay.resetForTests(store);
});

afterAll(() => {
  relay.resetForTests();
});

test("routing to a runtime that stopped polling reports it offline instead of reviving it", async () => {
  const session = await relay.registerSession({
    organizationId: "org-1",
    userId: "user-1",
    runtimeAgentId: "agent-1",
  });
  // The runtime's last poll was two minutes ago; nothing has refreshed it since.
  await store.setSession({
    ...session,
    lastSeenAt: new Date(Date.now() - 120_000).toISOString(),
  });

  const started = Date.now();
  const response = await relay.routeToSession(session, rpc, 2_000);

  expect(response.error?.message).toBe("Local runtime session is offline");
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(await relay.listOwnerSessions("org-1", "user-1")).toEqual([]);
  expect(await store.getSession(session.id)).toBeNull();
});

test("a runtime that polls keeps its session alive and receives the routed request", async () => {
  const session = await relay.registerSession({
    organizationId: "org-2",
    userId: "user-2",
    runtimeAgentId: "agent-2",
  });
  await store.setSession({
    ...session,
    lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
  });

  const runtime = (async () => {
    const request = await relay.pollNextRequest(session.id, 2_000);
    if (!request) throw new Error("no request polled");
    await relay.respondToRequest({
      sessionId: session.id,
      requestId: request.requestId,
      response: { jsonrpc: "2.0", id: request.rpc.id, result: { ok: true } },
    });
  })();
  const response = await relay.routeToSession(session, rpc, 2_000);
  await runtime;

  expect(response.result).toEqual({ ok: true });
  const refreshed = await store.getSession(session.id);
  expect(Date.parse(refreshed?.lastSeenAt ?? "")).toBeGreaterThan(Date.now() - 5_000);
});
