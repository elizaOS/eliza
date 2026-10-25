/**
 * Real loopback-HTTP contract tests for the Instacart products-link request,
 * bounded response handling, secret transport, and honest link-only receipt.
 */
import { once } from "node:events";
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildInstacartProductsLinkRequest,
  InstacartProductsLinkClient,
} from "./instacart.js";
import { buildShoppingListContent, evaluateMealPlan } from "./planner.js";
import type { FoodShoppingListContent } from "./types.js";

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

const servers = new Set<http.Server>();

async function readRequest(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void>,
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((request, response) => {
    void handler(request, response);
  });
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("loopback test server did not expose a TCP address");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) {
    servers.delete(server);
    return;
  }
  server.close();
  await once(server, "close");
  servers.delete(server);
}

function shoppingContent(): FoodShoppingListContent {
  const evaluation = evaluateMealPlan({
    householdId: "household-main",
    plannedFor: "2027-03-12T18:00:00.000Z",
    meal: {
      mealId: "meal-tacos",
      title: "Taco night",
      baseServings: 2,
      tags: ["family_favorite"],
      leftoverInventoryItemId: null,
      ingredients: [
        {
          itemId: "tortillas",
          name: "corn tortillas",
          quantity: 1,
          unit: "package",
          dietaryTags: ["gluten_free", "organic"],
          allergenTags: [],
          ageRiskTags: [],
          safetyEvidence: "verified_label",
          upcs: ["000000000012"],
          brandFilters: ["Mi Rancho"],
        },
      ],
    },
    participants: [
      {
        entityId: "owner",
        portionServings: 1,
        attendanceProvenance: {
          kind: "connector",
          sourceId: "calendar-headcount",
          sourceRevision: 1,
          observedAt: "2027-03-12T12:00:00.000Z",
          evidenceRef: "calendar:event:owner",
          confidence: 1,
        },
      },
      {
        entityId: "child-a",
        portionServings: 1,
        attendanceProvenance: {
          kind: "connector",
          sourceId: "custody-headcount",
          sourceRevision: 1,
          observedAt: "2027-03-12T12:00:00.000Z",
          evidenceRef: "calendar:event:child-a",
          confidence: 1,
        },
      },
    ],
    constraints: [],
    preferences: [],
    inventory: [],
  });
  return buildShoppingListContent(evaluation);
}

afterEach(async () => {
  await Promise.all(Array.from(servers).map(closeServer));
});

describe("Instacart products-link HTTP boundary", () => {
  it("uses the current line_item_measurements contract and returns only a shopping-list link receipt", async () => {
    let captureRequest: (request: CapturedRequest) => void = () => {};
    const captured = new Promise<CapturedRequest>((resolve) => {
      captureRequest = resolve;
    });
    const { server, baseUrl } = await startServer(async (request, response) => {
      captureRequest({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: await readRequest(request),
      });
      response.writeHead(200, {
        "content-type": "application/json",
        "x-request-id": "instacart-request-1",
      });
      response.end(
        JSON.stringify({
          products_link_url:
            "https://www.instacart.com/store/shopping-list/abc123",
        }),
      );
    });
    const secret = "test-instacart-key-never-persist";
    const client = new InstacartProductsLinkClient({
      apiKey: secret,
      testBaseUrl: baseUrl,
    });

    const receipt = await client.createProductsLink(shoppingContent());
    const request = await captured;
    const body = JSON.parse(request.body) as {
      link_type: string;
      line_items: Array<Record<string, unknown>>;
    };

    expect(request.method).toBe("POST");
    expect(request.url).toBe("/idp/v1/products/products_link");
    expect(request.headers.authorization).toBe(`Bearer ${secret}`);
    expect(request.headers.accept).toBe("application/json");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(body.link_type).toBe("shopping_list");
    expect(body.line_items[0]).toEqual(
      expect.objectContaining({
        name: "corn tortillas",
        display_text: "corn tortillas",
        line_item_measurements: [{ quantity: 1, unit: "package" }],
        upcs: ["000000000012"],
        filters: {
          brand_filters: ["Mi Rancho"],
          health_filters: ["GLUTEN_FREE", "ORGANIC"],
        },
      }),
    );
    expect(body.line_items[0]).not.toHaveProperty("quantity");
    expect(body.line_items[0]).not.toHaveProperty("unit");
    expect(receipt).toEqual({
      kind: "shopping_list_link",
      productsLinkUrl: "https://www.instacart.com/store/shopping-list/abc123",
      httpStatus: 200,
      requestId: "instacart-request-1",
    });
    expect(receipt).not.toHaveProperty("cart");
    expect(receipt).not.toHaveProperty("order");
    expect(receipt).not.toHaveProperty("checkout");
    expect(JSON.stringify(receipt)).not.toContain(secret);
    await closeServer(server);
  });

  it("rejects deprecated or unsupported measurement assumptions before transport", () => {
    const content = shoppingContent();
    content.lines[0] = {
      ...content.lines[0],
      unit: "serving",
    };
    expect(() => buildInstacartProductsLinkRequest(content)).toThrowError(
      expect.objectContaining({ code: "FOOD_INVALID_CONTRACT" }),
    );
  });

  it("classifies rate limits without copying provider or secret bytes into the error", async () => {
    const { server, baseUrl } = await startServer(async (request, response) => {
      await readRequest(request);
      response.writeHead(429, {
        "content-type": "application/json",
        "x-request-id": "limited-request",
      });
      response.end(
        JSON.stringify({
          error: "sensitive provider diagnostic that must not escape",
        }),
      );
    });
    const secret = "secret-rate-limit-key";
    const client = new InstacartProductsLinkClient({
      apiKey: secret,
      testBaseUrl: baseUrl,
    });

    const error = await client
      .createProductsLink(shoppingContent())
      .catch((caught: unknown) => caught);
    expect(error).toEqual(
      expect.objectContaining({
        code: "FOOD_PROVIDER_RATE_LIMITED",
        context: {
          httpStatus: 429,
          requestId: "limited-request",
        },
      }),
    );
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(
      "sensitive provider diagnostic",
    );
    await closeServer(server);
  });

  it("fails closed on oversized, malformed, or off-domain success responses", async () => {
    const responses = [
      {
        body: "x".repeat(1_100),
        contentType: "application/json",
      },
      {
        body: "{not-json",
        contentType: "application/json",
      },
      {
        body: JSON.stringify({
          products_link_url: "https://attacker.example/credential-capture",
        }),
        contentType: "application/json",
      },
    ];

    for (const candidate of responses) {
      const { server, baseUrl } = await startServer(
        async (request, response) => {
          await readRequest(request);
          response.writeHead(200, { "content-type": candidate.contentType });
          response.end(candidate.body);
        },
      );
      const client = new InstacartProductsLinkClient({
        apiKey: "bounded-response-key",
        testBaseUrl: baseUrl,
        maxResponseBytes: 1_024,
      });
      await expect(
        client.createProductsLink(shoppingContent()),
      ).rejects.toMatchObject({ code: "FOOD_PROVIDER_RESPONSE_INVALID" });
      await closeServer(server);
    }
  });
});
