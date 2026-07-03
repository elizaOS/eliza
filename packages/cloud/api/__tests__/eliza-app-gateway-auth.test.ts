import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { AuthenticationError } from "@/lib/api/cloud-worker-errors";
import * as authActual from "@/lib/auth/workers-hono-auth";

const requireUserOrApiKeyWithOrg = mock();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...authActual,
  requireUserOrApiKeyWithOrg,
}));

const gatewayRoute = (await import("../eliza-app/gateway/[agentId]/route")).default;

afterAll(() => {
  mock.module("@/lib/auth/workers-hono-auth", () => authActual);
});

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
});

describe("POST /api/eliza-app/gateway/:agentId auth", () => {
  test("rejects programmatic-looking bearer tokens unless route auth validates them", async () => {
    requireUserOrApiKeyWithOrg.mockRejectedValue(
      AuthenticationError("Invalid or expired API key"),
    );

    const res = await gatewayRoute.request("/", {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_fake_key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "hello" }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { success?: boolean; code?: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe("authentication_required");
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
  });

  test("keeps the demo response for validated callers", async () => {
    requireUserOrApiKeyWithOrg.mockResolvedValue({
      id: "user-1",
      organization_id: "org-1",
      organization: { id: "org-1", is_active: true, name: "Org" },
      is_active: true,
    });

    const res = await gatewayRoute.request("/", {
      method: "POST",
      headers: {
        "X-API-Key": "eliza_valid_key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "hello" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean; reply?: string };
    expect(body.success).toBe(true);
    expect(body.reply).toContain("Hello there");
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
  });
});
