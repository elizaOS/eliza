/**
 * Exercises the real training-trajectory export Hono route with mocked auth and service boundaries.
 * It pins strict GET and POST limit validation before any trajectory export begins.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const exportAsTrainingJSONL = mock(async () => '{"id":"trajectory-1"}\n');

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { organization_id: "org-1" },
    apiKey: null,
  }),
}));
mock.module("@/lib/services/llm-trajectory", () => ({
  llmTrajectoryService: { exportAsTrainingJSONL },
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/training/trajectories/export", route);

function getExport(query = "") {
  return app.request(`/api/training/trajectories/export${query}`);
}

function postExport(body: unknown) {
  return app.request("/api/training/trajectories/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/training/trajectories/export limit validation", () => {
  beforeEach(() => {
    exportAsTrainingJSONL.mockClear();
  });

  test.each([
    ["", undefined],
    ["?limit=", undefined],
    ["?limit=1", 1],
    ["?limit=37", 37],
    ["?limit=10000", 10000],
  ])("accepts GET %s and forwards %s", async (query, expectedLimit) => {
    const response = await getExport(query);

    expect(response.status).toBe(200);
    expect(
      (await response.json()) as { jsonl: string; lineCount: number },
    ).toEqual({
      jsonl: '{"id":"trajectory-1"}\n',
      lineCount: 1,
    });
    expect(exportAsTrainingJSONL).toHaveBeenCalledWith("org-1", {
      model: undefined,
      purpose: undefined,
      startDate: undefined,
      endDate: undefined,
      limit: expectedLimit,
    });
  });

  test.each([
    ["whitespace", " "],
    ["malformed", "abc"],
    ["zero", "0"],
    ["negative", "-1"],
    ["partial", "12px"],
    ["fractional", "1.5"],
    ["exponent form", "1e2"],
    ["leading zero", "007"],
    ["explicit plus", "+1"],
    ["infinite", "Infinity"],
    ["above maximum", "10001"],
    ["unsafe integer", "9007199254740992"],
  ])("rejects GET %s limit before export", async (_name, limit) => {
    const response = await getExport(`?limit=${encodeURIComponent(limit)}`);

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toEqual({
      error: "Invalid limit",
    });
    expect(exportAsTrainingJSONL).not.toHaveBeenCalled();
  });

  test.each([
    [{}, undefined],
    [{ limit: 1 }, 1],
    [{ limit: 37 }, 37],
    [{ limit: 10000 }, 10000],
  ])("accepts POST body %j and forwards %s", async (body, expectedLimit) => {
    const response = await postExport(body);

    expect(response.status).toBe(200);
    expect(exportAsTrainingJSONL).toHaveBeenCalledWith("org-1", {
      model: undefined,
      purpose: undefined,
      startDate: undefined,
      endDate: undefined,
      limit: expectedLimit,
    });
  });

  test.each([
    ["null", null],
    ["string", "37"],
    ["boolean", true],
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["above maximum", 10001],
    ["array", [37]],
    ["object", { value: 37 }],
  ])("rejects POST %s limit before export", async (_name, limit) => {
    const response = await postExport({ limit });

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toEqual({
      error: "Invalid limit",
    });
    expect(exportAsTrainingJSONL).not.toHaveBeenCalled();
  });

  test("rejects a non-finite POST number before export", async () => {
    const response = await app.request("/api/training/trajectories/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"limit":1e999}',
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toEqual({
      error: "Invalid limit",
    });
    expect(exportAsTrainingJSONL).not.toHaveBeenCalled();
  });
});
