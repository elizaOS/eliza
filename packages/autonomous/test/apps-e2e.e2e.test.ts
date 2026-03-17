/**
 * E2E tests for the Apps system — NO MOCKS.
 *
 * Starts a real API server and tests the full apps flow:
 * - GET /api/apps (list from real registry or cached data)
 * - GET /api/apps/search?q=... (search)
 * - GET /api/apps/installed (check installed apps)
 * - POST /api/apps/launch (install plugin + return viewer)
 * - GET /api/apps/info/:name (app detail)
 *
 * When the 2004scape engine is running locally (port 80), also tests:
 * - Full launch -> plugin install -> viewer URL points to running server
 * - Webclient is accessible at the viewer URL
 */
import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer } from "../src/api/server";

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface ApiResponse {
  status: number;
  data: JsonValue;
}

interface RequestPayload {
  body?: string;
  contentType?: string;
}

interface AppEntry {
  name: string;
  displayName: string;
  description: string;
  category: string;
  launchType: string;
  launchUrl?: string | null;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonArray;
interface JsonObject {
  [key: string]: JsonValue;
}
type JsonArray = JsonValue[];

function parseJson(raw: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return { _raw: raw };
  }
}

function asObject(value: JsonValue): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function asArray(value: JsonValue): JsonArray {
  return Array.isArray(value) ? value : [];
}

function requestApi(
  port: number,
  method: string,
  path: string,
  payload?: RequestPayload,
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const body = payload?.body;
    const contentType = payload?.contentType ?? "application/json";
    let settled = false;

    const finish = (result: ApiResponse) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(body
            ? {
                "Content-Type": contentType,
                "Content-Length": Buffer.byteLength(body),
                Connection: "close",
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        const flush = () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          finish({
            status: res.statusCode ?? 0,
            data: parseJson(raw),
          });
        };
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", flush);
        res.on("aborted", flush);
        res.on("close", flush);
        res.on("error", fail);
      },
    );
    req.on("error", (err: Error & { code?: string }) => {
      fail(err);
    });
    req.setTimeout(15_000, () => {
      req.destroy(new Error(`Request timed out: ${method} ${path}`));
    });
    if (body) req.write(body);
    req.end();
  });
}

function api(
  port: number,
  method: string,
  path: string,
  body?: JsonObject,
): Promise<ApiResponse> {
  return requestApi(port, method, path, {
    body: body ? JSON.stringify(body) : undefined,
    contentType: "application/json",
  });
}

function rawApi(
  port: number,
  method: string,
  path: string,
  rawBody: string,
  contentType = "application/json",
): Promise<ApiResponse> {
  return requestApi(port, method, path, {
    body: rawBody,
    contentType,
  });
}

function toAppList(data: JsonValue): AppEntry[] {
  if (!Array.isArray(data)) return [];
  const apps: AppEntry[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item;
    if (
      typeof row.name === "string" &&
      typeof row.displayName === "string" &&
      typeof row.description === "string" &&
      typeof row.category === "string" &&
      typeof row.launchType === "string"
    ) {
      apps.push({
        name: row.name,
        displayName: row.displayName,
        description: row.description,
        category: row.category,
        launchType: row.launchType,
        launchUrl:
          typeof row.launchUrl === "string" || row.launchUrl === null
            ? row.launchUrl
            : undefined,
      });
    }
  }
  return apps;
}

const KNOWN_LOCAL_APP_NAME = "@elizaos/app-hyperscape";
const PLUGIN_MANAGER_UNAVAILABLE_ERROR = "Plugin manager service not found";

function isPluginManagerUnavailable(response: ApiResponse): boolean {
  return (
    response.status === 500 &&
    asObject(response.data).error === PLUGIN_MANAGER_UNAVAILABLE_ERROR
  );
}

function expectPluginManagerUnavailable(response: ApiResponse): void {
  expect(response.status).toBe(500);
  expect(asObject(response.data).error).toBe(PLUGIN_MANAGER_UNAVAILABLE_ERROR);
}

/** Check if a TCP port is listening. */
function isPortOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

interface HttpTarget {
  baseUrl: string;
  host: string;
  port: number;
}

