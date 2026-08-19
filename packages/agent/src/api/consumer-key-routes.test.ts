/**
 * Boundary tests for the OWNER-only consumer-key admin routes. Real handler,
 * real role resolution (API-token auth), fake in-memory consumer-key admin
 * injected through the agent host bridge; no vi.mock and no network.
 */
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AccountPoolConsumerKeyAdmin,
  type AccountPoolConsumerKeySummary,
  defaultAgentHostBridge,
  setAgentHostBridge,
} from "../runtime/host-bridge.ts";
import { handleConsumerKeyRoutes } from "./consumer-key-routes.ts";

const TOKEN = "consumer-key-routes-test-token-0123456789abcdef";

interface FakeResponse {
  status: number | null;
  body: unknown;
  res: http.ServerResponse;
}

function makeRequest(options: {
  method: string;
  pathname: string;
  authorized: boolean;
  body?: unknown;
}): {
  ctx: Parameters<typeof handleConsumerKeyRoutes>[0];
  reply: FakeResponse;
} {
  const req = {
    method: options.method,
    url: options.pathname,
    headers: options.authorized ? { authorization: `Bearer ${TOKEN}` } : {},
    socket: { remoteAddress: "203.0.113.10" },
  } as unknown as http.IncomingMessage;
  const reply: FakeResponse = {
    status: null,
    body: null,
    res: {} as http.ServerResponse,
  };
  const ctx = {
    req,
    res: reply.res,
    method: options.method,
    pathname: options.pathname,
    json: (_res: http.ServerResponse, data: unknown, status = 200) => {
      reply.status = status;
      reply.body = data;
    },
    error: (_res: http.ServerResponse, message: string, status = 500) => {
      reply.status = status;
      reply.body = { error: message };
    },
    readJsonBody: async <T extends object>() => (options.body ?? {}) as T,
  } as unknown as Parameters<typeof handleConsumerKeyRoutes>[0];
  return { ctx, reply };
}

function makeAdmin(): {
  admin: AccountPoolConsumerKeyAdmin;
  store: AccountPoolConsumerKeySummary[];
} {
  const store: AccountPoolConsumerKeySummary[] = [];
  let counter = 0;
  const admin: AccountPoolConsumerKeyAdmin = {
    list: () => [...store],
    create: (input) => {
      if (typeof input.label === "number") return null;
      counter += 1;
      const consumer: AccountPoolConsumerKeySummary = {
        id: `ck_${counter}`,
        label: typeof input.label === "string" ? input.label : "consumer",
        enabled: input.enabled !== false,
        dailyTokenQuota:
          typeof input.dailyTokenQuota === "number"
            ? input.dailyTokenQuota
            : null,
        keyPrefix: `eliza_cp_test${counter}`,
        createdAt: 1000,
        updatedAt: 1000,
      };
      store.push(consumer);
      return { key: `eliza_cp_plaintext_${counter}`, consumer };
    },
    update: (id, input) => {
      const found = store.find((entry) => entry.id === id);
      if (!found) return null;
      if (typeof input.label === "number") return "invalid";
      if (typeof input.enabled === "boolean") found.enabled = input.enabled;
      if (typeof input.label === "string") found.label = input.label;
      return found;
    },
    rotate: (id) => {
      const found = store.find((entry) => entry.id === id);
      if (!found) return null;
      counter += 1;
      found.keyPrefix = `eliza_cp_rot${counter}`;
      return { key: `eliza_cp_rotated_${counter}`, consumer: found };
    },
  };
  return { admin, store };
}

let priorToken: string | undefined;

beforeEach(() => {
  priorToken = process.env.ELIZA_API_TOKEN;
  process.env.ELIZA_API_TOKEN = TOKEN;
});

afterEach(() => {
  if (priorToken === undefined) delete process.env.ELIZA_API_TOKEN;
  else process.env.ELIZA_API_TOKEN = priorToken;
  setAgentHostBridge(defaultAgentHostBridge);
});

function installAdmin(): ReturnType<typeof makeAdmin> {
  const made = makeAdmin();
  setAgentHostBridge({
    ...defaultAgentHostBridge,
    getAccountPoolConsumerKeyAdmin: () => made.admin,
  });
  return made;
}

describe("consumer-key routes authorization", () => {
  it("ignores unrelated paths", async () => {
    installAdmin();
    const { ctx } = makeRequest({
      method: "GET",
      pathname: "/api/accounts/anthropic-claude",
      authorized: true,
    });
    expect(await handleConsumerKeyRoutes(ctx)).toBe(false);
  });

  it("denies non-OWNER callers with 403 on every verb", async () => {
    const { store } = installAdmin();
    for (const [method, pathname] of [
      ["GET", "/api/accounts/consumer-keys"],
      ["POST", "/api/accounts/consumer-keys"],
      ["PATCH", "/api/accounts/consumer-keys/ck_1"],
      ["POST", "/api/accounts/consumer-keys/ck_1/rotate"],
    ] as const) {
      const { ctx, reply } = makeRequest({
        method,
        pathname,
        authorized: false,
      });
      expect(await handleConsumerKeyRoutes(ctx)).toBe(true);
      expect(reply.status).toBe(403);
    }
    expect(store).toHaveLength(0);
  });

  it("answers 501 when the host exposes no consumer-key admin", async () => {
    setAgentHostBridge(defaultAgentHostBridge);
    const { ctx, reply } = makeRequest({
      method: "GET",
      pathname: "/api/accounts/consumer-keys",
      authorized: true,
    });
    expect(await handleConsumerKeyRoutes(ctx)).toBe(true);
    expect(reply.status).toBe(501);
  });
});

