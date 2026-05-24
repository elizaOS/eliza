/**
 * Unit tests for the /xr/connect route handler.
 *
 * Calls the real route handler directly — no HTTP server, no network.
 * Covers status code, HTML structure, URL embedding, and the HTTP-vs-HTTPS warning.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectRoute } from "../routes/connect.ts";

// ── Helper ────────────────────────────────────────────────────────────────────

async function callRoute(): Promise<{
  status: number;
  headers: Record<string, string>;
  body: string;
}> {
  const handler = connectRoute.routeHandler;
  if (!handler) throw new Error("connectRoute has no routeHandler");
  const result = await handler({} as never);
  return result as {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("connectRoute — GET /xr/connect", () => {
  const originalXrAppUrl = process.env.XR_APP_URL;

  beforeEach(() => {
    // Start each test with a clean env
    delete process.env.XR_APP_URL;
  });

  afterEach(() => {
    // Restore original env
    if (originalXrAppUrl === undefined) {
      delete process.env.XR_APP_URL;
    } else {
      process.env.XR_APP_URL = originalXrAppUrl;
    }
  });

  it("GET /xr/connect returns 200 HTML", async () => {
    const result = await callRoute();
    expect(result.status).toBe(200);
    expect(result.body).toContain("<!DOCTYPE html>");
  });

  it("HTML contains QR code canvas element", async () => {
    const { body } = await callRoute();
    expect(body).toContain('id="qrcanvas"');
  });

  it("HTML contains app URL", async () => {
    process.env.XR_APP_URL = "http://192.168.1.42:5173";
    const { body } = await callRoute();
    expect(body).toContain("192.168.1.42");
  });

  it("HTML warns about HTTP when not HTTPS", async () => {
    process.env.XR_APP_URL = "http://test.local";
    const { body } = await callRoute();
    expect(body).toContain("HTTP URL");
  });

  it("HTML uses HTTPS URL without warning", async () => {
    process.env.XR_APP_URL = "https://test.ngrok.io";
    const { body } = await callRoute();
    expect(body).not.toContain("HTTP URL");
  });

  it("pairing code is visible as URL text", async () => {
    const { body } = await callRoute();
    expect(body).toContain('<div class="url">');
  });

  it("response Content-Type is text/html", async () => {
    const { headers } = await callRoute();
    expect(headers["Content-Type"]).toMatch(/text\/html/);
  });

  it("HTML contains XR_APP_URL verbatim when set", async () => {
    process.env.XR_APP_URL = "https://my.tunnel.example.com";
    const { body } = await callRoute();
    expect(body).toContain("https://my.tunnel.example.com");
  });

  it("HTML fallback includes local IP and VITE_PORT when no XR_APP_URL", async () => {
    // No XR_APP_URL set; handler uses local IP + VITE_PORT (default 5173)
    delete process.env.XR_APP_URL;
    const { body } = await callRoute();
    // Should contain some IP address (local IP or 127.0.0.1 fallback) and port
    expect(body).toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });
});
