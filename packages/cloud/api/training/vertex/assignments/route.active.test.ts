/** Exercises Vertex assignment active-filter validation at the HTTP boundary. */
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

describe("GET /api/training/vertex/assignments active identity", () => {
  beforeEach(() => {
    listVisibleAssignments.mockClear();
  });

  test.each(["", "?active=", "?active=true"])(
    "accepts %s as the active-only assignment list",
    async (query) => {
      const response = await app.request(`/${query}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { assignments: { id: string }[] };
      expect(body.assignments).toEqual([{ id: "asg-1" }]);
      expect(listVisibleAssignments).toHaveBeenCalledTimes(1);
      const filter = listVisibleAssignments.mock.calls[0]?.[1];
      expect(filter?.activeOnly).toBe(true);
    },
  );

  test("accepts active=false as the full assignment list", async () => {
    const response = await app.request("/?active=false");
    expect(response.status).toBe(200);
    expect(listVisibleAssignments).toHaveBeenCalledTimes(1);
    const filter = listVisibleAssignments.mock.calls[0]?.[1];
    expect(filter?.activeOnly).toBe(false);
  });

  test.each(["TRUE", "FALSE", "1", "0", "yes", "no", "foo", "1e2"])(
    "rejects active=%s before listVisibleAssignments",
    async (token) => {
      const response = await app.request(
        `/?active=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid active");
      expect(listVisibleAssignments).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?active=true&active=true",
    "?active=true&active=false",
    "?active=&active=true",
    "?active=foo&active=true",
  ])(
    "rejects duplicate active values in %s before listVisibleAssignments",
    async (query) => {
      const response = await app.request(`/${query}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid active");
      expect(listVisibleAssignments).not.toHaveBeenCalled();
    },
  );
});
