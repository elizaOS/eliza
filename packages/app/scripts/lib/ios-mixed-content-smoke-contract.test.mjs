/**
 * Regression coverage for the iOS onboarding mixed-content simulator contract.
 */
import { describe, expect, it } from "vitest";
import { assertIosMixedContentSmokeResult } from "./ios-mixed-content-smoke-contract.mjs";

function validResult(overrides = {}) {
  return {
    webViewOrigin: "capacitor://localhost",
    mixedContentWouldBlockWebSocket: false,
    webSocketConstructorCalls: [],
    connectionState: { state: "connected" },
    lostBackendOverlayAbsent: true,
    restHealth: { ok: true },
    ...overrides,
  };
}

describe("assertIosMixedContentSmokeResult", () => {
  it("accepts the current iOS Capacitor WebView origin when REST is connected and no WebSocket is attempted", () => {
    expect(() => assertIosMixedContentSmokeResult(validResult())).not.toThrow();
  });

  it("keeps the historical https://localhost contract when a build actually runs from that origin", () => {
    expect(() =>
      assertIosMixedContentSmokeResult(
        validResult({
          webViewOrigin: "https://localhost",
          mixedContentWouldBlockWebSocket: true,
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

  it("rejects WebSocket construction even on capacitor://localhost", () => {
    expect(() =>
      assertIosMixedContentSmokeResult(
        validResult({
          webSocketConstructorCalls: ["ws://127.0.0.1:31338/ws"],
        }),
      ),
    ).toThrow(/attempted a WebSocket/);
  });

  it("rejects disconnected REST state", () => {
    expect(() =>
      assertIosMixedContentSmokeResult(
        validResult({
          connectionState: { state: "disconnected" },
        }),
      ),
    ).toThrow(/not connected-over-REST/);
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
        }),
      ),
    ).toThrow(/did not prove an insecure ws/);
  });
});
