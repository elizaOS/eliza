/** Signed route/coordinator contract; the canonical DO is exercised separately in Workerd. */
import { beforeEach, expect, mock, test } from "bun:test";
import { personalSharedAgentId } from "@elizaos/cloud-shared/lib/services/shared-runtime/personal-shared-identity";
import { svcSign } from "@elizaos/plugin-network/svc-auth";
import { Hono } from "hono";

const SECRET = "deliver-route-secret-0123456789abcdef";
const users: Record<string, { id: string; organization_id: string }> = {
  "+14155550801": { id: "u-801", organization_id: "o-801" },
};
const usersActual = await import("@elizaos/cloud-shared/db/repositories/users");
mock.module("@elizaos/cloud-shared/db/repositories/users", () => ({
  ...usersActual,
  usersRepository: {
    findByPhoneNumberWithOrganization: async (phone: string) => users[phone],
  },
}));
const { default: route } = await import("./route");
const { default: receiptRoute } = await import("./receipt/route");
const deliveryPath = "/api/internal/network/deliver";
const receiptPath = `${deliveryPath}/receipt`;
const app = new Hono()
  .route(deliveryPath, route)
  .route(receiptPath, receiptRoute);
const dispatches: Array<{ name: string; body: Record<string, unknown> }> = [];
let ownerResponse = () =>
  Response.json({
    ok: true,
    replayed: false,
    providerMessageIds: ["owned-receipt"],
    history: true,
  });
beforeEach(() => {
  dispatches.length = 0;
  ownerResponse = () =>
    Response.json({
      ok: true,
      replayed: false,
      providerMessageIds: ["owned-receipt"],
      history: true,
    });
});
async function post(
  payload: Record<string, unknown>,
  options: {
    secret?: string;
    id?: string;
    enabled?: string;
    receipt?: boolean;
    signedPath?: string;
  } = {},
) {
  const path = options.receipt ? receiptPath : deliveryPath;
  const body = JSON.stringify(payload);
  const signed = await svcSign(options.secret ?? SECRET, {
    method: "POST",
    path: options.signedPath ?? path,
    id: options.id ?? String(payload.id),
    body,
  });
  const response = await app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...signed },
      body,
    },
    {
      SERVICE_TURN_SECRET: SECRET,
      NETWORK_PERSONAL_CONTINUITY_ENABLED: options.enabled ?? "true",
      SHARED_RUNTIME_CONVERSATIONS: {
        getByName(name: string) {
          return {
            async fetch(input: RequestInfo | URL, init?: RequestInit) {
              dispatches.push({
                name,
                body: (await new Request(input, init).json()) as Record<
                  string,
                  unknown
                >,
              });
              return ownerResponse();
            },
          };
        },
      },
    },
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}
const intro = {
  id: "intro-1",
  to: "+14155550801",
  text: "Grace climbs too. Want an intro?",
  app: "slop",
  memberId: "slop_1",
  kind: "proactive",
};
test("a signed Network send enters the original Personal owner before any dispatch", async () => {
  expect(await post(intro)).toEqual({
    status: 200,
    body: {
      ok: true,
      replayed: false,
      providerMessageIds: ["owned-receipt"],
      history: true,
    },
  });
  const id = personalSharedAgentId({
    userId: "u-801",
    organizationId: "o-801",
  });
  expect(dispatches).toEqual([
    {
      name: `${id}:${id}`,
      body: {
        operation: "network-delivery",
        agentId: id,
        roomId: id,
        delivery: {
          project: "network",
          app: "slop",
          userId: "u-801",
          organizationId: "o-801",
          phoneNumber: intro.to,
          platform: "blooio",
          idempotencyKey: "network:svc:intro-1",
          text: intro.text,
        },
      },
    },
  ]);
});
test("arbitrary outbound phone numbers cannot provision an account, including kind reply", async () => {
  for (const kind of ["proactive", "relay", "reply"])
    expect((await post({ ...intro, to: "+14155550899", kind })).status).toBe(
      422,
    );
  expect(dispatches).toEqual([]);
});
test("owner uncertainty remains explicit and nonretryable", async () => {
  ownerResponse = () =>
    Response.json(
      { ok: false, error: "unknown", retryable: false },
      { status: 202 },
    );
  expect(await post(intro)).toEqual({
    status: 202,
    body: { ok: false, error: "unknown", retryable: false },
  });
});
test("invalid signatures, mismatched keys, malformed input and disabled activation never reach owner", async () => {
  expect(
    (await post(intro, { secret: "another-secret-0123456789abcdefXYZ" }))
      .status,
  ).toBe(401);
  // Full mounted paths are signed. A signature for the other endpoint or
  // the unmounted root cannot enter either owner operation.
  for (const receipt of [false, true]) {
    expect(
      (
        await post(intro, {
          receipt,
          signedPath: receipt ? deliveryPath : receiptPath,
        })
      ).status,
    ).toBe(401);
    expect((await post(intro, { receipt, signedPath: "/" })).status).toBe(401);
  }
  expect((await post(intro, { id: "other-id" })).status).toBe(400);
  expect((await post({ ...intro, to: "4155550801" })).status).toBe(400);
  expect((await post({ ...intro, app: "foreign" })).status).toBe(400);
  expect((await post(intro, { enabled: "false" })).status).toBe(503);
  expect(dispatches).toEqual([]);
});

test("receipt requests are explicitly reconcile-only and never provision missing accounts", async () => {
  expect((await post(intro, { receipt: true })).status).toBe(200);
  expect(dispatches[0]?.body).toMatchObject({
    operation: "network-delivery",
    reconcileOnly: true,
  });
  dispatches.length = 0;
  expect(
    await post({ ...intro, to: "+14155550899" }, { receipt: true }),
  ).toEqual({
    status: 202,
    body: { ok: false, error: "unknown", retryable: false },
  });
  expect(dispatches).toEqual([]);
});
