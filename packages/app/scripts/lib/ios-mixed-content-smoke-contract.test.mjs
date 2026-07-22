/**
 * Regression coverage for the iOS onboarding mixed-content simulator contract.
 */
import { describe, expect, it } from "vitest";
import { assertIosMixedContentSmokeResult } from "./ios-mixed-content-smoke-contract.mjs";

function validResult(overrides = {}) {
  return {
    phase: "complete",
    ok: true,
    webViewOrigin: "capacitor://localhost",
    mixedContentWouldBlockWebSocket: false,
    expectedWebSocketUrl: "ws://127.0.0.1:31338/ws",
    webSocketExpected: true,
    webSocketConstructorCalls: ["ws://127.0.0.1:31338/ws?clientId=ios-smoke"],
    webSocketOpenCalls: ["ws://127.0.0.1:31338/ws?clientId=ios-smoke"],
    connectionState: { state: "connected" },
    lostBackendOverlayAbsent: true,
    restHealth: { ok: true },
    ...overrides,
  };
}

describe("assertIosMixedContentSmokeResult", () => {
  it("accepts the current iOS Capacitor origin after the realtime WebSocket opens", () => {
    expect(() => assertIosMixedContentSmokeResult(validResult())).not.toThrow();
  });

  it("keeps the historical https://localhost contract when a build actually runs from that origin", () => {
    expect(() =>
      assertIosMixedContentSmokeResult(
        validResult({
          webViewOrigin: "https://localhost",
          mixedContentWouldBlockWebSocket: true,
          webSocketExpected: false,
          webSocketConstructorCalls: [],
          webSocketOpenCalls: [],
        }),
      ),
    ).not.toThrow();
  });

  it("rejects unsupported origins", () => {
    expect(() =>
      assertIosMixedContentSmokeResult(
        validResult({ webViewOrigin: "http://localhost" }),
      ),
    ).toThrow(/unsupported WebView origin/);
  });

  it("rejects a terminal unsuccessful result", () => {
    expect(() =>
      assertIosMixedContentSmokeResult(validResult({ ok: false })),
    ).toThrow(/completed unsuccessfully/);
  });

  it("rejects a Capacitor result that never constructs the expected WebSocket", () => {
    expect(() =>
      assertIosMixedContentSmokeResult(
        validResult({
          webSocketConstructorCalls: [],
        }),
      ),
    ).toThrow(/did not construct the expected WebSocket/);
  });

  it("rejects a Capacitor result whose expected WebSocket never opens", () => {
    expect(() =>
      assertIosMixedContentSmokeResult(
        validResult({
          webSocketOpenCalls: [],
        }),
      ),
    ).toThrow(/did not open the expected WebSocket/);
  });

  it("rejects disconnected REST state", () => {
    expect(() =>
      assertIosMixedContentSmokeResult(
        validResult({
          connectionState: { state: "disconnected" },
        }),
      ),
    ).toThrow(/transport was not connected/);
  });

  it("rejects lost-backend overlay visibility", () => {
    expect(() =>
      assertIosMixedContentSmokeResult(
        validResult({
          lostBackendOverlayAbsent: false,
        }),
      ),
    ).toThrow(/lost backend overlay/);
  });

  it("rejects impossible mixed-content state for capacitor://localhost", () => {
    expect(() =>
      assertIosMixedContentSmokeResult(
        validResult({
          mixedContentWouldBlockWebSocket: true,
        }),
      ),
    ).toThrow(/impossible mixed-content result/);
  });

  it("rejects https://localhost without the mixed-content proof", () => {
    expect(() =>
      assertIosMixedContentSmokeResult(
        validResult({
          webViewOrigin: "https://localhost",
          mixedContentWouldBlockWebSocket: false,
          webSocketExpected: false,
          webSocketConstructorCalls: [],
          webSocketOpenCalls: [],
        }),
      ),
    ).toThrow(/did not prove an insecure ws/);
  });

  it("rejects an HTTPS mixed-content result that attempts the blocked socket", () => {
    expect(() =>
      assertIosMixedContentSmokeResult(
        validResult({
          webViewOrigin: "https://localhost",
          mixedContentWouldBlockWebSocket: true,
          webSocketExpected: false,
          webSocketOpenCalls: [],
        }),
      ),
    ).toThrow(/attempted a blocked WebSocket/);
  });
});
