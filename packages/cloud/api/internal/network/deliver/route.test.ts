/**
 * The Network service's signed outbound sends: signature, validation, gateway
 * delivery and the history append. Integration against a real HTTP gateway
 * stand-in; the user lookup and the Durable Object append are stubbed.
 */

import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { svcSign } from "@thenetwork/plugin-network/svc-auth";

const SECRET = "deliver-route-secret-0123456789abcdef";
const users: Record<string, { id: string; organization_id: string }> = {
  "+14155550801": { id: "u-801", organization_id: "o-801" },
};
const appended: Array<{ agentId: string; turn: { id: string; content: string } }> = [];

const usersActual = await import("@/db/repositories/users");
mock.module("@/db/repositories/users", () => ({
  ...usersActual,
  usersRepository: {
    findByPhoneNumberWithOrganization: async (phone: string) => users[phone],
  },
}));
const coordinatorActual = await import("@/lib/services/shared-runtime/conversation-coordinator");
mock.module("@/lib/services/shared-runtime/conversation-coordinator", () => ({
  ...coordinatorActual,
  coordinateSharedProjectProactiveTurn: async (agentId: string, turn: { id: string; content: string }) => {
    appended.push({ agentId, turn });
  },
}));
const { default: route } = await import("./route");

let gateway: ReturnType<typeof Bun.serve>;
const delivered: Array<Record<string, unknown>> = [];
let gatewayReply: (body: Record<string, unknown>) => Response = () =>
  Response.json({ success: true, providerMessageIds: ["msg_out"], acceptedAt: "2026-10-08T12:00:00.000Z" });

beforeAll(() => {
  gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      if (req.headers.get("X-Internal-Secret") !== "gw-secret") return new Response("no", { status: 401 });
      const body = (await req.json()) as Record<string, unknown>;
      delivered.push(body);
      return gatewayReply(body);
    },
  });
});
afterAll(() => gateway.stop(true));
beforeEach(() => {
  delivered.length = 0;
  appended.length = 0;
});

async function post(payload: Record<string, unknown>, o: { secret?: string; id?: string } = {}) {
  const body = JSON.stringify(payload);
  const headers = await svcSign(o.secret ?? SECRET, { method: "POST", path: "/", id: o.id ?? String(payload.id), body });
  const res = await route.request(
    "/",
    { method: "POST", headers: { "content-type": "application/json", ...headers }, body },
    {
      SERVICE_TURN_SECRET: SECRET,
      GATEWAY_INTERNAL_SECRET: "gw-secret",
      ELIZA_APP_WEBHOOK_GATEWAY_URL: gateway.url.origin,
      SHARED_RUNTIME_CONVERSATIONS: {},
    },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const intro = { id: "intro-1", to: "+14155550801", text: "Grace climbs too. Want an intro?", app: "ntwrk", memberId: "ntwrk_1", kind: "proactive" };

test("a signed send is delivered through the gateway and appended to the member's history", async () => {
  expect(await post(intro)).toEqual({
    status: 200,
    body: { ok: true, replayed: false, providerMessageIds: ["msg_out"], history: true },
  });
  expect(delivered).toEqual([
    { platform: "blooio", project: "network", phoneNumber: "+14155550801", text: intro.text, idempotencyKey: "network:svc:intro-1" },
  ]);
  expect(appended).toHaveLength(1);
  expect(appended[0]?.turn).toMatchObject({ id: "network-proactive:network:svc:intro-1", content: intro.text });
});

test("a member with no Eliza account yet is sent to, without a history append", async () => {
  const r = await post({ ...intro, id: "intro-2", to: "+14155550899" });
  expect(r.body).toMatchObject({ ok: true, history: false });
  expect(delivered).toHaveLength(1);
  expect(appended).toEqual([]);
});

test("an opted-out recipient is reported, nothing is appended", async () => {
  gatewayReply = () => Response.json({ success: false, code: "recipient_opted_out", acceptance: "not_accepted" }, { status: 422 });
  const r = await post({ ...intro, id: "intro-3" });
  expect(r).toEqual({ status: 422, body: { ok: false, error: "opted_out", retryable: false } });
  expect(appended).toEqual([]);
  gatewayReply = () => Response.json({ success: true, providerMessageIds: ["msg_out"] });
});

test("bad signatures, a mismatched id and malformed sends are refused before any delivery", async () => {
  expect((await post(intro, { secret: "another-secret-0123456789abcdefXYZ" })).status).toBe(401);
  expect((await post(intro, { id: "other-id" })).status).toBe(400);
  expect((await post({ ...intro, to: "4155550801" })).status).toBe(400);
  expect((await post({ ...intro, app: "eliza" })).status).toBe(400);
  expect((await post({ ...intro, kind: "spam" })).status).toBe(400);
  expect(delivered).toEqual([]);
});
