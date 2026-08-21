/** Exercises canonical native-messaging framing and authenticated broker envelopes. */

import { describe, expect, it } from "vitest";
import {
  authenticateBrokerEnvelope,
  BROWSER_BRIDGE_BROKER_PROTOCOL,
  type BrowserBridgeBrokerEnvelope,
  BrowserBridgeNativeProtocolError,
  canonicalBrokerEnvelopeData,
  createAuthenticatedBrokerEnvelope,
  encodeNativeMessage,
  MAX_NATIVE_MESSAGE_BYTES,
  NativeEnrollmentReplayGuard,
  NativeMessageDecoder,
  parseBrokerEnvelope,
  parseNativeEnrollmentRequest,
  parseNativeHostLaunchCaller,
  signBrokerEnvelope,
} from "./browser-bridge-native-protocol";

const secret = Buffer.alloc(32, 7);
const nowMs = 1_800_000_000_000;
const chromeId = "abcdefghijklmnopabcdefghijklmnop";
const requestId = "123e4567-e89b-42d3-a456-426614174000";
const profileId = "123e4567-e89b-42d3-a456-426614174001";
const nonce = Buffer.alloc(32, 3).toString("base64url");
const allowlist = {
  chromeExtensionIds: [chromeId],
  firefoxExtensionIds: ["bridge@elizaos.ai"],
  safariExtensionIds: [],
};

function request(overrides: Record<string, unknown> = {}) {
  return parseNativeEnrollmentRequest({
    v: 1,
    type: "browser_bridge.enroll",
    requestId,
    nonce,
    browser: "chrome",
    extensionId: chromeId,
    extensionVersion: "1.2.3",
    profileId,
    ...overrides,
  });
}

function signedEnvelope(overrides: Record<string, unknown> = {}) {
  return signBrokerEnvelope(
    {
      protocol: BROWSER_BRIDGE_BROKER_PROTOCOL,
      timestampMs: nowMs,
      caller: { browser: "chrome", id: chromeId },
      request: request(),
      ...overrides,
    },
    secret,
  );
}

