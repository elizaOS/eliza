/**
 * Unit tests for cloud CORS constants and loopback origin matcher.
 */

import { describe, expect, it } from "vitest";
import {
  APP_LOCAL_ORIGIN_RE,
  APP_SCHEME_ORIGIN_RE,
  CAPACITOR_WEBVIEW_ORIGIN,
  isLocalDevLoopbackOrigin,
} from "./cors-constants.js";

describe("CORS constants", () => {
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
