import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Hono } from "hono";

const TEST_USER = {
  id: "22222222-2222-4222-8222-222222222222",
  organization_id: "11111111-1111-4111-8111-111111111111",
};

async function loadCodingContainersRoute(): Promise<Hono> {
  const { Hono } = await import("hono");
  const mod = await import(
    new URL(
      `../../../apps/api/v1/coding-containers/route.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  const inner = mod.default as Hono;
  const parent = new Hono();
  parent.route("/api/v1/coding-containers", inner);
  return parent;
}

async function loadCodingContainerPromotionsRoute(): Promise<Hono> {
  const { Hono } = await import("hono");
  const mod = await import(
    new URL(
      `../../../apps/api/v1/coding-containers/promotions/route.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  const inner = mod.default as Hono;
  const parent = new Hono();
  parent.route("/api/v1/coding-containers/promotions", inner);
  return parent;
}

async function loadCodingContainerSyncRoute(): Promise<Hono> {
  const { Hono } = await import("hono");
  const mod = await import(
    new URL(
      `../../../apps/api/v1/coding-containers/[containerId]/sync/route.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  const inner = mod.default as Hono;
  const parent = new Hono();
  parent.route("/api/v1/coding-containers/:containerId/sync", inner);
  return parent;
}

function installBaseMocks(): void {
  mock.module("@/lib/auth/workers-hono-auth", () => ({
    requireUserOrApiKeyWithOrg: async () => TEST_USER,
  }));
  mock.module("@/lib/api/cloud-worker-errors", () => ({
    failureResponse: (_c: unknown, error: unknown) => {
      const e = error as { message?: string };
      return new Response(JSON.stringify({ success: false, error: e?.message ?? String(error) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    },
  }));
  mock.module("@/lib/utils/logger", () => ({
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  }));
}

describe("coding-containers route", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mock.restore();
    installBaseMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("creates Claude/Codex/OpenCode containers through the control plane", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: new Headers(init?.headers),
      });
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            id: "container-1",
            status: "pending",
            publicUrl: "https://container-1.example.test",
            createdAt: "2026-05-11T00:00:00.000Z",
          },
          polling: { endpoint: "/api/v1/containers/container-1", intervalMs: 5000 },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const route = await loadCodingContainersRoute();
    const res = await route.request(
      "https://api.test/api/v1/coding-containers",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "opencode",
          promotionId: "promo-1",
          prompt: "Fix tests",
          source: {
            sourceKind: "project",
            projectId: "mobile-project",
            snapshotId: "snapshot-1",
            files: [
              {
                path: "src/index.ts",
                contents: "export const answer = 42;\n",
                encoding: "utf-8",
                size: 26,
              },
            ],
            manifest: { fileCount: 1, totalBytes: 26 },
          },
          container: {
            name: "Mobile Worktree",
            image: "ghcr.io/elizaos/eliza-coding:latest",
            environmentVars: { USER_FLAG: "1", ELIZA_CODING_AGENT: "spoofed" },
          },
        }),
      },
      {
        CONTAINER_CONTROL_PLANE_URL: "https://control-plane.example.test",
        CONTAINER_CONTROL_PLANE_TOKEN: "secret-token",
        DATABASE_URL: "postgres://db.example/test",
      },
    );

    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://control-plane.example.test/api/v1/containers");
    expect(calls[0]?.headers.get("x-eliza-user-id")).toBe(TEST_USER.id);
    expect(calls[0]?.headers.get("x-eliza-organization-id")).toBe(TEST_USER.organization_id);
    expect(calls[0]?.headers.get("x-container-control-plane-token")).toBe("secret-token");
    expect(calls[0]?.headers.get("x-eliza-cloud-database-url")).toBe("postgres://db.example/test");
    expect(calls[0]?.body).toMatchObject({
      name: "mobile-worktree",
      project_name: "mobile-worktree",
      image: "ghcr.io/elizaos/eliza-coding:latest",
      persist_volume: true,
      use_hetzner_volume: true,
      volume_mount_path: "/workspace/mobile-project",
      bootstrap_source: {
        sourceKind: "project",
        projectId: "mobile-project",
        snapshotId: "snapshot-1",
        files: [
          {
            path: "src/index.ts",
            contents: "export const answer = 42;\n",
            encoding: "utf-8",
            size: 26,
          },
        ],
      },
      environment_vars: {
        USER_FLAG: "1",
        ELIZA_CODING_AGENT: "opencode",
        ELIZA_CLOUD_CODING_AGENT: "opencode",
        ELIZA_CODING_PROMOTION_ID: "promo-1",
        ELIZA_CODING_SOURCE_KIND: "project",
        ELIZA_CODING_SOURCE_PROJECT_ID: "mobile-project",
        ELIZA_CODING_SOURCE_SNAPSHOT_ID: "snapshot-1",
        ELIZA_CODING_WORKSPACE: "/workspace/mobile-project",
      },
    });

    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: {
        containerId: "container-1",
        status: "pending",
        agent: "opencode",
        promotionId: "promo-1",
        workspacePath: "/workspace/mobile-project",
        url: "https://container-1.example.test",
        metadata: {
          sourceFileCount: 1,
          sourceTotalBytes: 26,
          volumeMountPath: "/workspace/mobile-project",
        },
      },
    });
  });

  test("rejects invalid coding agents before forwarding", async () => {
    const calls: unknown[] = [];
    globalThis.fetch = (async () => {
      calls.push({});
      return new Response("{}");
    }) as unknown as typeof fetch;

    const route = await loadCodingContainersRoute();
    const res = await route.request(
      "https://api.test/api/v1/coding-containers",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "gemini" }),
      },
      { CONTAINER_CONTROL_PLANE_URL: "https://control-plane.example.test" },
    );

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("fails closed when the control plane is not configured", async () => {
    const calls: unknown[] = [];
    globalThis.fetch = (async () => {
      calls.push({});
      return new Response("{}");
    }) as unknown as typeof fetch;

    const route = await loadCodingContainersRoute();
    const res = await route.request("https://api.test/api/v1/coding-containers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "claude", promotionId: "promo-1" }),
    });

    expect(res.status).toBe(503);
    expect(calls).toEqual([]);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      code: "CONTAINER_CONTROL_PLANE_NOT_CONFIGURED",
    });
  });

  test("accepts VFS promotions after auth and validation", async () => {
    const route = await loadCodingContainerPromotionsRoute();
    const res = await route.request("https://api.test/api/v1/coding-containers/promotions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        preferredAgent: "codex",
        source: {
          sourceKind: "project",
          projectId: "mobile-project",
          files: [{ path: "src/index.ts", contents: "export {};", encoding: "utf-8" }],
        },
      }),
    });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: {
        status: "accepted",
        source: { sourceKind: "project", projectId: "mobile-project" },
        workspacePath: "/workspace/mobile-project",
      },
    });
  });

  test("accepts sync requests with decoded container ids", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: new Headers(init?.headers),
      });
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            status: "ready",
            direction: "roundtrip",
            changedFiles: [
              {
                path: "src/index.ts",
                contents: "ZXhwb3J0IHt9Owo=",
                encoding: "base64",
                size: 11,
              },
            ],
            deletedFiles: [],
            patches: [],
            metadata: { exportedFileCount: 1 },
          },
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const route = await loadCodingContainerSyncRoute();
    const res = await route.request(
      "https://api.test/api/v1/coding-containers/container%2Fone/sync",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          direction: "roundtrip",
          target: { sourceKind: "workspace", workspaceId: "workspace-1" },
          changedFiles: [{ path: "src/index.ts", contents: "export {};\n", encoding: "utf-8" }],
        }),
      },
      {
        CONTAINER_CONTROL_PLANE_URL: "https://control-plane.example.test",
        CONTAINER_CONTROL_PLANE_TOKEN: "secret-token",
        DATABASE_URL: "postgres://db.example/test",
      },
    );

    expect(res.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://control-plane.example.test/api/v1/containers/container%2Fone/workspace-sync",
    );
    expect(calls[0]?.headers.get("x-container-control-plane-token")).toBe("secret-token");
    expect(calls[0]?.body).toMatchObject({
      direction: "roundtrip",
      changedFiles: [{ path: "src/index.ts", contents: "export {};\n", encoding: "utf-8" }],
    });
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: {
        containerId: "container/one",
        status: "ready",
        direction: "roundtrip",
        target: { sourceKind: "workspace", workspaceId: "workspace-1" },
        changedFiles: [{ path: "src/index.ts", encoding: "base64" }],
        metadata: { exportedFileCount: 1 },
      },
    });
  });
});
