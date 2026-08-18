/** Exercises tuned-model scope validation at the authenticated HTTP boundary. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const listVisibleTunedModels = mock(
  async (_identity: unknown, _filter: { scope?: string }) => [
    { id: "model-1" },
  ],
);
const listVisibleAssignments = mock(async () => [{ id: "asg-1" }]);
const resolveModelPreferences = mock(async () => ({
  modelPreferences: { should_respond: "model-1" },
}));

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKey: null,
  }),
}));
mock.module("@/lib/services/vertex-model-registry", () => ({
  vertexModelRegistryService: {
    listVisibleTunedModels,
    listVisibleAssignments,
    resolveModelPreferences,
  },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/api/training/vertex/models", route);

function getModels(query = "") {
  return app.request(`/api/training/vertex/models${query}`);
}

describe("GET /api/training/vertex/models scope identity", () => {
  beforeEach(() => {
    listVisibleTunedModels.mockClear();
    listVisibleAssignments.mockClear();
    resolveModelPreferences.mockClear();
  });

  test.each(["", "?scope="])(
    "accepts %s as the unfiltered tuned-model list",
    async (query) => {
      const response = await getModels(query);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { models: { id: string }[] };
      expect(body.models).toEqual([{ id: "model-1" }]);
      expect(listVisibleTunedModels).toHaveBeenCalledTimes(1);
      const filter = listVisibleTunedModels.mock.calls[0][1] as {
        scope?: string;
      };
      expect(filter.scope).toBeUndefined();
    },
  );

  test.each(["global", "organization", "user"] as const)(
    "accepts scope=%s as that tenant",
    async (token) => {
      const response = await getModels(`?scope=${token}`);
      expect(response.status).toBe(200);
      expect(listVisibleTunedModels).toHaveBeenCalledTimes(1);
      const filter = listVisibleTunedModels.mock.calls[0][1] as {
        scope?: string;
      };
      expect(filter.scope).toBe(token);
    },
  );

  test.each(["GLOBAL", "USER", "Organization", "foo", "1e2"])(
    "rejects scope=%s before tuned-model lookup",
    async (token) => {
      const response = await getModels(
        `?scope=${encodeURIComponent(token)}&slot=planner`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid scope.");
      expect(listVisibleTunedModels).not.toHaveBeenCalled();
      expect(listVisibleAssignments).not.toHaveBeenCalled();
      expect(resolveModelPreferences).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?scope=global&scope=global",
    "?scope=global&scope=user",
    "?scope=&scope=global",
    "?scope=foo&scope=global",
  ])(
    "rejects duplicate scope values in %s before tuned-model lookup",
    async (query) => {
      const response = await getModels(`${query}&slot=planner`);
      expect(response.status).toBe(400);
      expect(listVisibleTunedModels).not.toHaveBeenCalled();
      expect(listVisibleAssignments).not.toHaveBeenCalled();
      expect(resolveModelPreferences).not.toHaveBeenCalled();
    },
  );
});
