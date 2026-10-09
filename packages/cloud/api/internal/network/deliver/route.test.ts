/**
 * The Network service's signed outbound sends: signature, validation, gateway
 * delivery and the history append. Integration against a real HTTP gateway
 * stand-in; the user lookup and the Durable Object append are stubbed.
 */

import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { svcSign } from "@elizaos/plugin-network/svc-auth";

const SECRET = "deliver-route-secret-0123456789abcdef";
const users: Record<string, { id: string; organization_id: string }> = {
  "+14155550801": { id: "u-801", organization_id: "o-801" },
};

const usersActual = await import("@/db/repositories/users");
mock.module("@/db/repositories/users", () => ({
  ...usersActual,
  usersRepository: {
    findByPhoneNumberWithOrganization: async (phone: string) => users[phone],
  },
}));
const { default: route } = await import("./route");

let gateway: ReturnType<typeof Bun.serve>;
const delivered: Array<Record<string, unknown>> = [];
const gatewayReply: (body: Record<string, unknown>) => Response = () =>
  Response.json({
    success: true,
    providerMessageIds: ["msg_out"],
    acceptedAt: "2026-10-08T12:00:00.000Z",
  });

beforeAll(() => {
  gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      if (req.headers.get("X-Internal-Secret") !== "gw-secret")
        return new Response("no", { status: 401 });
      const body = (await req.json()) as Record<string, unknown>;
      delivered.push(body);
      return gatewayReply(body);
    },
  });
});
afterAll(() => gateway.stop(true));
beforeEach(() => {
  delivered.length = 0;
});

async function post(
  payload: Record<string, unknown>,
  o: { secret?: string; id?: string; continuity?: string } = {},
) {
  const body = JSON.stringify(payload);
  const headers = await svcSign(o.secret ?? SECRET, {
    method: "POST",
    path: "/",
    id: o.id ?? String(payload.id),
    body,
  });
  const res = await route.request(
    "/",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    },
    {
      NETWORK_PERSONAL_CONTINUITY_ENABLED: o.continuity ?? "true",
      SERVICE_TURN_SECRET: SECRET,
      GATEWAY_INTERNAL_SECRET: "gw-secret",
      ELIZA_APP_WEBHOOK_GATEWAY_URL: gateway.url.origin,
      SHARED_RUNTIME_CONVERSATIONS: {},
    },
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

const intro = {
  id: "intro-1",
  to: "+14155550801",
  text: "Grace climbs too. Want an intro?",
  app: "ntwrk",
  memberId: "ntwrk_1",
  kind: "proactive",
};

test("account-bound Network sends stay refused even with activation enabled", async () => {
  for (const kind of ["reply", "proactive", "relay"]) {
    expect(await post({ ...intro, kind })).toEqual({
      status: 503,
      body: { ok: false, error: "network_personal_delivery_unqualified" },
    });
  }
  expect(delivered).toEqual([]);
});

test("a member with no Eliza account yet is sent to, without a history append", async () => {
  const r = await post({
    ...intro,
    id: "intro-2",
    to: "+14155550899",
    kind: "reply",
  });
  expect(r.body).toMatchObject({ ok: true, history: false });
  expect(delivered).toHaveLength(1);
});

test("bad signatures, a mismatched id and malformed sends are refused before any delivery", async () => {
  expect(
    (await post(intro, { secret: "another-secret-0123456789abcdefXYZ" }))
      .status,
  ).toBe(401);
  expect((await post(intro, { id: "other-id" })).status).toBe(400);
  expect((await post({ ...intro, to: "4155550801" })).status).toBe(400);
  expect((await post({ ...intro, app: "eliza" })).status).toBe(400);
  expect((await post({ ...intro, kind: "spam" })).status).toBe(400);
  expect(delivered).toEqual([]);
});

test("activation and unknown-account proactive fences refuse before dispatch", async () => {
  expect((await post(intro, { continuity: "false" })).status).toBe(503);
  expect((await post({ ...intro, to: "+14155550899" })).status).toBe(422);
  expect(delivered).toEqual([]);
});
