import { beforeEach, expect, mock, test } from "bun:test";
import { ApiError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import type { MiddlewareHandler } from "hono";

const identity = { id: "actor", organization_id: "org" };
const auth = mock(async () => identity);
const list = mock(async (_input: unknown) => ({
  observedAt: "now",
  items: [],
  nextCursor: null,
}));
mock.module("@elizaos/cloud-shared/auth", () => ({
  requireCurrentBillingManagerSession: auth,
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/subscription-command-status",
  () => ({ listPendingOrganizationPlanChangeCommands: list }),
);
const pass: MiddlewareHandler = async (_c, next) => {
  await next();
};
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({ rateLimit: () => pass, RateLimitPresets: { STANDARD: {} } }),
);
const app = (await import("./route")).default;
beforeEach(() => {
  auth.mockReset();
  auth.mockResolvedValue(identity);
  list.mockReset();
  list.mockResolvedValue({ observedAt: "now", items: [], nextCursor: null });
});
test("discovery derives actor and tenant, preserves pagination and returns no-store", async () => {
  const r = await app.request("/?limit=4&cursor=encoded");
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(list.mock.calls[0]?.[0]).toEqual({
    limit: 4,
    cursor: "encoded",
    actorId: "actor",
    organizationId: "org",
  });
  expect(auth).toHaveBeenCalledTimes(2);
});
test("missing, invalid and caller-owned authority parameters reject before discovery", async () => {
  for (const query of [
    "",
    "limit=0",
    "limit=101",
    "limit=1.5",
    "limit=x",
    "limit=1&actorId=other",
    "limit=1&organizationId=other",
    "limit=1&cursor=",
  ])
    expect((await app.request(`/?${query}`)).status).toBe(400);
  expect(list).not.toHaveBeenCalled();
});
test("expired manager access denies reads and changed identity discards the result", async () => {
  auth.mockRejectedValueOnce(new ApiError(403, "access_denied", "Denied"));
  expect((await app.request("/?limit=1")).status).toBe(403);
  expect(list).not.toHaveBeenCalled();
  auth
    .mockResolvedValueOnce(identity)
    .mockResolvedValueOnce({ ...identity, id: "other" });
  expect((await app.request("/?limit=1")).status).toBe(403);
});
test("invalid cursors are 400; unknown persistence messages are redacted 503", async () => {
  list.mockRejectedValueOnce(
    Object.assign(Error("private cursor details"), {
      code: "SUBSCRIPTION_COMMAND_CURSOR_INVALID",
    }),
  );
  expect((await app.request("/?limit=1")).status).toBe(400);
  list.mockRejectedValueOnce(Error("not found private database payload"));
  const response = await app.request("/?limit=1");
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private");
});
