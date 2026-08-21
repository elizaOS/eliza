/**
 * DELETE /api/v1/apps/:id `deleteGitHubRepo` is app-delete GitHub-repo
 * identity, not leftover tax on telegram webhook flag or share-ingest
 * consume. Stock develop treated any non-exact `false` token as
 * delete, so `deleteGitHubRepo=FALSE` still deleted the linked repo.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

mock.module("@/lib/utils/logger", () => ({
  logger: { info: mock(() => undefined), error: mock(() => undefined) },
}));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const APP_ID = "99999999-9999-4999-8999-000000000001";
const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];
type DeleteAppWithCleanup =
  typeof import("@/lib/services/app-cleanup").deleteAppWithCleanup;

const getById = mock(async (id: string) =>
  id === APP_ID
    ? { id: APP_ID, organization_id: ORG_A, github_repo: "elizaOS-apps/keep" }
    : null,
);
const deleteAppWithCleanup = mock(
  async (
    ..._args: Parameters<DeleteAppWithCleanup>
  ): Promise<Awaited<ReturnType<DeleteAppWithCleanup>>> => ({
    success: true,
    errors: [],
    cleaned: {
      domainsRemoved: 0,
      githubRepoDeleted: true,
      secretBindingsRemoved: 0,
      managedDomainsUnlinked: 0,
      containersTornDown: 0,
    },
  }),
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: ORG_A,
  }),
}));
mock.module("@/lib/auth/app-key-scope", () => ({
  isAppKeyOutOfScope: async () => false,
}));
mock.module("@/lib/services/apps", () => ({
  appsService: { getById },
}));
mock.module("@/lib/services/app-cleanup", () => ({
  appCleanupService: { deleteAppWithCleanup },
}));
mock.module("@/lib/services/app-review", () => ({
  buildReviewCandidate: () => ({}),
}));
mock.module("@/lib/services/characters/characters", () => ({
  charactersService: { getById: async () => null },
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_c: unknown, error: unknown) => {
    throw error;
  },
}));

const { default: detailRoute } = await import("./route");

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/apps/:id", detailRoute);
  return app;
}

function del(query = "") {
  return buildApp().request(
    `/api/v1/apps/${APP_ID}${query}`,
    { method: "DELETE" },
    ENV,
  );
}

describe("DELETE /api/v1/apps/:id GitHub-repo identity", () => {
  beforeEach(() => {
    getById.mockClear();
    deleteAppWithCleanup.mockClear();
  });

  test.each(["", "?deleteGitHubRepo=", "?deleteGitHubRepo=true"])(
    "accepts %s as delete the linked GitHub repo",
    async (query) => {
      const response = await del(query);
      expect(response.status).toBe(200);
      expect(getById).toHaveBeenCalledTimes(1);
      expect(deleteAppWithCleanup).toHaveBeenCalledTimes(1);
      expect(deleteAppWithCleanup.mock.calls[0][1]).toMatchObject({
        deleteGitHubRepo: true,
      });
    },
  );

  test("accepts deleteGitHubRepo=false as keep the linked repo", async () => {
    const response = await del("?deleteGitHubRepo=false");
    expect(response.status).toBe(200);
    expect(deleteAppWithCleanup).toHaveBeenCalledTimes(1);
    expect(deleteAppWithCleanup.mock.calls[0][1]).toMatchObject({
      deleteGitHubRepo: false,
    });
  });

  test.each(["FALSE", "TRUE", "0", "1", "no", "yes", "foo"])(
    "rejects deleteGitHubRepo=%s before getById and cleanup",
    async (token) => {
      const response = await del(
        `?deleteGitHubRepo=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid deleteGitHubRepo");
      expect(getById).not.toHaveBeenCalled();
      expect(deleteAppWithCleanup).not.toHaveBeenCalled();
    },
  );
});
