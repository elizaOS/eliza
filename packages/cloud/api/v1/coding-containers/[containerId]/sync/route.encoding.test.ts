/** Exercises coding-container sync identifier decoding at the authenticated route boundary. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
  },
}));

const { default: route } = await import("./route");
const app = new Hono().route(
  "/api/v1/coding-containers/:containerId/sync",
  route,
);

const VALID_BODY = JSON.stringify({
  target: { sourceKind: "project", projectId: "proj-1" },
});

function syncUrl(containerId: string): string {
  return `https://api.example.test/api/v1/coding-containers/${containerId}/sync`;
}

async function postSync(containerId: string, body: string | null = VALID_BODY) {
  return app.fetch(
    new Request(syncUrl(containerId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}

describe("POST /api/v1/coding-containers/:containerId/sync encoding", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
  });

  test("canonical container id still reaches the control-plane forward", async () => {
    const response = await postSync("ctr-1");
    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      success: false,
      code: "CONTAINER_CONTROL_PLANE_NOT_CONFIGURED",
      error: "Container control plane URL is not configured",
    });
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
  });

  test("canonical percent-encoded hyphen still decodes before forward", async () => {
    const response = await postSync("ctr%2D1");
    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      success: false,
      code: "CONTAINER_CONTROL_PLANE_NOT_CONFIGURED",
      error: "Container control plane URL is not configured",
    });
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
  });

  test("invalid body after a canonical decode is still 400", async () => {
    const response = await postSync("ctr-1", JSON.stringify({ nope: true }));
    expect(response.status).toBe(400);
    const json = (await response.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toBeTruthy();
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
  });

  test.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "rejects malformed container id %s with 400 before body parse",
    async (token) => {
      const response = await postSync(token, JSON.stringify({ nope: true }));
      expect(response.status).toBe(400);
      expect((await response.json()) as unknown).toEqual({
        success: false,
        error: "invalid container id: malformed URL encoding",
      });
      expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    },
  );
});
