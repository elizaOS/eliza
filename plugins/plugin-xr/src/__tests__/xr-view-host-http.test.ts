/**
 * Full HTTP integration tests for the xrViewHostRoute.
 *
 * Unlike the unit tests in xr-view-host.test.ts (which call the route handler
 * directly), these tests spin up a real Node.js HTTP server, make actual
 * fetch() requests over TCP, and assert on the live HTTP response.
 *
 * This proves end-to-end integration:
 *   - URL parameter extraction works correctly
 *   - Route handler serializes the HTML response over a real socket
 *   - Content-Type and Content-Security-Policy headers are present in HTTP
 *   - All 24 registered XR view IDs produce valid HTTP 200 responses
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { xrViewHostRoute } from "../routes/xr-view-host.ts";

// All 24 registered XR view IDs
const ALL_VIEW_IDS = [
  "wallet",
  "companion",
  "training",
  "task-coordinator",
  "views-manager",
  "polymarket",
  "vincent",
  "steward",
  "shopify",
  "phone",
  "contacts",
  "messages",
  "babylon",
  "2004scape",
  "defense-of-the-agents",
  "clawville",
  "hyperliquid",
  "hyperscape",
  "lifeops",
  "scape",
  "screenshare",
  "trajectory-logger",
  "model-tester",
  "smartglasses",
] as const;

// ── HTTP server setup ─────────────────────────────────────────────────────────

let baseUrl = "";
let closeServer: () => Promise<void>;

beforeAll(() => {
  return new Promise<void>((resolve) => {
    const server = createServer(async (req, res) => {
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end("Method not allowed");
        return;
      }

      const url = new URL(req.url!, "http://localhost");

      // Route: GET /api/xr/view-host/:id
      const match = url.pathname.match(/^\/api\/xr\/view-host\/(.+)$/);
      if (match) {
        const viewId = decodeURIComponent(match[1]);
        const result = await xrViewHostRoute.routeHandler({
          params: { id: viewId },
          runtime: { port: 31337 },
        } as never);

        res.writeHead(result.status, result.headers as Record<string, string>);
        res.end(result.body as string);
        return;
      }

      // Route: GET /api/xr/view-host (no id — should 400)
      if (url.pathname === "/api/xr/view-host") {
        const result = await xrViewHostRoute.routeHandler({
          params: {},
          runtime: { port: 31337 },
        } as never);
        res.writeHead(result.status);
        res.end(JSON.stringify(result.body));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      closeServer = () => new Promise((r) => server.close(() => r()));
      resolve();
    });
  });
});

afterAll(() => closeServer());

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("xrViewHostRoute — real HTTP server integration", () => {
  it("GET /api/xr/view-host (no id) returns HTTP 400", async () => {
    const res = await fetch(`${baseUrl}/api/xr/view-host`);
    expect(res.status).toBe(400);
  });

  it("GET /api/xr/view-host/:id returns HTTP 200 with text/html for every registered view id", async () => {
    const failures: string[] = [];
    for (const id of ALL_VIEW_IDS) {
      const res = await fetch(
        `${baseUrl}/api/xr/view-host/${encodeURIComponent(id)}`,
      );
      if (res.status !== 200) {
        failures.push(`${id}: HTTP ${res.status}`);
        continue;
      }
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("text/html")) {
        failures.push(`${id}: Content-Type "${ct}" is not text/html`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("every view-host response body is valid HTML with the view id in data-view-id", async () => {
    const failures: string[] = [];
    for (const id of ALL_VIEW_IDS) {
      const res = await fetch(
        `${baseUrl}/api/xr/view-host/${encodeURIComponent(id)}`,
      );
      const html = await res.text();
      if (
        !html.startsWith("<!DOCTYPE html") &&
        !html.startsWith("<!doctype html")
      ) {
        failures.push(`${id}: response does not start with DOCTYPE`);
      }
      if (!html.includes(`data-view-id="${id}"`)) {
        failures.push(`${id}: data-view-id="${id}" not found in response`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("every view-host response has Content-Security-Policy header", async () => {
    const failures: string[] = [];
    for (const id of ALL_VIEW_IDS) {
      const res = await fetch(
        `${baseUrl}/api/xr/view-host/${encodeURIComponent(id)}`,
      );
      const csp = res.headers.get("content-security-policy") ?? "";
      if (!csp) {
        failures.push(`${id}: missing Content-Security-Policy header`);
      } else if (!csp.includes("esm.sh")) {
        failures.push(`${id}: CSP missing esm.sh`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("view-host pages with special characters in id (2004scape, defense-of-the-agents) serve correctly", async () => {
    const specialIds = [
      "2004scape",
      "defense-of-the-agents",
      "task-coordinator",
    ];
    for (const id of specialIds) {
      const res = await fetch(
        `${baseUrl}/api/xr/view-host/${encodeURIComponent(id)}`,
      );
      expect(res.status, `${id}: expected 200`).toBe(200);
      const html = await res.text();
      expect(html, `${id}: data-view-id must match`).toContain(
        `data-view-id="${id}"`,
      );
    }
  });

  it("all 24 view-host pages embed the correct bundle URL for the elizaOS views API", async () => {
    const failures: string[] = [];
    for (const id of ALL_VIEW_IDS) {
      const res = await fetch(
        `${baseUrl}/api/xr/view-host/${encodeURIComponent(id)}`,
      );
      const html = await res.text();
      // Bundle URL must reference /api/views/:id/bundle.js — the elizaOS views serving endpoint
      const expectedBundlePath = `/api/views/${id}/bundle.js`;
      if (!html.includes(expectedBundlePath)) {
        failures.push(
          `${id}: bundle URL "${expectedBundlePath}" not found in page`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it("all 24 view-host pages load React from CDN importmap (not bundled)", async () => {
    const failures: string[] = [];
    for (const id of ALL_VIEW_IDS) {
      const res = await fetch(
        `${baseUrl}/api/xr/view-host/${encodeURIComponent(id)}`,
      );
      const html = await res.text();
      // React must come from importmap (esm.sh), not be bundled — proven by the importmap block
      if (!html.includes("esm.sh/react")) {
        failures.push(`${id}: React importmap missing`);
      }
      // importmap type must be present
      if (!html.includes('type="importmap"')) {
        failures.push(`${id}: importmap script tag missing`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("each view-host page has voice-input infrastructure wired (fillFocusedInput, xr:transcript)", async () => {
    const failures: string[] = [];
    for (const id of ALL_VIEW_IDS) {
      const res = await fetch(
        `${baseUrl}/api/xr/view-host/${encodeURIComponent(id)}`,
      );
      const html = await res.text();
      if (!html.includes("fillFocusedInput")) {
        failures.push(`${id}: fillFocusedInput missing`);
      }
      if (!html.includes("xr:transcript")) {
        failures.push(`${id}: xr:transcript handler missing`);
      }
      if (!html.includes("xr:view-ready")) {
        failures.push(`${id}: xr:view-ready postMessage missing`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("concurrent requests for all 24 view ids resolve correctly in parallel", async () => {
    // Proves the server handles concurrent requests without state corruption
    const responses = await Promise.all(
      ALL_VIEW_IDS.map((id) =>
        fetch(`${baseUrl}/api/xr/view-host/${encodeURIComponent(id)}`).then(
          async (r) => ({ id, status: r.status, html: await r.text() }),
        ),
      ),
    );

    const failures: string[] = [];
    for (const { id, status, html } of responses) {
      if (status !== 200) failures.push(`${id}: HTTP ${status}`);
      else if (!html.includes(`data-view-id="${id}"`))
        failures.push(`${id}: data-view-id mismatch in concurrent response`);
    }
    expect(failures).toEqual([]);
  });
});