function parseHttpTarget(rawUrl: string): HttpTarget | null {
  if (!rawUrl || rawUrl.startsWith("/")) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const port = url.port
      ? Number.parseInt(url.port, 10)
      : url.protocol === "https:"
        ? 443
        : 80;
    if (!Number.isFinite(port)) return null;
    return {
      baseUrl: `${url.protocol}//${url.hostname}:${port}`,
      host: url.hostname,
      port,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Apps E2E", () => {
  let server: { port: number; close: () => Promise<void> };
  let pluginManagerAvailable = true;

  beforeAll(async () => {
    server = await startApiServer({ port: 0 });
    const probe = await api(server.port, "GET", "/api/apps");
    pluginManagerAvailable = !isPluginManagerUnavailable(probe);
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
  });

  // ===================================================================
  //  1. App listing
  // ===================================================================

  describe("GET /api/apps", () => {
    it("returns 200 with an array", async () => {
      const response = await api(server.port, "GET", "/api/apps");
      if (!pluginManagerAvailable) {
        expectPluginManagerUnavailable(response);
        return;
      }
      expect(response.status).toBe(200);
      expect(Array.isArray(response.data)).toBe(true);
    });

    it("app entries have required fields and valid launch metadata", async () => {
      const response = await api(server.port, "GET", "/api/apps");
      if (!pluginManagerAvailable) {
        expectPluginManagerUnavailable(response);
        return;
      }
      const apps = toAppList(response.data);
      // Registry may or may not have network data, but local app wrappers should exist.
      expect(apps.length).toBeGreaterThan(0);
      for (const app of apps.slice(0, 8)) {
        expect(app.name.length).toBeGreaterThan(0);
        expect(app.displayName.length).toBeGreaterThan(0);
        expect(app.category.length).toBeGreaterThan(0);
        expect(app.launchType.length).toBeGreaterThan(0);
        if (app.launchUrl !== undefined) {
          expect(app.launchUrl === null || app.launchUrl.length > 0).toBe(true);
        }
      }
    });
  });

  // ===================================================================
  //  2. App search
  // ===================================================================

  describe("GET /api/apps/search", () => {
    it("returns empty array for empty query", async () => {
      const { status, data } = await api(
        server.port,
        "GET",
        "/api/apps/search?q=",
      );
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      expect(asArray(data).length).toBe(0);
    });

    it("returns empty array for whitespace-only query", async () => {
      const { status, data } = await api(
        server.port,
        "GET",
        "/api/apps/search?q=%20%20%20",
      );
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      expect(asArray(data).length).toBe(0);
    });

    it("returns array for a query", async () => {
      const response = await api(server.port, "GET", "/api/apps/search?q=game");
      if (!pluginManagerAvailable) {
        expectPluginManagerUnavailable(response);
        return;
      }
      expect(response.status).toBe(200);
      expect(Array.isArray(response.data)).toBe(true);
    });

    it("normalizes invalid and out-of-range limit values", async () => {
      const maxLimit = await api(
        server.port,
        "GET",
        "/api/apps/search?q=app&limit=50",
      );
      const invalidLimit = await api(
        server.port,
        "GET",
        "/api/apps/search?q=app&limit=abc",
      );
      const underLimit = await api(
        server.port,
        "GET",
        "/api/apps/search?q=app&limit=0",
      );
      const overLimit = await api(
        server.port,
        "GET",
        "/api/apps/search?q=app&limit=500",
      );

      if (!pluginManagerAvailable) {
        for (const response of [
          maxLimit,
          invalidLimit,
          underLimit,
          overLimit,
        ]) {
          expectPluginManagerUnavailable(response);
        }
        return;
      }

      expect(maxLimit.status).toBe(200);
      expect(invalidLimit.status).toBe(200);
      expect(underLimit.status).toBe(200);
      expect(overLimit.status).toBe(200);
      expect(Array.isArray(maxLimit.data)).toBe(true);
      expect(Array.isArray(invalidLimit.data)).toBe(true);
      expect(Array.isArray(underLimit.data)).toBe(true);
      expect(Array.isArray(overLimit.data)).toBe(true);

      const maxLen = Array.isArray(maxLimit.data) ? maxLimit.data.length : 0;
      const invalidLen = Array.isArray(invalidLimit.data)
        ? invalidLimit.data.length
        : 0;
      const underLen = Array.isArray(underLimit.data)
        ? underLimit.data.length
        : 0;
      const overLen = Array.isArray(overLimit.data) ? overLimit.data.length : 0;

      expect(overLen).toBeLessThanOrEqual(50);
      expect(underLen).toBeLessThanOrEqual(1);
      expect(invalidLen).toBeLessThanOrEqual(15);
      if (maxLen > 0) {
        expect(invalidLen).toBeGreaterThan(0);
      }
    });
  });

  // ===================================================================
  //  3. App info
  // ===================================================================

  describe("GET /api/apps/info/:name", () => {
    it("returns 400 for missing app name segment", async () => {
      const { status, data } = await api(server.port, "GET", "/api/apps/info/");
      expect(status).toBe(400);
      expect(asObject(data).error).toBe("app name is required");
    });

    it("returns 404 for non-existent app", async () => {
      const response = await api(
        server.port,
        "GET",
        "/api/apps/info/%40elizaos%2Fapp-nonexistent",
      );
      if (!pluginManagerAvailable) {
        expectPluginManagerUnavailable(response);
        return;
      }
      expect(response.status).toBe(404);
    });

    it("returns app metadata for an existing app", async () => {
      const encoded = encodeURIComponent(KNOWN_LOCAL_APP_NAME);
      const response = await api(
        server.port,
        "GET",
        `/api/apps/info/${encoded}`,
      );
      if (!pluginManagerAvailable) {
        expectPluginManagerUnavailable(response);
        return;
      }
      const body = asObject(response.data);
      expect(response.status).toBe(200);
      expect(body.name).toBe(KNOWN_LOCAL_APP_NAME);
      expect(typeof body.displayName).toBe("string");
      expect(typeof body.launchType).toBe("string");
    });
  });

  // ===================================================================
  //  4. App installed list
  // ===================================================================

  describe("GET /api/apps/installed", () => {
    it("returns 200 with an array", async () => {
      const response = await api(server.port, "GET", "/api/apps/installed");
      if (!pluginManagerAvailable) {
        expectPluginManagerUnavailable(response);
        return;
      }
      expect(response.status).toBe(200);
      expect(Array.isArray(response.data)).toBe(true);
    });

    it("installed entries have stable shape", async () => {
      const response = await api(server.port, "GET", "/api/apps/installed");
      if (!pluginManagerAvailable) {
        expectPluginManagerUnavailable(response);
        return;
      }
      if (!Array.isArray(response.data)) {
        expect(Array.isArray(response.data)).toBe(true);
        return;
      }
      for (const row of response.data.slice(0, 5)) {
        const item = asObject(row);
        expect(typeof item.name).toBe("string");
        expect(typeof item.displayName).toBe("string");
        expect(typeof item.pluginName).toBe("string");
        expect(typeof item.version).toBe("string");
        expect(typeof item.installedAt).toBe("string");
      }
    });
  });

  // ===================================================================
  //  5. App launch
  // ===================================================================

  describe("POST /api/apps/launch", () => {
    it("returns 400 when name is missing", async () => {
      const { status } = await api(server.port, "POST", "/api/apps/launch", {});
      expect(status).toBe(400);
    });

    it("returns 400 when name is empty", async () => {
      const { status } = await api(server.port, "POST", "/api/apps/launch", {
        name: "",
      });
      expect(status).toBe(400);
    });

    it("returns 400 for invalid JSON body", async () => {
      const { status, data } = await rawApi(
        server.port,
        "POST",
        "/api/apps/launch",
        '{"name":',
      );
      expect(status).toBe(400);
      expect(asObject(data).error).toBe("Invalid JSON in request body");
    });

    it("returns 400 when body is a JSON array", async () => {
      const { status, data } = await rawApi(
        server.port,
        "POST",
        "/api/apps/launch",
        '["not","an","object"]',
      );
      expect(status).toBe(400);
      expect(asObject(data).error).toBe("Request body must be a JSON object");
    });

    it("rejects requests when body exceeds size limit", async () => {
      const oversized = JSON.stringify({
        name: `@elizaos/app-${"x".repeat(1_050_000)}`,
      });
      const { status, data } = await rawApi(
        server.port,
        "POST",
        "/api/apps/launch",
        oversized,
        "application/json",
      );
      const body = asObject(data);
      expect(status).toBe(413);
      expect(typeof body.error).toBe("string");
      if (typeof body.error === "string") {
        expect(body.error.includes("maximum size")).toBe(true);
      }
    });

    it("returns error for unknown app name", async () => {
      const { status, data } = await api(
        server.port,
        "POST",
        "/api/apps/launch",
        {
          name: "@elizaos/app-definitely-does-not-exist-xyz",
        },
      );
      // Should be 500 (app not found in registry throws)
      expect(status).toBe(500);
      expect(asObject(data).error).toBeDefined();
    });

    it("returns launch metadata for known app", async () => {
      const launch = await api(server.port, "POST", "/api/apps/launch", {
        name: KNOWN_LOCAL_APP_NAME,
      });
      if (!pluginManagerAvailable) {
        expectPluginManagerUnavailable(launch);
        return;
      }
      expect(launch.status).toBe(200);

      const body = asObject(launch.data);
      expect(typeof body.displayName).toBe("string");
      expect(typeof body.launchType).toBe("string");
      const launchUrl = body.launchUrl;
      expect(launchUrl === null || typeof launchUrl === "string").toBe(true);
      if (
        body.viewer &&
        typeof body.viewer === "object" &&
        !Array.isArray(body.viewer)
      ) {
        const viewer = body.viewer;
        expect(typeof viewer.url).toBe("string");
        if (viewer.sandbox !== undefined) {
          expect(typeof viewer.sandbox).toBe("string");
        }
      }
    });

    it("handles concurrent invalid launch requests", async () => {
      const attempts = await Promise.all(
        Array.from({ length: 3 }, () =>
          api(server.port, "POST", "/api/apps/launch", {
            name: "@elizaos/app-definitely-does-not-exist-xyz",
          }),
        ),
      );

      for (const response of attempts) {
        expect(response.status).toBe(500);
        expect(typeof asObject(response.data).error).toBe("string");
      }
    });
  });

  describe("POST /api/apps/stop", () => {
    it("returns 400 when name is missing", async () => {
      const { status } = await api(server.port, "POST", "/api/apps/stop", {});
      expect(status).toBe(400);
    });

    it("returns 400 for invalid JSON body", async () => {
      const { status, data } = await rawApi(
        server.port,
        "POST",
        "/api/apps/stop",
        '{"name":',
      );
      expect(status).toBe(400);
      expect(asObject(data).error).toBe("Invalid JSON in request body");
    });

    it("returns 400 when body is not a JSON object", async () => {
      const { status, data } = await rawApi(
        server.port,
        "POST",
        "/api/apps/stop",
        '"plain string"',
      );
      expect(status).toBe(400);
      expect(asObject(data).error).toBe("Request body must be a JSON object");
    });

    it("returns 500 for unknown app name", async () => {
      const { status, data } = await api(
        server.port,
        "POST",
        "/api/apps/stop",
        {
          name: "@elizaos/app-definitely-does-not-exist-xyz",
        },
      );
      expect(status).toBe(500);
      expect(asObject(data).error).toBeDefined();
    });

    it("returns stop result payload for a known app", async () => {
      const launch = await api(server.port, "POST", "/api/apps/launch", {
        name: KNOWN_LOCAL_APP_NAME,
      });
      if (!pluginManagerAvailable) {
        expectPluginManagerUnavailable(launch);
        return;
      }
      expect(launch.status).toBe(200);

      const response = await api(server.port, "POST", "/api/apps/stop", {
        name: KNOWN_LOCAL_APP_NAME,
      });
      if (!pluginManagerAvailable) {
        expectPluginManagerUnavailable(response);
        return;
      }
      const body = asObject(response.data);
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.appName).toBe(KNOWN_LOCAL_APP_NAME);
      expect(typeof body.stoppedAt).toBe("string");
      expect(Number.isNaN(Date.parse(String(body.stoppedAt)))).toBe(false);
      expect(typeof body.pluginUninstalled).toBe("boolean");
      expect(typeof body.needsRestart).toBe("boolean");
      expect(typeof body.stopScope).toBe("string");
      expect(typeof body.message).toBe("string");
    });

    it("returns no-op on repeated stop after app is already disconnected", async () => {
      const response = await api(server.port, "POST", "/api/apps/stop", {
        name: KNOWN_LOCAL_APP_NAME,
      });
      if (!pluginManagerAvailable) {
        expectPluginManagerUnavailable(response);
        return;
      }
      const body = asObject(response.data);
      expect(response.status).toBe(200);
      expect(body.success).toBe(false);
      expect(body.stopScope).toBe("no-op");
      expect(typeof body.message).toBe("string");
    });

    it("handles concurrent stop requests for unknown app", async () => {
      const responses = await Promise.all(
        Array.from({ length: 4 }, () =>
          api(server.port, "POST", "/api/apps/stop", {
            name: "@elizaos/app-definitely-does-not-exist-xyz",
          }),
        ),
      );
      for (const response of responses) {
        expect(response.status).toBe(500);
        expect(typeof asObject(response.data).error).toBe("string");
      }
    });
  });

  // ===================================================================
  //  6. Route not found
  // ===================================================================

  describe("unknown routes", () => {
    it("returns 404 for unknown app route", async () => {
      const { status } = await api(
        server.port,
        "GET",
        "/api/apps/unknown-route",
      );
      expect(status).toBe(404);
    });
  });

  // ===================================================================
  //  8. Non-app plugin and refresh routes
  // ===================================================================

  describe("plugin registry routes", () => {
    it("GET /api/apps/plugins returns data or upstream error payload", async () => {
      const response = await api(server.port, "GET", "/api/apps/plugins");
      if (response.status === 200) {
        expect(Array.isArray(response.data)).toBe(true);
      } else {
        expect(response.status).toBe(502);
        expect(typeof asObject(response.data).error).toBe("string");
      }
    });

    it("GET /api/apps/plugins/search returns [] for empty query", async () => {
      const response = await api(
        server.port,
        "GET",
        "/api/apps/plugins/search?q=",
      );
      expect(response.status).toBe(200);
      expect(Array.isArray(response.data)).toBe(true);
      expect(asArray(response.data).length).toBe(0);
    });

    it("GET /api/apps/plugins/search enforces limit bounds", async () => {
      const maxLimit = await api(
        server.port,
        "GET",
        "/api/apps/plugins/search?q=plugin&limit=50",
      );
      const invalidLimit = await api(
        server.port,
        "GET",
        "/api/apps/plugins/search?q=plugin&limit=abc",
      );
      const overLimit = await api(
        server.port,
        "GET",
        "/api/apps/plugins/search?q=plugin&limit=500",
      );

      for (const res of [maxLimit, invalidLimit, overLimit]) {
        if (res.status === 200) {
          expect(Array.isArray(res.data)).toBe(true);
        } else {
          expect(res.status).toBe(502);
          expect(typeof asObject(res.data).error).toBe("string");
        }
      }

      if (
        maxLimit.status === 200 &&
        invalidLimit.status === 200 &&
        overLimit.status === 200
      ) {
        const maxRows = asArray(maxLimit.data);
        const invalidRows = asArray(invalidLimit.data);
        const overRows = asArray(overLimit.data);
        expect(maxRows.length).toBeLessThanOrEqual(50);
        expect(overRows.length).toBeLessThanOrEqual(50);
        expect(invalidRows.length).toBeLessThanOrEqual(15);
        if (maxRows.length > 0) {
          expect(invalidRows.length).toBeGreaterThan(0);
        }
      }
    });

    it("POST /api/apps/refresh returns count or upstream error", async () => {
      const response = await api(server.port, "POST", "/api/apps/refresh", {});
      if (response.status === 200) {
        const body = asObject(response.data);
        expect(body.ok).toBe(true);
        expect(typeof body.count).toBe("number");
        expect(Number(body.count)).toBeGreaterThanOrEqual(0);
      } else {
        expect(response.status).toBe(502);
        expect(typeof asObject(response.data).error).toBe("string");
      }
    });
  });

  // ===================================================================
  //  9. Concurrent request behavior
  // ===================================================================

  describe("concurrent request behavior", () => {
    it("serves concurrent reads across app endpoints", async () => {
      const responses = await Promise.all([
        api(server.port, "GET", "/api/apps"),
        api(server.port, "GET", "/api/apps/search?q=game"),
        api(server.port, "GET", "/api/apps/installed"),
        api(server.port, "GET", "/api/apps/plugins"),
      ]);

      if (!pluginManagerAvailable) {
        expectPluginManagerUnavailable(responses[0]);
        expectPluginManagerUnavailable(responses[1]);
        expectPluginManagerUnavailable(responses[2]);
        expect([200, 502]).toContain(responses[3].status);
        return;
      }

      expect(responses[0].status).toBe(200);
      expect(responses[1].status).toBe(200);
      expect(responses[2].status).toBe(200);
      expect([200, 502]).toContain(responses[3].status);
      expect(Array.isArray(responses[0].data)).toBe(true);
      expect(Array.isArray(responses[1].data)).toBe(true);
      expect(Array.isArray(responses[2].data)).toBe(true);
    });
  });

  // ===================================================================
  //  10. 2004scape integration (requires local services running)
  // ===================================================================

  describe("2004scape integration", () => {
    let engineRunning = false;
    let gatewayRunning = false;
    let engineTarget: HttpTarget = {
      baseUrl: "http://127.0.0.1:8880",
      host: "127.0.0.1",
      port: 8880,
    };

    beforeAll(async () => {
      const info = await api(
        server.port,
        "GET",
        `/api/apps/info/${encodeURIComponent("@elizaos/app-2004scape")}`,
      );
      if (info.status === 200) {
        const body = asObject(info.data);
        const viewer = asObject(body.viewer as JsonValue);
        const fromViewer =
          typeof viewer.url === "string" ? parseHttpTarget(viewer.url) : null;
        const fromLaunch =
          typeof body.launchUrl === "string"
            ? parseHttpTarget(body.launchUrl)
            : null;
        engineTarget = fromViewer ?? fromLaunch ?? engineTarget;
      }

      if (await isPortOpen(engineTarget.port, engineTarget.host)) {
        try {
          const body = await new Promise<string>((resolve, reject) => {
            http
              .get(engineTarget.baseUrl, (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("end", () =>
                  resolve(Buffer.concat(chunks).toString("utf-8")),
                );
              })
              .on("error", reject);
          });
          engineRunning = body.includes("<");
        } catch {
          engineRunning = false;
        }
      }
      gatewayRunning = await isPortOpen(7780);
      if (!engineRunning) {
        console.log(
          `[E2E] 2004scape engine not running at ${engineTarget.baseUrl} — skipping integration tests`,
        );
        console.log(
          "[E2E] Start it with: cd eliza-2004scape && bun run engine",
        );
      }
      if (!gatewayRunning) {
        console.log(
          "[E2E] 2004scape gateway not running on port 7780 — skipping integration tests",
        );
        console.log(
          "[E2E] Start it with: cd eliza-2004scape && bun run gateway",
        );
      }
    });

    it("webclient is accessible when engine is running", async () => {
      if (!engineRunning) return;

      const response = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          http
            .get(engineTarget.baseUrl, (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c: Buffer) => chunks.push(c));
              res.on("end", () => {
                resolve({
                  status: res.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString("utf-8"),
                });
              });
            })
            .on("error", reject);
        },
      );

      expect(response.status).toBe(200);
      expect(response.body).toContain("<");
    });

    it("gateway WebSocket is reachable when running", async () => {
      if (!gatewayRunning) {
        console.log("[E2E] Skipping gateway test — not running");
        return;
      }

      const reachable = await isPortOpen(7780);
      expect(reachable).toBe(true);
    });

    it("gateway responds to HTTP requests", async () => {
      if (!gatewayRunning) return;

      // The gateway serves a REST API alongside WebSocket
      const response = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          http
            .get("http://127.0.0.1:7780/status", (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c: Buffer) => chunks.push(c));
              res.on("end", () => {
                resolve({
                  status: res.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString("utf-8"),
                });
              });
            })
            .on("error", reject);
        },
      );

      // Gateway should respond (200 or 404 depending on route, but NOT connection refused)
      expect(response.status).toBeGreaterThan(0);
    });

    it("full launch flow returns viewer config pointing to local engine", async () => {
      if (!engineRunning) return;

      // This test exercises the full flow:
      // 1. POST /api/apps/launch with @elizaos/app-2004scape
      // 2. AppManager looks up registry, installs plugin, returns viewer URL
      // Note: This may fail if the registry is unreachable (network dependency)
      const { status, data } = await api(
        server.port,
        "POST",
        "/api/apps/launch",
        {
          name: "@elizaos/app-2004scape",
        },
      );
      expect(status).toBe(200);
      const body = asObject(data);
      expect(body.displayName).toBe("2004scape");
      if (
        body.viewer &&
        typeof body.viewer === "object" &&
        !Array.isArray(body.viewer)
      ) {
        const viewer = body.viewer;
        expect(typeof viewer.url).toBe("string");
        if (typeof viewer.url === "string") {
          expect(viewer.url).toContain("localhost");
        }
      }
    });

    it("launch includes postMessageAuth config for 2004scape", async () => {
      // This test verifies the postMessage auth configuration is included
      // in the launch response for 2004scape, enabling autologin when embedded
      const response = await api(server.port, "POST", "/api/apps/launch", {
        name: "@elizaos/app-2004scape",
      });
      if (!pluginManagerAvailable) {
        expectPluginManagerUnavailable(response);
        return;
      }
      expect(response.status).toBe(200);
      const body = asObject(response.data);

      if (
        body.viewer &&
        typeof body.viewer === "object" &&
        !Array.isArray(body.viewer)
      ) {
        const viewer = body.viewer;
        // postMessageAuth should be true for 2004scape
        expect(viewer.postMessageAuth).toBe(true);

        // authMessage should contain RS_2004SCAPE_AUTH type
        if (
          viewer.authMessage &&
          typeof viewer.authMessage === "object" &&
          !Array.isArray(viewer.authMessage)
        ) {
          const authMsg = viewer.authMessage;
          expect(authMsg.type).toBe("RS_2004SCAPE_AUTH");
          // authToken contains username (defaults to testbot if not configured)
          expect(typeof authMsg.authToken).toBe("string");
          expect((authMsg.authToken as string).length).toBeGreaterThan(0);
        }
      }
    });
  });

  // ===================================================================
  //  11. Hyperscape postMessage auth integration
  // ===================================================================

  describe("Hyperscape postMessage auth", () => {
    it("launch includes postMessageAuth config when HYPERSCAPE_AUTH_TOKEN is set", async () => {
      // Save original env
      const originalToken = process.env.HYPERSCAPE_AUTH_TOKEN;

      // Set test token
      process.env.HYPERSCAPE_AUTH_TOKEN = "test-auth-token-e2e";

      try {
        const response = await api(server.port, "POST", "/api/apps/launch", {
          name: "@elizaos/app-hyperscape",
        });
        if (!pluginManagerAvailable) {
          expectPluginManagerUnavailable(response);
          return;
        }
        expect(response.status).toBe(200);
        const body = asObject(response.data);

        if (
          body.viewer &&
          typeof body.viewer === "object" &&
          !Array.isArray(body.viewer)
        ) {
          const viewer = body.viewer;
          expect(viewer.postMessageAuth).toBe(true);

          if (
            viewer.authMessage &&
            typeof viewer.authMessage === "object" &&
            !Array.isArray(viewer.authMessage)
          ) {
            const authMsg = viewer.authMessage;
            expect(authMsg.type).toBe("HYPERSCAPE_AUTH");
            expect(authMsg.authToken).toBe("test-auth-token-e2e");
          }
        }
      } finally {
        // Restore original env
        if (originalToken !== undefined) {
          process.env.HYPERSCAPE_AUTH_TOKEN = originalToken;
        } else {
          delete process.env.HYPERSCAPE_AUTH_TOKEN;
        }
      }
    });

    it("launch disables postMessageAuth when HYPERSCAPE_AUTH_TOKEN is not set", async () => {
      // Save and clear token
      const originalToken = process.env.HYPERSCAPE_AUTH_TOKEN;
      delete process.env.HYPERSCAPE_AUTH_TOKEN;

      try {
        const response = await api(server.port, "POST", "/api/apps/launch", {
          name: "@elizaos/app-hyperscape",
        });
        if (!pluginManagerAvailable) {
          expectPluginManagerUnavailable(response);
          return;
        }
        expect(response.status).toBe(200);
        const body = asObject(response.data);

        if (
          body.viewer &&
          typeof body.viewer === "object" &&
          !Array.isArray(body.viewer)
        ) {
          const viewer = body.viewer;
          // postMessageAuth should be false when token is not configured
          expect(viewer.postMessageAuth).toBe(false);
          // authMessage should not be present
          expect(viewer.authMessage).toBeUndefined();
        }
      } finally {
        // Restore original env
        if (originalToken !== undefined) {
          process.env.HYPERSCAPE_AUTH_TOKEN = originalToken;
        }
      }
    });
  });
});
