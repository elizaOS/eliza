/** Exercises Vertex persisted-job filter validation at the HTTP boundary. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: {
    id: "user-1",
    organization_id: "org-1",
  },
}));
const listVisibleJobs = mock(async () => [{ id: "tracked-1" }]);
const syncJobStatus = mock(async () => null);
const listTuningJobs = mock(async () => [{ name: "remote-1" }]);
const getTuningJobStatus = mock(async () => ({ name: "remote-1" }));

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
}));
mock.module("@/lib/services/vertex-model-registry", () => ({
  vertexModelRegistryService: { listVisibleJobs, syncJobStatus },
}));
mock.module("@/lib/services/vertex-tuning", () => ({
  listTuningJobs,
  getTuningJobStatus,
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/training/vertex/jobs", route);

function getJobs(query = "") {
  return app.request(`/api/training/vertex/jobs${query}`);
}

describe("GET /api/training/vertex/jobs persisted identity", () => {
  beforeEach(() => {
    requireAuthOrApiKeyWithOrg.mockClear();
    listVisibleJobs.mockClear();
    syncJobStatus.mockClear();
    listTuningJobs.mockClear();
    getTuningJobStatus.mockClear();
  });

  test.each([
    "?projectId=proj",
    "?projectId=proj&persisted=",
    "?projectId=proj&persisted=false",
  ])("accepts %s as the full remote+persisted Vertex list", async (query) => {
    const response = await getJobs(query);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      jobs: unknown[];
      persistedJobs: unknown[];
    };
    expect(body.jobs).toEqual([{ name: "remote-1" }]);
    expect(body.persistedJobs).toEqual([{ id: "tracked-1" }]);
    expect(requireAuthOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(listVisibleJobs).toHaveBeenCalledTimes(1);
    expect(listTuningJobs).toHaveBeenCalledTimes(1);
    expect(syncJobStatus).not.toHaveBeenCalled();
  });

  test("accepts persisted=true as the persisted-only Vertex list", async () => {
    const response = await getJobs("?persisted=true");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      persistedJobs: unknown[];
      jobs?: unknown[];
    };
    expect(body.persistedJobs).toEqual([{ id: "tracked-1" }]);
    expect(body.jobs).toBeUndefined();
    expect(requireAuthOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(listVisibleJobs).toHaveBeenCalledTimes(1);
    expect(listTuningJobs).not.toHaveBeenCalled();
    expect(syncJobStatus).not.toHaveBeenCalled();
  });

  test.each(["FALSE", "TRUE", "0", "1", "no", "yes", "foo", "1e2"])(
    "rejects persisted=%s before job lookup and remote list",
    async (token) => {
      const response = await getJobs(
        `?persisted=${encodeURIComponent(token)}&jobId=tracked-1&projectId=proj`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid persisted");
      expect(listVisibleJobs).not.toHaveBeenCalled();
      expect(listTuningJobs).not.toHaveBeenCalled();
      expect(syncJobStatus).not.toHaveBeenCalled();
      expect(getTuningJobStatus).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?persisted=true&persisted=true",
    "?persisted=true&persisted=false",
    "?persisted=&persisted=true",
    "?persisted=foo&persisted=true",
  ])(
    "rejects duplicate persisted values in %s before job lookup",
    async (query) => {
      const response = await getJobs(`${query}&projectId=proj`);
      expect(response.status).toBe(400);
      expect(listVisibleJobs).not.toHaveBeenCalled();
      expect(listTuningJobs).not.toHaveBeenCalled();
      expect(syncJobStatus).not.toHaveBeenCalled();
    },
  );
});