describe("browser bridge native protocol", () => {
  it("decodes split and coalesced 64 KiB-bounded little-endian frames", () => {
    const first = encodeNativeMessage(request());
    const second = encodeNativeMessage({ value: 2 });
    const bytes = Buffer.concat([first, second]);
    const decoder = new NativeMessageDecoder();

    expect(decoder.push(bytes.subarray(0, 3))).toEqual([]);
    expect(decoder.push(bytes.subarray(3, first.length + 2))).toEqual([
      request(),
    ]);
    expect(decoder.push(bytes.subarray(first.length + 2))).toEqual([
      { value: 2 },
    ]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("rejects oversized, zero-length, truncated, and malformed frames", () => {
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1);
    expect(() => new NativeMessageDecoder().push(oversized)).toThrowError(
      expect.objectContaining({ code: "invalid_frame_length" }),
    );
    expect(() => new NativeMessageDecoder().push(Buffer.alloc(4))).toThrowError(
      expect.objectContaining({ code: "invalid_frame_length" }),
    );
    const truncated = new NativeMessageDecoder();
    truncated.push(encodeNativeMessage({ ok: true }).subarray(0, 6));
    expect(() => truncated.finish()).toThrowError(
      expect.objectContaining({ code: "truncated_frame" }),
    );
    const invalidJson = Buffer.alloc(5);
    invalidJson.writeUInt32LE(1);
    invalidJson[4] = 0xff;
    expect(() => new NativeMessageDecoder().push(invalidJson)).toThrowError(
      expect.objectContaining({ code: "invalid_json" }),
    );
  });

  it("accepts only the exact canonical enrollment request", () => {
    expect(request()).toEqual({
      v: 1,
      type: "browser_bridge.enroll",
      requestId,
      nonce,
      browser: "chrome",
      extensionId: chromeId,
      extensionVersion: "1.2.3",
      profileId,
    });
    expect(() => request({ token: "secret" })).toThrowError(
      new BrowserBridgeNativeProtocolError(
        "unknown_field",
        "native enrollment message contains unknown field: token",
      ),
    );
    expect(() => request({ requestId: "request-1" })).toThrow("must be a UUID");
    expect(() => request({ nonce: "short" })).toThrow("32 bytes");
    expect(() => request({ extensionVersion: "latest" })).toThrow(
      "semantic versioning",
    );
  });

  it("binds the native launch caller before signing the broker envelope", () => {
    expect(
      createAuthenticatedBrokerEnvelope({
        request: request(),
        launchedCaller: { browser: "chrome", id: chromeId },
        allowlist,
        secret,
        timestampMs: nowMs,
      }),
    ).toEqual(signedEnvelope());
    expect(() =>
      createAuthenticatedBrokerEnvelope({
        request: request(),
        launchedCaller: {
          browser: "chrome",
          id: "ponmlkjihgfedcbaponmlkjihgfedcba",
        },
        allowlist,
        secret,
      }),
    ).toThrowError(expect.objectContaining({ code: "caller_not_allowed" }));
  });

  it("normalizes only exact browser-supplied launch caller identities", () => {
    expect(
      parseNativeHostLaunchCaller("chrome", `chrome-extension://${chromeId}/`),
    ).toEqual({ browser: "chrome", id: chromeId });
    expect(parseNativeHostLaunchCaller("firefox", "bridge@elizaos.ai")).toEqual(
      {
        browser: "firefox",
        id: "bridge@elizaos.ai",
      },
    );
    expect(() =>
      parseNativeHostLaunchCaller(
        "chrome",
        `chrome-extension://${chromeId}/forged`,
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_caller" }));
    expect(() =>
      parseNativeHostLaunchCaller("firefox", "bridge@elizaos.ai/forged"),
    ).toThrowError(expect.objectContaining({ code: "invalid_caller" }));
  });

  it("authenticates an exact caller and consumes each nonce once", () => {
    const envelope = parseBrokerEnvelope(signedEnvelope());
    const replayGuard = new NativeEnrollmentReplayGuard();
    const options = { secret, allowlist, replayGuard, nowMs };

    expect(() => authenticateBrokerEnvelope(envelope, options)).not.toThrow();
    expect(() => authenticateBrokerEnvelope(envelope, options)).toThrowError(
      expect.objectContaining({ code: "replayed_nonce" }),
    );
  });

  it("publishes a cross-language UTF-8 HMAC compatibility vector", () => {
    const unsigned: Omit<BrowserBridgeBrokerEnvelope, "mac"> = {
      protocol: BROWSER_BRIDGE_BROKER_PROTOCOL,
      timestampMs: nowMs,
      caller: {
        browser: "safari" as const,
        id: "ai.elizaos.browserbridge.app.Extension",
      },
      request: {
        ...request({
          browser: "safari",
          extensionId: "ai.elizaos.browserbridge.app.Extension",
        }),
      },
    };
    expect(canonicalBrokerEnvelopeData(unsigned)).toBe(
      [
        "eliza.browser-bridge.broker/v1",
        "1800000000000",
        "safari",
        "ai.elizaos.browserbridge.app.Extension",
        "1",
        "browser_bridge.enroll",
        requestId,
        nonce,
        "safari",
        "ai.elizaos.browserbridge.app.Extension",
        "1.2.3",
        profileId,
      ].join("\n"),
    );
    expect(signBrokerEnvelope(unsigned, Buffer.alloc(32, 7)).mac).toBe(
      "flk7dxI31fluBOnI6VeU45TGFie5SZuQ-5b10f_2m7I",
    );
  });

  it("fails closed for forged MACs, stale envelopes, and caller/request mismatch", () => {
    const authenticate = (input: unknown, clock = nowMs) =>
      authenticateBrokerEnvelope(parseBrokerEnvelope(input), {
        secret,
        allowlist,
        replayGuard: new NativeEnrollmentReplayGuard(),
        nowMs: clock,
      });
    expect(() =>
      authenticate({ ...signedEnvelope(), mac: "A".repeat(43) }),
    ).toThrowError(expect.objectContaining({ code: "invalid_mac" }));
    expect(() => authenticate(signedEnvelope(), nowMs + 30_001)).toThrowError(
      expect.objectContaining({ code: "stale_timestamp" }),
    );
    expect(() =>
      authenticate(
        signedEnvelope({
          caller: { browser: "firefox", id: "bridge@elizaos.ai" },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "caller_not_allowed" }));
  });
});
