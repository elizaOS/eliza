/**
 * GET /api/v1/admin/containers/ingress-map `format` is ingress-format
 * identity, not leftover analytics-export type tax. Stock develop treated
 * every non-`caddy` token as JSON, so `format=CADDY` / `YAML` silently
 * returned the JSON map instead of a Caddyfile.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireAdmin = mock(async () => ({ role: "super_admin" }));
const selectMock = mock(() => ({
  from: () => ({
    where: () => ({
      orderBy: async () => [
        {
          id: "ctr-1",
          name: "agent-one",
          organization_id: "org-1",
          status: "running",
          public_hostname: "one.sites.eliza.app",
          metadata: { hostname: "node-1", hostPort: 21090 },
        },
      ],
    }),
  }),
}));

mock.module("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  isNotNull: (value: unknown) => value,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
}));
mock.module("@/db/schemas/containers", () => ({
  containers: {
    id: "id",
    name: "name",
    organization_id: "organization_id",
    status: "status",
    public_hostname: "public_hostname",
    metadata: "metadata",
  },
}));
mock.module("@/lib/auth", () => ({ requireAdmin }));
mock.module("@/db/helpers", () => ({ dbRead: { select: selectMock } }));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(() => undefined) },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/", route);

describe("GET /api/v1/admin/containers/ingress-map format identity", () => {
  beforeEach(() => {
    requireAdmin.mockClear();
    selectMock.mockClear();
    requireAdmin.mockResolvedValue({ role: "super_admin" });
  });

  test.each(["", "?format="])(
    "accepts %s as the JSON ingress map",
    async (query) => {
      const response = await app.request(`/${query}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        success: boolean;
        data: { entries: Array<{ host: string; upstream: string }> };
      };
      expect(body.success).toBe(true);
      expect(body.data.entries).toEqual([
        {
          host: "one.sites.eliza.app",
          upstream: "http://node-1:21090",
          containerId: "ctr-1",
          containerName: "agent-one",
          organizationId: "org-1",
          status: "running",
        },
      ]);
      expect(selectMock).toHaveBeenCalledTimes(1);
    },
  );

  test("accepts format=json as the JSON ingress map", async () => {
    const response = await app.request("/?format=json");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  test("accepts format=caddy as the Caddyfile snippet", async () => {
    const response = await app.request("/?format=caddy");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain("one.sites.eliza.app {");
    expect(body).toContain("reverse_proxy http://node-1:21090");
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  test.each(["CADDY", "JSON", "yaml", "foo", "1e2"])(
    "rejects format=%s before the inventory read",
    async (token) => {
      const response = await app.request(`/?format=${token}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        success: boolean;
        error: string;
      };
      expect(body.success).toBe(false);
      expect(body.error).toBe("invalid_format");
      expect(selectMock).not.toHaveBeenCalled();
    },
  );
});
