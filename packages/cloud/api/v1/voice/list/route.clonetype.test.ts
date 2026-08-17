/**
 * Exercises Voice Studio clone-type validation through the HTTP route with
 * mocked authentication and repository boundaries.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

function voiceRow(cloneType: "instant" | "professional") {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: `voice-${cloneType}`,
    elevenlabsVoiceId: `el-${cloneType}`,
    name: `${cloneType} voice`,
    description: null,
    cloneType,
    sampleCount: 1,
    totalAudioDurationSeconds: 1,
    audioQualityScore: "1.00",
    usageCount: 0,
    lastUsedAt: null,
    isActive: true,
    isPublic: false,
    createdAt: now,
    updatedAt: now,
  };
}

const listByOrganization = mock(
  async (
    _organizationId: string,
    _options: {
      includeInactive?: boolean;
      cloneType?: "instant" | "professional";
      limit?: number;
      offset?: number;
    },
  ) => ({
    voices: [voiceRow("instant"), voiceRow("professional")],
    total: 2,
    limit: 50,
    offset: 0,
    hasMore: false,
  }),
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ error: "internal_error" }, 500),
}));
mock.module("@/db/repositories/user-voices", () => ({
  userVoicesRepository: { listByOrganization },
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/v1/voice/list", route);

function listVoices(query = "") {
  return app.request(`/api/v1/voice/list${query}`);
}

describe("GET /api/v1/voice/list clone-kind identity", () => {
  beforeEach(() => {
    listByOrganization.mockClear();
  });

  test.each(["", "?cloneType="])(
    "accepts %s as the unfiltered Voice Studio catalog",
    async (query) => {
      const response = await listVoices(query);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        success: boolean;
        voices: { cloneType: string }[];
      };
      expect(body.success).toBe(true);
      expect(body.voices.map((row) => row.cloneType)).toEqual([
        "instant",
        "professional",
      ]);
      expect(listByOrganization).toHaveBeenCalledTimes(1);
      expect(listByOrganization.mock.calls[0][1]).toMatchObject({
        cloneType: undefined,
      });
    },
  );

  test("accepts cloneType=instant as the instant Voice Studio catalog", async () => {
    listByOrganization.mockResolvedValueOnce({
      voices: [voiceRow("instant")],
      total: 1,
      limit: 50,
      offset: 0,
      hasMore: false,
    });
    const response = await listVoices("?cloneType=instant");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      voices: { cloneType: string }[];
    };
    expect(body.voices.map((row) => row.cloneType)).toEqual(["instant"]);
    expect(listByOrganization).toHaveBeenCalledTimes(1);
    expect(listByOrganization.mock.calls[0][1]).toMatchObject({
      cloneType: "instant",
    });
  });

  test("accepts cloneType=professional as the professional Voice Studio catalog", async () => {
    listByOrganization.mockResolvedValueOnce({
      voices: [voiceRow("professional")],
      total: 1,
      limit: 50,
      offset: 0,
      hasMore: false,
    });
    const response = await listVoices("?cloneType=professional");
    expect(response.status).toBe(200);
    expect(listByOrganization.mock.calls[0][1]).toMatchObject({
      cloneType: "professional",
    });
  });

  test.each(["INSTANT", "PROFESSIONAL", "instant-clone", "foo", "1e2"])(
    "rejects cloneType=%s before listByOrganization",
    async (token) => {
      const response = await listVoices(
        `?cloneType=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid cloneType");
      expect(listByOrganization).not.toHaveBeenCalled();
    },
  );
});
