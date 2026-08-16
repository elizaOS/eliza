/**
 * Exercises the admin infrastructure containers route trust boundary: strict
 * positive-integer limit parsing before the list query, so a client-supplied
 * negative or malformed value can never become a rejected SQL `LIMIT` clause.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const listForAdminInfrastructure = mock(async () => []);
const requireAdmin = mock(async () => ({
  id: "00000000-0000-4000-8000-000000000001",
  organization_id: "00000000-0000-4000-8000-000000000002",
  role: "super_admin",
}));

mock.module("@/db/repositories/containers", () => ({
  containersRepository: { listForAdminInfrastructure },
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({ requireAdmin }));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(() => undefined) },
}));

const route = (await import("../v1/admin/infrastructure/containers/route"))
  .default;
const app = new Hono().route("/api/v1/admin/infrastructure/containers", route);

function listContainers(query = "") {
  return app.request(`/api/v1/admin/infrastructure/containers${query}`);
}

describe("GET /api/v1/admin/infrastructure/containers limit parsing", () => {
  beforeEach(() => {
    requireAdmin.mockClear();
    listForAdminInfrastructure.mockClear();
    listForAdminInfrastructure.mockResolvedValue([]);
  });

  test("defaults to 500 when limit is absent", async () => {
    const response = await listContainers();
    expect(response.status).toBe(200);
    expect(listForAdminInfrastructure).toHaveBeenCalledWith(500);
  });

  test.each([1, 500, 2000])(
    "passes a valid positive integer of %i through the cap",
    async (limit) => {
      const response = await listContainers(`?limit=${limit}`);
      expect(response.status).toBe(200);
      expect(listForAdminInfrastructure).toHaveBeenCalledWith(limit);
    },
  );

  test("caps a valid positive integer above 2000 at 2000", async () => {
    const response = await listContainers("?limit=5000");
    expect(response.status).toBe(200);
    expect(listForAdminInfrastructure).toHaveBeenCalledWith(2000);
  });

  test.each([
    ["empty", ""],
    ["negative", "-1"],
    ["zero", "0"],
    ["malformed prefix", "25rows"],
    ["fractional", "1.5"],
    ["exponent form", "2e3"],
    ["non-finite", "Infinity"],
    ["unsafe integer", "9007199254740992"],
  ])(
    "defaults %s limits to 500 without failing the query",
    async (_name, limit) => {
      const response = await listContainers(
        `?limit=${encodeURIComponent(limit)}`,
      );
      expect(response.status).toBe(200);
      expect(listForAdminInfrastructure).toHaveBeenCalledWith(500);
    },
  );
});
