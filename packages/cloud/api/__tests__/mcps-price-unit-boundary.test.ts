/**
 * Exercises the real `/api/v1/mcps` create and update handlers to prove the
 * dual-unit price guard at the route boundary uses the same quantized
 * conversion as `userMcpsService`.
 *
 * A raw `priceUsd * 100` comparison accepts values that the service then
 * rejects with `MCP_PRICE_UNIT_CONFLICT`, turning a bad request into a 500.
 * The service-side rule is covered by
 * `packages/cloud/shared/src/lib/services/user-mcps.test.ts`; here the request
 * must never reach the service at all. Auth and the service are substituted;
 * the Hono handlers and their zod schemas are real.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { organizationCreditsToLegacyMcpPoints } from "@elizaos/cloud-shared/billing";
import { Hono } from "hono";

const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const MCP_ID = "44444444-4444-4444-4444-444444444444";

/** Price pair that agrees in raw float arithmetic but not on the stored grid. */
const DIVERGENT_PRICE = { priceUsd: 0.0000151, creditsPerRequest: 0.00151 };

const createCalls: unknown[] = [];
const updateCalls: unknown[] = [];

const storedMcp = {
  id: MCP_ID,
  name: "Weather Pro",
  organization_id: ORG,
  pricing_type: "credits" as const,
  credits_per_request: "1.25",
};

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: mock(async () => ({
    id: USER,
    organization_id: ORG,
  })),
}));
mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: mock(async () => ({
    user: { id: USER, organization_id: ORG },
  })),
}));
mock.module("@/lib/services/user-mcps", () => ({
  userMcpsService: {
    create: mock(async (params: unknown) => {
      createCalls.push(params);
      return storedMcp;
    }),
    update: mock(async (_id: string, _org: string, params: unknown) => {
      updateCalls.push(params);
      return storedMcp;
    }),
    toApiMcp: mock((mcp: unknown) => mcp),
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { debug: mock(), error: mock(), info: mock(), warn: mock() },
}));

const mcpsRoute = (await import("../v1/mcps/route")).default;
const mcpRoute = (await import("../v1/mcps/[mcpId]/route")).default;

const app = new Hono();
app.route("/api/v1/mcps", mcpsRoute);
app.route("/api/v1/mcps/:mcpId", mcpRoute);

function postBody(body: Record<string, unknown>): Request {
  return new Request("http://cloud.test/api/v1/mcps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Weather Pro",
      slug: "weather-pro",
      description: "Real-time weather data",
      pricingType: "credits",
      ...body,
    }),
  });
}

function putBody(body: Record<string, unknown>): Request {
  return new Request(`http://cloud.test/api/v1/mcps/${MCP_ID}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  createCalls.length = 0;
  updateCalls.length = 0;
});

describe("v1 MCP dual-unit price boundary", () => {
  test("the divergent pair is exactly the case a raw ×100 check would accept", () => {
    expect(
      Math.abs(
        DIVERGENT_PRICE.priceUsd * 100 - DIVERGENT_PRICE.creditsPerRequest,
      ),
    ).toBeLessThanOrEqual(1e-9);
    expect(organizationCreditsToLegacyMcpPoints(DIVERGENT_PRICE.priceUsd)).toBe(
      0.0015,
    );
    expect(
      Math.abs(
        organizationCreditsToLegacyMcpPoints(DIVERGENT_PRICE.priceUsd) -
          DIVERGENT_PRICE.creditsPerRequest,
      ),
    ).toBeGreaterThan(1e-9);
  });

  test("POST rejects the divergent pair with 400 and never calls the service", async () => {
    const response = await app.request(postBody(DIVERGENT_PRICE));

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: Array<{ field: string; message: string }>;
    };
    expect(body.error).toBe("Invalid request body");
    expect(body.details.map((issue) => issue.field)).toContain(
      "creditsPerRequest",
    );
    expect(createCalls).toHaveLength(0);
  });

  test("PUT rejects the divergent pair with 400 and never calls the service", async () => {
    const response = await app.request(putBody(DIVERGENT_PRICE));

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      details: Array<{ field: string }>;
    };
    expect(body.details.map((issue) => issue.field)).toContain(
      "creditsPerRequest",
    );
    expect(updateCalls).toHaveLength(0);
  });

  test("a pair that agrees on the stored grid still reaches the service", async () => {
    const createResponse = await app.request(
      postBody({ priceUsd: 0.0125, creditsPerRequest: 1.25 }),
    );
    expect(createResponse.status).toBe(201);
    expect(createCalls).toHaveLength(1);

    const updateResponse = await app.request(
      putBody({ priceUsd: 0.0125, creditsPerRequest: 1.25 }),
    );
    expect(updateResponse.status).toBe(200);
    expect(updateCalls).toHaveLength(1);
  });

  test("an unambiguously conflicting pair is still rejected", async () => {
    const response = await app.request(
      postBody({ priceUsd: 1, creditsPerRequest: 1 }),
    );
    expect(response.status).toBe(400);
    expect(createCalls).toHaveLength(0);
  });
});
