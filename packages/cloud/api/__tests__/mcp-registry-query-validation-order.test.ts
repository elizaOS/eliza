/**
 * GET /api/mcp/registry — invalid query parameters must cost zero lookups.
 *
 * The public registry runs an optional getCurrentUser() lookup and a community
 * userMcpsService.listPublic() lookup. An invalid request such as ?limit=0 has
 * an already-determined 400, so neither lookup should be started: the auth
 * catch only degrades a failed lookup to anonymous, it cannot un-spend the
 * work (#24791). Drives the real Hono handler with both boundaries counted.
 */

import { describe, expect, mock, test } from "bun:test";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as userMcpsActual from "@/lib/services/user-mcps";
import * as loggerActual from "@/lib/utils/logger";

let authLookups = 0;
let communityLookups = 0;

const listPublic = mock(async () => {
  communityLookups += 1;
  return [] as unknown[];
});

// Object.create keeps the real instance as prototype so every other method
// still resolves — only listPublic is shadowed.
const mockUserMcpsService = Object.create(userMcpsActual.userMcpsService);
mockUserMcpsService.listPublic = listPublic;

mock.module("@/lib/services/user-mcps", () => ({
  ...userMcpsActual,
  userMcpsService: mockUserMcpsService,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  getCurrentUser: mock(async () => {
    authLookups += 1;
    return null;
  }),
}));

mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

const registryRoute = (await import("../mcp/registry/route")) as {
  default: { fetch: (req: Request, env?: unknown) => Promise<Response> };
};

const ENV = { NODE_ENV: "test", NEXT_PUBLIC_APP_URL: "https://test.local" };

function get(query = ""): Promise<Response> {
  return registryRoute.default.fetch(
    new Request(`http://test.local/${query}`, { method: "GET" }),
    ENV,
  );
}

function reset(): void {
  authLookups = 0;
  communityLookups = 0;
}

describe("GET /api/mcp/registry query validation ordering", () => {
  test("rejects ?limit=0 with a 400 and zero lookup effects", async () => {
    reset();
    const response = await get("?limit=0");

    expect(response.status).toBe(400);
    // The rejection is fully determined by the query string, so neither
    // optional auth nor the community registry may have been consulted.
    expect(authLookups).toBe(0);
    expect(communityLookups).toBe(0);

    const body = (await response.json()) as {
      error: string;
      details: Array<{ field: string }>;
    };
    expect(body.error).toBe("Invalid query parameters");
    expect(body.details.some((issue) => issue.field === "limit")).toBe(true);
  });

  test.each([
    ["?limit=0", "limit"],
    ["?limit=101", "limit"],
    ["?limit=abc", "limit"],
    ["?category=not-a-category", "category"],
    ["?status=not-a-status", "status"],
    [`?search=${"x".repeat(101)}`, "search"],
  ])("rejects %s before any lookup", async (query, field) => {
    reset();
    const response = await get(query);

    expect(response.status).toBe(400);
    expect(authLookups).toBe(0);
    expect(communityLookups).toBe(0);

    const body = (await response.json()) as {
      details: Array<{ field: string }>;
    };
    expect(body.details.some((issue) => issue.field === field)).toBe(true);
  });

  test("preserves the valid-query response, auth flag, and lookup count", async () => {
    reset();
    const response = await get("?limit=5&category=data&status=live");

    expect(response.status).toBe(200);
    // A valid query must still spend exactly one optional auth lookup and one
    // community lookup — this guards against over-rejection.
    expect(authLookups).toBe(1);
    expect(communityLookups).toBe(1);

    const body = (await response.json()) as {
      isAuthenticated: boolean;
      appliedFilters: {
        category: string | null;
        status: string | null;
        limit: number;
      };
    };
    expect(body.isAuthenticated).toBe(false);
    expect(body.appliedFilters).toMatchObject({
      category: "data",
      status: "live",
      limit: 5,
    });
  });

  test("an omitted query still resolves defaults and performs both lookups", async () => {
    reset();
    const response = await get();

    expect(response.status).toBe(200);
    expect(authLookups).toBe(1);
    expect(communityLookups).toBe(1);

    const body = (await response.json()) as {
      appliedFilters: {
        category: string | null;
        status: string | null;
        limit: number;
      };
    };
    // "all" is reported as null by the existing contract.
    expect(body.appliedFilters).toMatchObject({
      category: null,
      status: null,
      limit: 100,
    });
  });
});
