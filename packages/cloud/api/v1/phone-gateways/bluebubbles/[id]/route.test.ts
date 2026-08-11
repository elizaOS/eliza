/** Exercises BlueBubbles gateway revocation with deterministic authenticated Cloud collaborators. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
const revokeBlueBubblesGateway = mock(async () => true);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/phone-gateway-devices", () => ({
  revokeBlueBubblesGateway,
}));

const { default: app } = await import("./route");
const mountedApp = new Hono().route("/:id", app);

describe("BlueBubbles gateway revocation API", () => {
  beforeEach(() => {
    revokeBlueBubblesGateway.mockClear();
    revokeBlueBubblesGateway.mockResolvedValue(true);
  });

  test("revokes only within the authenticated organization", async () => {
    const response = await mountedApp.fetch(
      new Request("https://api.elizacloud.ai/gateway-1", { method: "DELETE" }),
    );

    expect(response.status).toBe(200);
    expect(revokeBlueBubblesGateway).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "gateway-1",
    );
  });

  test("does not disclose a gateway outside the authenticated organization", async () => {
    revokeBlueBubblesGateway.mockResolvedValueOnce(false);
    const response = await mountedApp.fetch(
      new Request("https://api.elizacloud.ai/gateway-2", { method: "DELETE" }),
    );

    expect(response.status).toBe(404);
  });
});
