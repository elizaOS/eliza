/**
 * Exercises the real approval-request GET route's public/creator selection.
 * Authentication and persistence are mocked so the suite can assert that
 * invalid or ambiguous query input has no downstream side effects.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";

const approvalRow = {
  id: APPROVAL_ID,
  organizationId: "org-1",
  agentId: "agent-1",
  status: "pending",
  challengeKind: "signature",
  challengePayload: { message: "sign this" },
  signatureText: "secret-signature",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
const getMock = mock(
  async (
    _id: string,
    _organizationId: string,
  ): Promise<typeof approvalRow | null> => null,
);
const getPublicMock = mock(
  async (_id: string): Promise<typeof approvalRow | null> => null,
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/db/repositories/approval-requests", () => ({
  approvalRequestsRepository: {},
}));
mock.module("@/lib/services/approval-requests", () => ({
  createApprovalRequestsService: () => ({
    get: getMock,
    getPublic: getPublicMock,
  }),
  redactApprovalRequestForPublic: (row: typeof approvalRow) => {
    const { signatureText: _signatureText, ...publicRow } = row;
    return publicRow;
  },
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: "standard" },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (
    c: { json: (body: unknown, status: number) => Response },
    _error: unknown,
  ) => c.json({ success: false, error: "internal error" }, 500),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(() => undefined) },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:id", route);

function expectNoLookup() {
  expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
  expect(getMock).not.toHaveBeenCalled();
  expect(getPublicMock).not.toHaveBeenCalled();
}

describe("GET /api/v1/approval-requests/:id public visibility identity", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    getMock.mockClear();
    getPublicMock.mockClear();
    getMock.mockResolvedValue(approvalRow);
    getPublicMock.mockResolvedValue(approvalRow);
  });

  test.each(["", "?public="])(
    "accepts %s as the authenticated creator view",
    async (query) => {
      const response = await app.request(`/${APPROVAL_ID}${query}`);
      expect(response.status).toBe(200);
      expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
      expect(getMock).toHaveBeenCalledWith(APPROVAL_ID, "org-1");
      expect(getPublicMock).not.toHaveBeenCalled();
    },
  );

  test("accepts public=1 as the unauthenticated redacted approval", async () => {
    const response = await app.request(`/${APPROVAL_ID}?public=1`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      approvalRequest: { id: string; signatureText?: string };
    };
    expect(body.success).toBe(true);
    expect(body.approvalRequest.id).toBe(APPROVAL_ID);
    expect(body.approvalRequest.signatureText).toBeUndefined();
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(getPublicMock).toHaveBeenCalledWith(APPROVAL_ID);
    expect(getMock).not.toHaveBeenCalled();
  });

  test.each(["true", "yes", "TRUE", "0", "foo", "1e2"])(
    "rejects public=%s before public or creator lookup",
    async (token) => {
      const response = await app.request(
        `/${APPROVAL_ID}?public=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/public/i);
      expectNoLookup();
    },
  );

  test.each([
    "?public=1&public=true",
    "?public=true&public=1",
    "?public=&public=1",
    "?public=1&public=1",
  ])("rejects ambiguous duplicate query %s before lookup", async (query) => {
    const response = await app.request(`/${APPROVAL_ID}${query}`);
    expect(response.status).toBe(400);
    expectNoLookup();
  });
});
