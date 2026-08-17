/**
 * GET /api/training/vertex/assignments `scope` is tuned-model tenant
 * identity, not leftover models catalogOnly or relationships-scope tax.
 * Stock develop mapped unknown tokens to organization, so scope=GLOBAL /
 * USER listed org assignments.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { VertexModelRegistryService } from "@/lib/services/vertex-model-registry";

type ListVisibleAssignmentsArgs = Parameters<
  VertexModelRegistryService["listVisibleAssignments"]
>;

const listVisibleAssignments = mock(
  async (..._args: ListVisibleAssignmentsArgs) => [{ id: "asg-1" }],
);

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKey: null,
  }),
  requireAdmin: async () => ({ role: "super_admin" }),
}));
mock.module("@/lib/services/vertex-model-registry", () => ({
  vertexModelRegistryService: {
    listVisibleAssignments,
    activateAssignment: mock(async () => ({})),
    deactivateAssignment: mock(async () => 0),
  },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/", route);

describe("GET /api/training/vertex/assignments scope identity", () => {
  beforeEach(() => {
    listVisibleAssignments.mockClear();
  });

  test.each(["", "?scope="])(
    "accepts %s as the unfiltered list",
    async (query) => {
      const response = await app.request(`/${query}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { assignments: { id: string }[] };
      expect(body.assignments).toEqual([{ id: "asg-1" }]);
      expect(listVisibleAssignments).toHaveBeenCalledTimes(1);
      const filter = listVisibleAssignments.mock.calls[0]?.[1];
      expect(filter?.scope).toBeUndefined();
    },
  );

  test.each(["global", "organization", "user"] as const)(
    "accepts scope=%s as that tenant",
    async (token) => {
      const response = await app.request(`/?scope=${token}`);
      expect(response.status).toBe(200);
      expect(listVisibleAssignments).toHaveBeenCalledTimes(1);
      const filter = listVisibleAssignments.mock.calls[0]?.[1];
      expect(filter?.scope).toBe(token);
    },
  );

  test.each(["GLOBAL", "USER", "Organization", "foo", "1e2"])(
    "rejects scope=%s before listVisibleAssignments",
    async (token) => {
      const response = await app.request(`/?scope=${token}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid scope.");
      expect(listVisibleAssignments).not.toHaveBeenCalled();
    },
  );
});