describe("consumer-key routes CRUD", () => {
  it("lists, creates with one-time plaintext, patches, and rotates", async () => {
    installAdmin();

    const list0 = makeRequest({
      method: "GET",
      pathname: "/api/accounts/consumer-keys",
      authorized: true,
    });
    await handleConsumerKeyRoutes(list0.ctx);
    expect(list0.reply.status).toBe(200);
    expect(list0.reply.body).toEqual({ keys: [] });

    const create = makeRequest({
      method: "POST",
      pathname: "/api/accounts/consumer-keys",
      authorized: true,
      body: { label: "proxy-a", dailyTokenQuota: 1_000_000 },
    });
    await handleConsumerKeyRoutes(create.ctx);
    expect(create.reply.status).toBe(201);
    const created = create.reply.body as {
      key: string;
      consumer: AccountPoolConsumerKeySummary;
    };
    expect(created.key).toContain("eliza_cp_plaintext_");
    expect(created.consumer.label).toBe("proxy-a");

    const patch = makeRequest({
      method: "PATCH",
      pathname: `/api/accounts/consumer-keys/${created.consumer.id}`,
      authorized: true,
      body: { enabled: false },
    });
    await handleConsumerKeyRoutes(patch.ctx);
    expect(patch.reply.status).toBe(200);
    expect(
      (patch.reply.body as { consumer: AccountPoolConsumerKeySummary }).consumer
        .enabled,
    ).toBe(false);

    const rotate = makeRequest({
      method: "POST",
      pathname: `/api/accounts/consumer-keys/${created.consumer.id}/rotate`,
      authorized: true,
    });
    await handleConsumerKeyRoutes(rotate.ctx);
    expect(rotate.reply.status).toBe(200);
    expect((rotate.reply.body as { key: string }).key).toContain(
      "eliza_cp_rotated_",
    );

    // The list surface never exposes plaintext keys.
    const list1 = makeRequest({
      method: "GET",
      pathname: "/api/accounts/consumer-keys",
      authorized: true,
    });
    await handleConsumerKeyRoutes(list1.ctx);
    expect(JSON.stringify(list1.reply.body)).not.toContain("plaintext");
    expect(JSON.stringify(list1.reply.body)).not.toContain("rotated");
  });

  it("maps invalid input to 400 and unknown ids to 404", async () => {
    installAdmin();
    const badCreate = makeRequest({
      method: "POST",
      pathname: "/api/accounts/consumer-keys",
      authorized: true,
      body: { label: 42 },
    });
    await handleConsumerKeyRoutes(badCreate.ctx);
    expect(badCreate.reply.status).toBe(400);

    const missingPatch = makeRequest({
      method: "PATCH",
      pathname: "/api/accounts/consumer-keys/ck_missing",
      authorized: true,
      body: { enabled: true },
    });
    await handleConsumerKeyRoutes(missingPatch.ctx);
    expect(missingPatch.reply.status).toBe(404);

    const missingRotate = makeRequest({
      method: "POST",
      pathname: "/api/accounts/consumer-keys/ck_missing/rotate",
      authorized: true,
    });
    await handleConsumerKeyRoutes(missingRotate.ctx);
    expect(missingRotate.reply.status).toBe(404);

    const badVerb = makeRequest({
      method: "DELETE",
      pathname: "/api/accounts/consumer-keys/ck_missing",
      authorized: true,
    });
    await handleConsumerKeyRoutes(badVerb.ctx);
    expect(badVerb.reply.status).toBe(405);
  });

  it("rejects malformed percent-encoded consumer key id with 400", async () => {
    const getAdmin = vi.fn(() => {
      throw new Error("invalid paths must not resolve the admin service");
    });
    setAgentHostBridge({
      ...defaultAgentHostBridge,
      getAccountPoolConsumerKeyAdmin: getAdmin,
    });
    for (const badId of ["%", "%2", "%ZZ", "%E0%A4"]) {
      for (const [method, suffix, body] of [
        ["PATCH", "", { enabled: true }],
        ["POST", "/rotate", undefined],
      ] as const) {
        const badReq = makeRequest({
          method,
          pathname: `/api/accounts/consumer-keys/${badId}${suffix}`,
          authorized: true,
          body,
        });
        await handleConsumerKeyRoutes(badReq.ctx);
        expect(badReq.reply.status).toBe(400);
        expect(badReq.reply.body).toEqual({
          error: "Invalid consumer-key id encoding",
        });
      }
    }
    expect(getAdmin).not.toHaveBeenCalled();
  });

  it("authenticates before reporting malformed consumer-key paths", async () => {
    const getAdmin = vi.fn();
    setAgentHostBridge({
      ...defaultAgentHostBridge,
      getAccountPoolConsumerKeyAdmin: getAdmin,
    });
    const request = makeRequest({
      method: "PATCH",
      pathname: "/api/accounts/consumer-keys/%",
      authorized: false,
      body: { enabled: true },
    });

    await handleConsumerKeyRoutes(request.ctx);

    expect(request.reply.status).toBe(403);
    expect(getAdmin).not.toHaveBeenCalled();
  });

  it("decodes valid percent-encoded consumer key id", async () => {
    const { admin } = installAdmin();
    const created = admin.create({ label: "encoded" });
    expect(created).not.toBeNull();
    if (!created) throw new Error("expected created consumer key");
    const id = "ck/legacy\\id";
    created.consumer.id = id;
    const encodedId = encodeURIComponent(id);

    const patchReq = makeRequest({
      method: "PATCH",
      pathname: `/api/accounts/consumer-keys/${encodedId}`,
      authorized: true,
      body: { label: "updated" },
    });
    await handleConsumerKeyRoutes(patchReq.ctx);
    expect(patchReq.reply.status).toBe(200);
  });
});
