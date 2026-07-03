/**
 * Unit tests for /api/moderation/reports
 *
 * Mirrors the mocking style of the sibling route tests
 * (e.g. api/chats/unread-count/__tests__/route.test.ts): stub @feed/api,
 * @feed/db and @feed/shared so the route logic can be exercised without a
 * real database or auth stack.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

const mockAuthenticate = mock();
const mockRequirePermission = mock();
const mockEvaluateReport = mock();

const mockReportCreate = mock();
const mockReportFindMany = mock();
const mockReportCount = mock();
const mockUserFindUnique = mock();
const mockPostFindUnique = mock();

// Re-use the real zod schemas so validation behaviour is covered end-to-end.
mock.module("@feed/api", () => ({
  authenticate: mockAuthenticate,
  requirePermission: mockRequirePermission,
  evaluateReport: mockEvaluateReport,
  successResponse: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status }),
  withErrorHandling:
    (handler: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      try {
        return await handler(...args);
      } catch (error) {
        const name = (error as { name?: string })?.name;
        // Mirror the real error-handler status mapping used by the routes.
        if (name === "AuthenticationError") {
          return new Response(
            JSON.stringify({ error: (error as Error).message }),
            { status: 401 },
          );
        }
        if (name === "AuthorizationError") {
          return new Response(
            JSON.stringify({ error: (error as Error).message }),
            { status: 403 },
          );
        }
        if (name === "ZodError") {
          return new Response(
            JSON.stringify({ error: "Validation failed" }),
            { status: 400 },
          );
        }
        throw error;
      }
    },
}));

mock.module("@feed/db", () => ({
  db: {
    report: {
      create: mockReportCreate,
      findMany: mockReportFindMany,
      count: mockReportCount,
    },
    user: { findUnique: mockUserFindUnique },
    post: { findUnique: mockPostFindUnique },
  },
}));

// generateSnowflakeId + logger are the only @feed/shared runtime deps the route
// touches beyond the zod schemas, which we keep real.
const actualShared = await import("@feed/shared");
mock.module("@feed/shared", () => ({
  ...actualShared,
  generateSnowflakeId: async () => "snowflake-1",
  logger: { error: () => {}, info: () => {}, warn: () => {} },
}));

const { POST, GET } = await import("./route");

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/moderation/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(query = ""): Request {
  return new Request(`http://localhost/api/moderation/reports${query}`);
}

class AuthenticationError extends Error {
  name = "AuthenticationError";
}
class AuthorizationError extends Error {
  name = "AuthorizationError";
}

beforeEach(() => {
  mockAuthenticate.mockReset();
  mockRequirePermission.mockReset();
  mockEvaluateReport.mockReset();
  mockReportCreate.mockReset();
  mockReportFindMany.mockReset();
  mockReportCount.mockReset();
  mockUserFindUnique.mockReset();
  mockPostFindUnique.mockReset();
  mockEvaluateReport.mockResolvedValue(undefined);
});

describe("POST /api/moderation/reports", () => {
  it("returns 401 when unauthenticated", async () => {
    mockAuthenticate.mockRejectedValue(new AuthenticationError("no auth"));
    const res = (await POST(
      postRequest({
        reportType: "user",
        reportedUserId: "u2",
        category: "harassment",
        reason: "this is a long enough reason",
      }),
    )) as Response;
    expect(res.status).toBe(401);
    expect(mockReportCreate).not.toHaveBeenCalled();
  });

  it("creates a user report and feeds the evaluation pipeline", async () => {
    mockAuthenticate.mockResolvedValue({ userId: "reporter-1" });
    mockUserFindUnique.mockResolvedValue({ id: "u2" });
    mockReportCreate.mockImplementation(async ({ data }: { data: unknown }) => ({
      ...(data as Record<string, unknown>),
    }));

    const res = (await POST(
      postRequest({
        reportType: "user",
        reportedUserId: "u2",
        category: "harassment",
        reason: "this is a long enough reason",
      }),
    )) as Response;

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.report.reporterId).toBe("reporter-1");
    expect(body.report.reportedUserId).toBe("u2");
    expect(body.report.reportedPostId).toBeNull();
    expect(body.report.status).toBe("pending");
    expect(body.report.priority).toBe("normal");
    expect(mockEvaluateReport).toHaveBeenCalledWith("snowflake-1");
  });

  it("assigns high priority to severe categories", async () => {
    mockAuthenticate.mockResolvedValue({ userId: "reporter-1" });
    mockUserFindUnique.mockResolvedValue({ id: "u2" });
    mockReportCreate.mockImplementation(async ({ data }: { data: unknown }) => ({
      ...(data as Record<string, unknown>),
    }));

    const res = (await POST(
      postRequest({
        reportType: "user",
        reportedUserId: "u2",
        category: "violence",
        reason: "this is a long enough reason",
      }),
    )) as Response;

    const body = await res.json();
    expect(body.report.priority).toBe("high");
  });

  it("creates a post report", async () => {
    mockAuthenticate.mockResolvedValue({ userId: "reporter-1" });
    mockPostFindUnique.mockResolvedValue({ id: "p9" });
    mockReportCreate.mockImplementation(async ({ data }: { data: unknown }) => ({
      ...(data as Record<string, unknown>),
    }));

    const res = (await POST(
      postRequest({
        reportType: "post",
        reportedPostId: "p9",
        category: "spam",
        reason: "this is a long enough reason",
      }),
    )) as Response;

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.report.reportedPostId).toBe("p9");
    expect(body.report.reportedUserId).toBeNull();
    expect(body.report.priority).toBe("low");
  });

  it("rejects self-reports", async () => {
    mockAuthenticate.mockResolvedValue({ userId: "u2" });
    const res = (await POST(
      postRequest({
        reportType: "user",
        reportedUserId: "u2",
        category: "harassment",
        reason: "this is a long enough reason",
      }),
    )) as Response;
    expect(res.status).toBe(400);
    expect(mockReportCreate).not.toHaveBeenCalled();
  });

  it("returns 404 when reported user does not exist", async () => {
    mockAuthenticate.mockResolvedValue({ userId: "reporter-1" });
    mockUserFindUnique.mockResolvedValue(null);
    const res = (await POST(
      postRequest({
        reportType: "user",
        reportedUserId: "ghost",
        category: "harassment",
        reason: "this is a long enough reason",
      }),
    )) as Response;
    expect(res.status).toBe(404);
    expect(mockReportCreate).not.toHaveBeenCalled();
  });

  it("returns 404 when reported post does not exist", async () => {
    mockAuthenticate.mockResolvedValue({ userId: "reporter-1" });
    mockPostFindUnique.mockResolvedValue(null);
    const res = (await POST(
      postRequest({
        reportType: "post",
        reportedPostId: "ghost",
        category: "spam",
        reason: "this is a long enough reason",
      }),
    )) as Response;
    expect(res.status).toBe(404);
  });

  it("returns 400 on invalid payload (reason too short)", async () => {
    mockAuthenticate.mockResolvedValue({ userId: "reporter-1" });
    const res = (await POST(
      postRequest({
        reportType: "user",
        reportedUserId: "u2",
        category: "harassment",
        reason: "short",
      }),
    )) as Response;
    expect(res.status).toBe(400);
    expect(mockReportCreate).not.toHaveBeenCalled();
  });

  it("returns 400 on unknown category enum", async () => {
    mockAuthenticate.mockResolvedValue({ userId: "reporter-1" });
    const res = (await POST(
      postRequest({
        reportType: "user",
        reportedUserId: "u2",
        category: "not_a_category",
        reason: "this is a long enough reason",
      }),
    )) as Response;
    expect(res.status).toBe(400);
  });

  it("still succeeds when the evaluation pipeline throws", async () => {
    mockAuthenticate.mockResolvedValue({ userId: "reporter-1" });
    mockUserFindUnique.mockResolvedValue({ id: "u2" });
    mockReportCreate.mockImplementation(async ({ data }: { data: unknown }) => ({
      ...(data as Record<string, unknown>),
    }));
    mockEvaluateReport.mockRejectedValue(new Error("AI down"));

    const res = (await POST(
      postRequest({
        reportType: "user",
        reportedUserId: "u2",
        category: "harassment",
        reason: "this is a long enough reason",
      }),
    )) as Response;

    expect(res.status).toBe(201);
  });
});

describe("GET /api/moderation/reports", () => {
  it("returns 401 when unauthenticated", async () => {
    mockRequirePermission.mockRejectedValue(
      new AuthenticationError("no auth"),
    );
    const res = (await GET(getRequest())) as Response;
    expect(res.status).toBe(401);
  });

  it("returns 403 when missing view_reports permission", async () => {
    mockRequirePermission.mockRejectedValue(
      new AuthorizationError("Permission required: view_reports"),
    );
    const res = (await GET(getRequest())) as Response;
    expect(res.status).toBe(403);
  });

  it("lists reports with pagination for permitted admins", async () => {
    mockRequirePermission.mockResolvedValue({
      userId: "admin-1",
      permissions: ["view_reports"],
    });
    mockReportFindMany.mockResolvedValue([{ id: "r1" }, { id: "r2" }]);
    mockReportCount.mockResolvedValue(2);

    const res = (await GET(
      getRequest("?status=pending&limit=10"),
    )) as Response;

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reports).toHaveLength(2);
    expect(body.pagination.total).toBe(2);
    expect(body.pagination.limit).toBe(10);
    // status filter must be forwarded to the query.
    const call = mockReportFindMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(call.where.status).toBe("pending");
  });

  it("requires the view_reports permission specifically", async () => {
    mockRequirePermission.mockResolvedValue({ userId: "admin-1" });
    mockReportFindMany.mockResolvedValue([]);
    mockReportCount.mockResolvedValue(0);

    await GET(getRequest());

    expect(mockRequirePermission.mock.calls[0][1]).toBe("view_reports");
  });
});
