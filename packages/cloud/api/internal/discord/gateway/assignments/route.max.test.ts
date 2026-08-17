/**
 * GET /api/internal/discord/gateway/assignments `max` is pod-capacity
 * identity, leftover tax after cloud list `limit` leftover-tax. Stock
 * develop used z.coerce.number(), which treated `1e2` / `007` / `0x10`
 * as a capacity instead of a 400. current / pod stay untouched. Missing
 * / empty still means 50.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const getAssignmentsForPod = mock(async () => [{ id: "asg-1" }]);

mock.module("../../../_auth", () => ({
  requireInternalAuth: async () => ({
    podName: "internal-secret",
    service: "shared-secret",
  }),
}));
mock.module("@/db/repositories/discord-connections", () => ({
  discordConnectionsRepository: {
    getAssignmentsForPod,
  },
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

const { default: route } = await import("./route");
const app = new Hono().route("/", route);

describe("GET /api/internal/discord/gateway/assignments max identity", () => {
  beforeEach(() => {
    getAssignmentsForPod.mockClear();
  });

  test.each(["?pod=gw-1", "?pod=gw-1&max=", "?pod=gw-1&max"])(
    "accepts %s as the default 50 assignment cap",
    async (query) => {
      const response = await app.request(`/${query}`);
      expect(response.status).toBe(200);
      expect(getAssignmentsForPod).toHaveBeenCalledTimes(1);
      expect(getAssignmentsForPod).toHaveBeenCalledWith("gw-1", true);
    },
  );

  test("accepts max=10 as an exact assignment cap", async () => {
    const response = await app.request("/?pod=gw-1&max=10&current=3");
    expect(response.status).toBe(200);
    expect(getAssignmentsForPod).toHaveBeenCalledWith("gw-1", true);
  });

  test("accepts max=10 with current=10 as at-capacity", async () => {
    const response = await app.request("/?pod=gw-1&max=10&current=10");
    expect(response.status).toBe(200);
    expect(getAssignmentsForPod).toHaveBeenCalledWith("gw-1", false);
  });

  test("rejects a canonical oversize max before getAssignmentsForPod", async () => {
    const response = await app.request("/?pod=gw-1&max=501");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Invalid max");
    expect(getAssignmentsForPod).not.toHaveBeenCalled();
  });

  test.each([
    "1e2",
    "12px",
    "007",
    "0",
    "abc",
    "-1",
    "50abc",
    " 10",
    "10 ",
    "0x10",
  ])(
    "rejects prefix-coerced max=%s before getAssignmentsForPod",
    async (token) => {
      const response = await app.request(
        `/?pod=gw-1&max=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid max");
      expect(getAssignmentsForPod).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?pod=gw-1&max=10&max=10",
    "?pod=gw-1&max=10&max=20",
    "?pod=gw-1&max=&max=10",
    "?pod=gw-1&max=foo&max=10",
  ])(
    "rejects duplicate max values in %s before getAssignmentsForPod",
    async (query) => {
      const response = await app.request(`/${query}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid max");
      expect(getAssignmentsForPod).not.toHaveBeenCalled();
    },
  );
});
