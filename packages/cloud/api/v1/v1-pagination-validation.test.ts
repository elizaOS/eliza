/**
 * Direct production-parser coverage plus route 400 / pass-through tests for
 * Cloud API v1 pagination. The four list routes must share one parser and
 * reject invalid limit/offset before any service call.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { parsePaginationParam } from "./pagination";

const authenticatedUser = {
  id: "user-1",
  organization_id: "org-1",
};
const listLedger = mock(async () => []);
const listBallots = mock(async () => []);
const listOAuthIntents = mock(async () => []);
const listGenerations = mock(async () => []);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: mock(async () => authenticatedUser),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_c: unknown, error: unknown) => {
    throw error;
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(() => undefined) },
}));
mock.module("@/lib/services/active-billing", () => ({
  activeBillingService: { listLedger },
}));
mock.module("@/db/repositories/secret-ballots", () => ({
  secretBallotsRepository: {},
}));
mock.module("@/lib/services/secret-ballots", () => ({
  createSecretBallotsService: () => ({
    create: mock(async () => ({})),
    list: listBallots,
  }),
}));
mock.module("@/lib/services/oauth-intents-default", () => ({
  getOAuthIntentsService: () => ({
    create: mock(async () => ({})),
    list: listOAuthIntents,
  }),
}));
mock.module("@/lib/services/generations", () => ({
  generationsService: {
    listByOrganizationAndStatusSummary: listGenerations,
  },
}));

const { default: billingLedgerRoute } = await import("./billing/ledger/route");
const { default: ballotsRoute } = await import("./ballots/route");
const { default: oauthIntentsRoute } = await import("./oauth-intents/route");
const { default: galleryRoute } = await import("./gallery/route");

const invalidLimitQueries = [
  ["malformed exponent", "limit=1e2", "1e2"],
  ["negative", "limit=-1", "-1"],
  ["over the ceiling", "limit=501", "501"],
  ["huge", "limit=999999999999999999999999", "999999999999999999999999"],
  ["trailing junk", "limit=12px", "12px"],
  ["surrounding whitespace", "limit=%2037%20", " 37 "],
  ["leading zero", "limit=007", "007"],
] as const;

const invalidOffsetQueries = [
  ["negative", "offset=-1", "-1"],
  ["malformed exponent", "offset=1e2", "1e2"],
  ["trailing junk", "offset=12px", "12px"],
  ["unsafe integer", "offset=9007199254740992", "9007199254740992"],
] as const;

describe("parsePaginationParam", () => {
  it.each([
    [undefined, "limit", 50, 50],
    ["", "limit", 50, 50],
    ["   ", "offset", 0, 0],
    ["0", "offset", 0, 0],
    ["500", "limit", 50, 500],
    ["9007199254740991", "offset", 0, 9007199254740991],
  ] as const)(
    "accepts %s as %s defaulting %s",
    (raw, parameter, defaultValue, expected) => {
      expect(parsePaginationParam(raw, parameter, defaultValue)).toEqual({
        ok: true,
        value: expected,
      });
    },
  );

  it.each([
    "0",
    "-1",
    "+1",
    "1.5",
    "1e2",
    "007",
    "501",
    "12px",
    " 37 ",
  ] as const)("rejects invalid limit %s", (value) => {
    const result = parsePaginationParam(value, "limit", 50);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("limit");
    expect(result.error).toContain(value);
  });

  it.each([
    "-1",
    "+1",
    "1.5",
    "1e2",
    "007",
    "12px",
    "9007199254740992",
  ] as const)("rejects invalid offset %s", (value) => {
    const result = parsePaginationParam(value, "offset", 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("offset");
    expect(result.error).toContain(value);
  });
});

async function expectInvalid(
  route: { request: (input: string) => Response | Promise<Response> },
  query: string,
  parameter: "limit" | "offset",
  offendingValue: string,
) {
  const response = await route.request(`http://localhost/?${query}`);
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: string };
  expect(body.error).toContain(parameter);
  expect(body.error).toContain(offendingValue);
}

beforeEach(() => {
  listLedger.mockClear();
  listBallots.mockClear();
  listOAuthIntents.mockClear();
  listGenerations.mockClear();
});

describe("billing ledger pagination", () => {
  for (const [name, query, value] of invalidLimitQueries) {
    it(`rejects ${name}`, async () => {
      await expectInvalid(billingLedgerRoute, query, "limit", value);
      expect(listLedger).not.toHaveBeenCalled();
    });
  }

  it("passes an exact valid limit to the billing service", async () => {
    const response = await billingLedgerRoute.request(
      "http://localhost/?limit=37",
    );
    expect(response.status).toBe(200);
    expect(listLedger).toHaveBeenCalledWith("org-1", 37);
  });

  it("treats blank limit as the documented default", async () => {
    const response = await billingLedgerRoute.request(
      "http://localhost/?limit=%20%20",
    );
    expect(response.status).toBe(200);
    expect(listLedger).toHaveBeenCalledWith("org-1", 50);
  });
});

function paginationRouteTests(
  name: string,
  route: { request: (input: string) => Response | Promise<Response> },
  serviceMock: ReturnType<typeof mock>,
) {
  describe(`${name} pagination`, () => {
    for (const [caseName, query, value] of [
      ...invalidLimitQueries,
      ...invalidOffsetQueries,
    ]) {
      const parameter = query.startsWith("limit=") ? "limit" : "offset";
      it(`rejects ${parameter} ${caseName}`, async () => {
        await expectInvalid(route, query, parameter, value);
        expect(serviceMock).not.toHaveBeenCalled();
      });
    }
  });
}

paginationRouteTests("ballots", ballotsRoute, listBallots);
paginationRouteTests("oauth intents", oauthIntentsRoute, listOAuthIntents);
paginationRouteTests("gallery", galleryRoute, listGenerations);

describe("ballots pagination pass-through", () => {
  it("passes exact parsed values", async () => {
    const response = await ballotsRoute.request(
      "http://localhost/?limit=37&offset=12",
    );
    expect(response.status).toBe(200);
    expect(listBallots).toHaveBeenCalledWith("org-1", {
      limit: 37,
      offset: 12,
    });
  });

  it("uses defaults for blank values", async () => {
    const response = await ballotsRoute.request(
      "http://localhost/?limit=%20&offset=%20",
    );
    expect(response.status).toBe(200);
    expect(listBallots).toHaveBeenCalledWith("org-1", {
      limit: 50,
      offset: 0,
    });
  });
});

describe("oauth intents pagination pass-through", () => {
  it("passes exact parsed values", async () => {
    const response = await oauthIntentsRoute.request(
      "http://localhost/?limit=37&offset=12",
    );
    expect(response.status).toBe(200);
    expect(listOAuthIntents).toHaveBeenCalledWith("org-1", {
      status: undefined,
      provider: undefined,
      agentId: undefined,
      limit: 37,
      offset: 12,
    });
  });

  it("uses defaults for blank values", async () => {
    const response = await oauthIntentsRoute.request(
      "http://localhost/?limit=%20&offset=%20",
    );
    expect(response.status).toBe(200);
    expect(listOAuthIntents).toHaveBeenCalledWith("org-1", {
      status: undefined,
      provider: undefined,
      agentId: undefined,
      limit: 50,
      offset: 0,
    });
  });
});

describe("gallery pagination pass-through", () => {
  it("passes exact values, including the existing lookahead", async () => {
    const response = await galleryRoute.request(
      "http://localhost/?limit=37&offset=12",
    );
    expect(response.status).toBe(200);
    expect(listGenerations).toHaveBeenCalledWith("org-1", "completed", {
      userId: "user-1",
      type: undefined,
      requireStorageUrl: true,
      limit: 38,
      offset: 12,
    });
    expect(await response.json()).toMatchObject({ limit: 37, offset: 12 });
  });

  it("uses defaults for blank values", async () => {
    const response = await galleryRoute.request(
      "http://localhost/?limit=%20&offset=%20",
    );
    expect(response.status).toBe(200);
    expect(listGenerations).toHaveBeenCalledWith("org-1", "completed", {
      userId: "user-1",
      type: undefined,
      requireStorageUrl: true,
      limit: 101,
      offset: 0,
    });
    expect(await response.json()).toMatchObject({ limit: 100, offset: 0 });
  });
});
