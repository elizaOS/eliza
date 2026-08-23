/**
 * Unit tests for cloud CORS constants and loopback origin matcher.
 */

import { describe, expect, it } from "vitest";
import {
  APP_LOCAL_ORIGIN_RE,
  APP_SCHEME_ORIGIN_RE,
  CAPACITOR_WEBVIEW_ORIGIN,
  CORS_ALLOW_HEADER_NAMES,
  CORS_ALLOW_HEADERS,
  CORS_ALLOW_METHOD_NAMES,
  CORS_ALLOW_METHODS,
  CORS_EXPOSE_HEADER_NAMES,
  CORS_MAX_AGE,
  isLocalDevLoopbackOrigin,
} from "./cors-constants.js";

describe("CORS constants", () => {
  it("defines allowed headers and formatted header string", () => {
    expect(CORS_ALLOW_HEADER_NAMES).toContain("Authorization");
    expect(CORS_ALLOW_HEADER_NAMES).toContain("Content-Type");
    expect(CORS_ALLOW_HEADER_NAMES).toContain("X-API-Key");
    expect(CORS_ALLOW_HEADER_NAMES).toContain("X-Eliza-CSRF");
    expect(CORS_ALLOW_HEADER_NAMES).toContain("Idempotency-Key");
    expect(CORS_ALLOW_HEADER_NAMES).toContain("Traceparent");

    expect(CORS_ALLOW_HEADERS).toBe(CORS_ALLOW_HEADER_NAMES.join(", "));
  });

  it("defines exposed header names and methods", () => {
    expect(CORS_EXPOSE_HEADER_NAMES).toContain("Server-Timing");
    expect(CORS_EXPOSE_HEADER_NAMES).toContain("X-Request-ID");
    expect(CORS_EXPOSE_HEADER_NAMES).toContain("X-Eliza-Trace-Id");

    expect(CORS_ALLOW_METHOD_NAMES).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
    expect(CORS_ALLOW_METHODS).toBe("GET, POST, PUT, PATCH, DELETE, OPTIONS");
    expect(CORS_MAX_AGE).toBe("86400");
  });

  it("matches local app origins with regex", () => {
    expect(APP_LOCAL_ORIGIN_RE.test("http://localhost:3000")).toBe(true);
    expect(APP_LOCAL_ORIGIN_RE.test("http://127.0.0.1:8080")).toBe(true);
    expect(APP_LOCAL_ORIGIN_RE.test("http://[::1]:5173")).toBe(true);
    expect(APP_LOCAL_ORIGIN_RE.test("http://[0:0:0:0:0:0:0:1]:5173")).toBe(true);
    expect(APP_LOCAL_ORIGIN_RE.test("https://localhost")).toBe(true);

    expect(APP_LOCAL_ORIGIN_RE.test("https://example.com")).toBe(false);
    expect(APP_LOCAL_ORIGIN_RE.test("http://localhost.evil.com")).toBe(false);
    expect(APP_LOCAL_ORIGIN_RE.test("http://notlocalhost:3000")).toBe(false);
  });

  it("matches custom app schemes", () => {
    expect(APP_SCHEME_ORIGIN_RE.test("capacitor://localhost")).toBe(true);
    expect(APP_SCHEME_ORIGIN_RE.test("tauri://localhost")).toBe(true);
    expect(APP_SCHEME_ORIGIN_RE.test("electrobun://app")).toBe(true);
    expect(APP_SCHEME_ORIGIN_RE.test("file://path/to/file")).toBe(true);

    expect(APP_SCHEME_ORIGIN_RE.test("http://example.com")).toBe(false);
  });

  it("identifies local dev loopback origins excluding portless capacitor webview origin", () => {
    expect(CAPACITOR_WEBVIEW_ORIGIN).toBe("https://localhost");

    expect(isLocalDevLoopbackOrigin("http://localhost:3000")).toBe(true);
    expect(isLocalDevLoopbackOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isLocalDevLoopbackOrigin("http://localhost")).toBe(true);
    expect(isLocalDevLoopbackOrigin("https://localhost:8443")).toBe(true);

    // Exact Capacitor WebView origin is excluded from dev loopback classifier
    expect(isLocalDevLoopbackOrigin(CAPACITOR_WEBVIEW_ORIGIN)).toBe(false);

    // Remote origins are not local dev loopback
    expect(isLocalDevLoopbackOrigin("https://eliza.ai")).toBe(false);
    expect(isLocalDevLoopbackOrigin("https://evil.com")).toBe(false);
  });
});
