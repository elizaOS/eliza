/**
 * PATCH /api/v1/containers/:id and DELETE ?mode=stop answer with the same
 * redacted `{ success, data }` DTO as the GET routes, never the raw
 * ContainerSummary with its node metadata.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import * as originalAuth from "@elizaos/cloud-shared/auth";
import * as originalErrors from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import * as originalClient from "@elizaos/cloud-shared/lib/services/containers/hetzner-client/client";
import * as originalLogger from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

mock.module("@elizaos/cloud-shared/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTAINER_ID = "ctr-1";
const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

const summary = {
  id: CONTAINER_ID,
  name: "api",
  projectName: "acme-api",
  status: "running",
  publicUrl: "https://acme-api.example.test",
  image: "ghcr.io/acme/api:1.2.3",
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  updatedAt: new Date("2026-10-13T12:00:00.000Z"),
  errorMessage: null,
  metadata: {
    provider: "hetzner-docker",
    nodeId: "node-7",
    hostname: "10.0.0.5",
    containerName: "cloud-container-ctr-1",
    hostPort: 31234,
    image: "ghcr.io/acme/api:1.2.3",
    containerPort: 3000,
    volumePath: "/var/lib/eliza/volumes/ctr-1",
  },
};

mock.module("@elizaos/cloud-shared/auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: ORG,
  }),
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/containers/hetzner-client/client",
  () => ({
    getHetznerContainersClient: () => ({
      restartContainer: async () => summary,
      setEnv: async () => summary,
      setScale: async () => undefined,
      getContainer: async () => summary,
      stopContainer: async () => ({ ...summary, status: "stopped" }),
      deleteContainer: async () => undefined,
    }),
  }),
);
mock.module("@elizaos/cloud-shared/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_c: unknown, error: unknown) => {
    throw error;
  },
}));

const { default: detailRoute } = await import("./route");

afterAll(() => {
  mock.module("@elizaos/cloud-shared/auth", () => originalAuth);
  mock.module(
    "@elizaos/cloud-shared/lib/api/cloud-worker-errors",
    () => originalErrors,
  );
  mock.module(
    "@elizaos/cloud-shared/lib/services/containers/hetzner-client/client",
    () => originalClient,
  );
  mock.module("@elizaos/cloud-shared/lib/utils/logger", () => originalLogger);
});

function request(method: string, path = "", body?: unknown) {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/containers/:id", detailRoute);
  return app.request(
    `/api/v1/containers/${CONTAINER_ID}${path}`,
    {
      method,
      ...(body
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    },
    ENV,
  );
}

const expectedData = {
  id: CONTAINER_ID,
  name: "api",
  project_name: "acme-api",
  status: "running",
  load_balancer_url: "https://acme-api.example.test",
  image_tag: "ghcr.io/acme/api:1.2.3",
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-13T12:00:00.000Z",
};

describe("container update and stop responses", () => {
  test.each([
    ["restart", { action: "restart" }],
    ["setEnv", { action: "setEnv", environmentVars: { LOG_LEVEL: "debug" } }],
    ["scale", { action: "scale", desiredCount: 1 }],
  ])(
    "PATCH %s answers with the redacted DTO under `data`",
    async (_label, body) => {
      const response = await request("PATCH", "", body);
      expect(response.status).toBe(200);
      const json = (await response.json()) as Record<string, unknown>;
      expect(json.success).toBe(true);
      expect(json.data).toMatchObject(expectedData);
      expect(json).not.toHaveProperty("container");
      expect(JSON.stringify(json)).not.toContain("10.0.0.5");
      expect(JSON.stringify(json)).not.toContain("31234");
    },
  );

  test("DELETE ?mode=stop answers with the redacted DTO under `data`", async () => {
    const response = await request("DELETE", "?mode=stop");
    expect(response.status).toBe(200);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.data).toMatchObject({ ...expectedData, status: "stopped" });
    expect(json).not.toHaveProperty("container");
    expect(JSON.stringify(json)).not.toContain("volumes/ctr-1");
  });
});
