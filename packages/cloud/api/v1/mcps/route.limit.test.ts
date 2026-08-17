/**
 * GET /api/v1/mcps `limit` is user-MCP catalog page size identity,
 * leftover tax after plugin-mcp marketplace / cloud MCP search.
 * Stock develop used z.coerce.number(), which treated `1e2` / `007` /
 * `0x10` as a page size instead of a 400. offset / category / search /
 * status / scope stay untouched.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const listByOrganization = mock(async () => []);
const listPublic = mock(async () => []);
const toVisibleMcpForOrganization = mock((mcp: unknown) => mcp);
const toPublicMcp = mock((mcp: unknown) => mcp);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_c: unknown, error: unknown) => {
    throw error;
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { warn: () => undefined, info: () => undefined, error: () => undefined },
}));
mock.module("@/lib/security/outbound-url", () => ({
  isForbiddenIpAddress: () => false,
}));
mock.module("@/lib/services/user-mcps", () => ({
  userMcpsService: {
    listByOrganization,
    listPublic,
    toVisibleMcpForOrganization,
    toPublicMcp,
    create: mock(async () => ({ id: "mcp-1", name: "n" })),
  },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/", route);

describe("GET /api/v1/mcps limit identity", () => {
  beforeEach(() => {
    listByOrganization.mockClear();
    listPublic.mockClear();
  });

  test.each(["", "?limit=", "?limit"])(
    "accepts %s as the default MCP catalog page of 50",
    async (query) => {
      const response = await app.request(`/${query}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        pagination: { limit: number };
      };
      expect(body.pagination.limit).toBe(50);
      expect(listByOrganization).toHaveBeenCalledTimes(1);
      expect(listByOrganization).toHaveBeenCalledWith(
        "org-1",
        expect.objectContaining({ limit: 50 }),
      );
    },
  );

  test("accepts limit=10 as an exact MCP catalog page size", async () => {
    const response = await app.request("/?limit=10");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      pagination: { limit: number };
    };
    expect(body.pagination.limit).toBe(10);
    expect(listByOrganization).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ limit: 10 }),
    );
  });

  test("caps a canonical oversize limit at 100", async () => {
    const response = await app.request("/?limit=101");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      pagination: { limit: number };
    };
    expect(body.pagination.limit).toBe(100);
    expect(listByOrganization).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ limit: 100 }),
    );
  });

  test.each(["1e2", "12px", "007", "0", "abc", "-1", "50abc", " 10", "10 ", "0x10"])(
    "rejects prefix-coerced limit=%s before userMcpsService.listByOrganization",
    async (token) => {
      const response = await app.request(
        `/?limit=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid limit");
      expect(listByOrganization).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?limit=10&limit=10",
    "?limit=10&limit=20",
    "?limit=&limit=10",
    "?limit=foo&limit=10",
  ])(
    "rejects duplicate limit values in %s before userMcpsService.listByOrganization",
    async (query) => {
      const response = await app.request(`/${query}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid limit");
      expect(listByOrganization).not.toHaveBeenCalled();
    },
  );
});
