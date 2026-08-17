/**
 * DELETE /api/v1/containers/:id `purgeVolume` is container-delete volume
 * identity, not leftover tax on app-delete GitHub-repo flag. Stock
 * develop used `z.coerce.boolean()`, so `purgeVolume=false` / `FALSE`
 * still rm -rf'd the host volume.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const CONTAINER_ID = "ctr-keep-volume";
const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

const deleteContainer = mock(async () => undefined);
const stopContainer = mock(async () => ({
  id: CONTAINER_ID,
  status: "stopped",
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: ORG_A,
  }),
}));
mock.module("@/lib/services/containers/hetzner-client/client", () => ({
  getHetznerContainersClient: () => ({
    deleteContainer,
    stopContainer,
  }),
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_c: unknown, error: unknown) => {
    throw error;
  },
}));

const { default: detailRoute } = await import("./route");

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/containers/:id", detailRoute);
  return app;
}

function del(query = "") {
  return buildApp().request(
    `/api/v1/containers/${CONTAINER_ID}${query}`,
    { method: "DELETE" },
    ENV,
  );
}

describe("DELETE /api/v1/containers/:id purgeVolume identity", () => {
  beforeEach(() => {
    deleteContainer.mockClear();
    stopContainer.mockClear();
  });

  test.each(["", "?purgeVolume=", "?purgeVolume=false"])(
    "accepts %s as keep the host volume",
    async (query) => {
      const response = await del(query);
      expect(response.status).toBe(200);
      expect(deleteContainer).toHaveBeenCalledTimes(1);
      expect(deleteContainer.mock.calls[0][2]).toMatchObject({
        purgeVolume: false,
      });
      expect(stopContainer).not.toHaveBeenCalled();
    },
  );

  test("accepts purgeVolume=true as destroy the host volume", async () => {
    const response = await del("?purgeVolume=true");
    expect(response.status).toBe(200);
    expect(deleteContainer).toHaveBeenCalledTimes(1);
    expect(deleteContainer.mock.calls[0][2]).toMatchObject({
      purgeVolume: true,
    });
  });

  test.each([
    ["false", false],
    ["true", true],
  ] as const)(
    "applies purgeVolume=%s consistently when mode=stop",
    async (raw, expected) => {
      const response = await del(`?mode=stop&purgeVolume=${raw}`);

      expect(response.status).toBe(200);
      expect(stopContainer).toHaveBeenCalledTimes(1);
      expect(stopContainer.mock.calls[0][2]).toMatchObject({
        purgeVolume: expected,
      });
      expect(deleteContainer).not.toHaveBeenCalled();
    },
  );

  test.each(["FALSE", "TRUE", "0", "1", "no", "yes", "foo"])(
    "rejects purgeVolume=%s before deleteContainer",
    async (token) => {
      const response = await del(`?purgeVolume=${encodeURIComponent(token)}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid purgeVolume");
      expect(deleteContainer).not.toHaveBeenCalled();
      expect(stopContainer).not.toHaveBeenCalled();
    },
  );
});
