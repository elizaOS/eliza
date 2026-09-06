/**
 * Exercises successful SDK response decoding through a real localhost HTTP
 * server, including media-type enforcement, every JSON value kind, explicit
 * bodyless protocols, and the raw-response escape hatch.
 */

import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CloudApiError, ElizaCloudClient } from "./index.js";

let server: Server | undefined;
let origin = "";

function sendJson(
  response: ServerResponse,
  value: unknown,
  contentType = "application/json",
): void {
  response.writeHead(200, { "content-type": contentType });
  response.end(JSON.stringify(value));
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    switch (pathname) {
      case "/api/v1/user":
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html>maintenance</html>");
        return;
      case "/missing-content-type":
        response.writeHead(200);
        response.end('{"success":true}');
        return;
      case "/wrong-content-type":
        response.writeHead(200, { "content-type": "text/plain" });
        response.end('{"success":true}');
        return;
      case "/wildcard-type":
        response.writeHead(200, { "content-type": "*/problem+json" });
        response.end('{"success":true}');
        return;
      case "/wildcard-subtype":
        response.writeHead(200, { "content-type": "application/*+json" });
        response.end('{"success":true}');
        return;
      case "/empty-json":
        response.writeHead(200, { "content-type": "application/json" });
        response.end();
        return;
      case "/malformed-json":
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{not-json");
        return;
      case "/invalid-utf8":
        response.writeHead(200, { "content-type": "application/json" });
        response.end(Uint8Array.from([0x22, 0xc3, 0x28, 0x22]));
        return;
      case "/json-object":
        sendJson(response, { success: true });
        return;
      case "/json-array":
        sendJson(response, [1, "two", false, null]);
        return;
      case "/json-string":
        sendJson(response, "ready");
        return;
      case "/json-number":
        sendJson(response, 42);
        return;
      case "/json-boolean":
        sendJson(response, false);
        return;
      case "/json-null":
        sendJson(response, null);
        return;
      case "/structured-json":
        sendJson(
          response,
          { type: "https://example.test/problem", status: 200 },
          "application/problem+json; charset=utf-8",
        );
        return;
      case "/no-content":
        response.writeHead(204);
        response.end();
        return;
      case "/reset-content":
        response.writeHead(205);
        response.end();
        return;
      case "/head":
        response.writeHead(200, {
          "content-length": "128",
          "content-type": "text/plain",
        });
        response.end();
        return;
      case "/raw-text":
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("plain SDK response");
        return;
      case "/api/v1/apps-ingress/ask":
        response.writeHead(200, {
          "content-type": "text/plain; charset=UTF-8",
        });
        response.end("ok");
        return;
      case "/api/v1/marketing/inventory/serve":
        response.writeHead(204);
        response.end();
        return;
      case "/api/v1/apps/app_1/frontend/preview/index.html":
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<main>preview</main>");
        return;
      case "/api/v1/hosted-frontend/serve/logo.png":
        response.writeHead(200, { "content-type": "image/png" });
        response.end(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
        return;
      default:
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"success":false,"error":"not found"}');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("localhost SDK test server did not bind a TCP address");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (!server) return;
  server.close();
  await once(server, "close");
});

function client(): ElizaCloudClient {
  return new ElizaCloudClient({
    baseUrl: origin,
    apiBaseUrl: `${origin}/api/v1`,
  });
}

describe("successful Cloud SDK response decoding", () => {
  it("rejects an HTML maintenance response through getUser", async () => {
    await expect(client().getUser()).rejects.toMatchObject({
      name: "CloudApiError",
      statusCode: 200,
      errorBody: {
        success: false,
        code: "unexpected_response_content_type",
      },
    });
  });

  it.each([
    "/missing-content-type",
    "/wrong-content-type",
    "/wildcard-type",
    "/wildcard-subtype",
  ])(
    "rejects JSON-looking data without a JSON media type at %s",
    async (path) => {
      await expect(client().request("GET", path)).rejects.toMatchObject({
        name: "CloudApiError",
        statusCode: 200,
        errorBody: {
          success: false,
          code: "unexpected_response_content_type",
        },
      });
    },
  );

  it("rejects an unexpectedly empty JSON data response", async () => {
    await expect(client().request("GET", "/empty-json")).rejects.toMatchObject({
      name: "CloudApiError",
      statusCode: 200,
      errorBody: {
        success: false,
        code: "empty_response_body",
      },
    });
  });

  it("rejects malformed JSON through the real transport", async () => {
    await expect(
      client().request("GET", "/malformed-json"),
    ).rejects.toMatchObject({
      name: "CloudApiError",
      statusCode: 200,
    });
  });

  it("rejects malformed UTF-8 instead of substituting JSON string data", async () => {
    try {
      await client().request("GET", "/invalid-utf8");
      expect.unreachable("invalid UTF-8 must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(CloudApiError);
      if (!(error instanceof CloudApiError)) throw error;
      expect(error).toMatchObject({
        statusCode: 200,
        errorBody: {
          success: false,
          code: "invalid_response_encoding",
        },
      });
      expect(error.cause).toBeInstanceOf(TypeError);
    }
  });

  it.each([
    ["object", "/json-object", { success: true }],
    ["array", "/json-array", [1, "two", false, null]],
    ["string", "/json-string", "ready"],
    ["number", "/json-number", 42],
    ["boolean", "/json-boolean", false],
    ["null", "/json-null", null],
  ])("preserves a JSON %s value", async (_kind, path, expected) => {
    await expect(client().request("GET", path)).resolves.toEqual(expected);
  });

  it("accepts a structured +json media type", async () => {
    await expect(client().request("GET", "/structured-json")).resolves.toEqual({
      type: "https://example.test/problem",
      status: 200,
    });
  });

  it.each([
    ["GET", "/no-content"],
    ["GET", "/reset-content"],
    ["HEAD", "/head"],
  ] as const)("returns undefined for bodyless %s %s", async (method, path) => {
    await expect(client().request(method, path)).resolves.toBeUndefined();
  });

  it("keeps successful text available through requestRaw", async () => {
    const response = await client().requestRaw("GET", "/raw-text");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    await expect(response.text()).resolves.toBe("plain SDK response");
  });

  it("uses the generated raw surface for a declared text route", async () => {
    const response = await client().routes.getApiV1AppsIngressAsk({
      query: { domain: "app.example.test" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=UTF-8",
    );
    await expect(response.text()).resolves.toBe("ok");
  });

  it("preserves a legitimate 204 from a generated JSON-or-empty method", async () => {
    await expect(
      client().routes.getApiV1MarketingInventoryServe(),
    ).resolves.toBeUndefined();
  });

  it("uses the generated raw surface for frontend preview assets", async () => {
    const response =
      await client().routes.getApiV1AppsByIdFrontendPreviewByPath({
        pathParams: { id: "app_1", "[...path]": "index.html" },
      });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    await expect(response.text()).resolves.toBe("<main>preview</main>");
  });

  it("uses the generated raw surface for public hosted assets", async () => {
    const response = await client().routes.getApiV1HostedFrontendServeByPath({
      pathParams: { "[...path]": "logo.png" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });
});
