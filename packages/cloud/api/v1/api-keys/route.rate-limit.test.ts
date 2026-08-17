/**
 * POST /api/v1/api-keys `rate_limit` is key-quota identity, leftover tax
 * after earnings-history / mcps list `limit`. Stock develop used
 * z.coerce.number(), which treated string `1e2` / `007` / `0x10` as a
 * quota instead of a 400. name / description / expires_at stay
 * untouched. Missing still means 1000. Exact integers above 100000
 * stay 400.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const create = mock(async () => ({
  apiKey: {
    id: "key-1",
    name: "studio",
    description: null,
    key_prefix: "eliza_abcd",
    created_at: new Date("2026-08-17T00:00:00.000Z"),
    rate_limit: 1000,
    expires_at: null,
  },
  plainKey: "eliza_plain",
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_c: unknown, error: unknown) => {
    throw error;
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    warn: () => undefined,
    info: () => undefined,
    error: () => undefined,
  },
}));
mock.module("@/lib/services/api-keys", () => ({
  apiKeysService: {
    create,
    listByOrganization: mock(async () => []),
  },
}));
mock.module("@/api-app/services/audit-dispatcher-singleton", () => ({
  getAuditDispatcher: () => ({
    emit: async () => undefined,
  }),
}));

const { default: route } = await import("./route");
const app = new Hono().route("/", route);

function post(body: Record<string, unknown>) {
  return app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/api-keys rate_limit identity", () => {
  beforeEach(() => {
    create.mockClear();
  });

  test("accepts omitted rate_limit as the default 1000 quota", async () => {
    const response = await post({ name: "studio" });
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ rate_limit: 1000 }),
    );
  });

  test("accepts rate_limit=250 as an exact key quota", async () => {
    const response = await post({ name: "studio", rate_limit: 250 });
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ rate_limit: 250 }),
    );
  });

  test("rejects a canonical oversize rate_limit before create", async () => {
    const response = await post({ name: "studio", rate_limit: 100001 });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Validation error");
    expect(create).not.toHaveBeenCalled();
  });

  test.each([
    "1e2",
    "12px",
    "007",
    "0",
    "abc",
    "-1",
    "50abc",
    " 250",
    "250 ",
    "0x10",
  ])(
    "rejects prefix-coerced rate_limit=%s before apiKeysService.create",
    async (token) => {
      const response = await post({ name: "studio", rate_limit: token });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Validation error");
      expect(create).not.toHaveBeenCalled();
    },
  );
});
