/**
 * GET /api/v1/voice/list `includeInactive` is Voice Studio
 * inactive-row identity, not leftover tax on cloneType (#21047) or
 * prefix-coerced limit. Stock develop treated any non-exact `true`
 * token as hide-inactive, so `includeInactive=TRUE` still listed
 * only live clones instead of a 400.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

function voiceRow(cloneType: "instant" | "professional", isActive = true) {
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
    isActive,
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

describe("GET /api/v1/voice/list includeInactive identity", () => {
  beforeEach(() => {
    listByOrganization.mockClear();
  });

  test.each(["", "?includeInactive=", "?includeInactive=false"])(
    "accepts %s as the live Voice Studio catalog",
    async (query) => {
      const response = await listVoices(query);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { success: boolean };
      expect(body.success).toBe(true);
      expect(listByOrganization).toHaveBeenCalledTimes(1);
      expect(listByOrganization.mock.calls[0][1]).toMatchObject({
        includeInactive: false,
      });
    },
  );

  test("accepts includeInactive=true as the full Voice Studio catalog", async () => {
    listByOrganization.mockResolvedValueOnce({
      voices: [
        voiceRow("instant", true),
        voiceRow("professional", false),
      ],
      total: 2,
      limit: 50,
      offset: 0,
      hasMore: false,
    });
    const response = await listVoices("?includeInactive=true");
    expect(response.status).toBe(200);
    expect(listByOrganization).toHaveBeenCalledTimes(1);
    expect(listByOrganization.mock.calls[0][1]).toMatchObject({
      includeInactive: true,
    });
  });

  test.each(["FALSE", "TRUE", "0", "1", "no", "yes", "foo"])(
    "rejects includeInactive=%s before listByOrganization",
    async (token) => {
      const response = await listVoices(
        `?includeInactive=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid includeInactive");
      expect(listByOrganization).not.toHaveBeenCalled();
    },
  );
});
