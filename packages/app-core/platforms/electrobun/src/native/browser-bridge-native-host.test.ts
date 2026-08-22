/** Exercises native-host request binding over a deterministic current-user broker transport. */

import { describe, expect, it, vi } from "vitest";
import type { BrowserBridgeBrokerTransport } from "./browser-bridge-broker-transport";
import { BrowserBridgeNativeHost } from "./browser-bridge-native-host";
import type { BrowserBridgeBrokerEnvelope } from "./browser-bridge-native-protocol";

const callerId = "abcdefghijklmnopabcdefghijklmnop";
const requestId = "123e4567-e89b-42d3-a456-426614174000";
const profileId = "123e4567-e89b-42d3-a456-426614174001";
const nonce = Buffer.alloc(32, 8).toString("base64url");
const request = {
  v: 1 as const,
  type: "browser_bridge.enroll" as const,
  requestId,
  nonce,
  browser: "chrome" as const,
  extensionId: callerId,
  extensionVersion: "1.2.3",
  profileId,
};

function transportReturning(value: unknown): BrowserBridgeBrokerTransport {
  return {
    descriptor: {
      kind: "unix",
      socketPath: "/tmp/browser-bridge.sock",
      directoryMode: 0o700,
      socketMode: 0o600,
      expectedUid: 501,
      directoryPolicy: "managed",
    },
    request: vi.fn(async (bytes: Uint8Array) => {
      const envelope = JSON.parse(
        Buffer.from(bytes).toString("utf8"),
      ) as BrowserBridgeBrokerEnvelope;
      expect(envelope.request).toEqual(request);
      expect(envelope.caller).toEqual({ browser: "chrome", id: callerId });
      expect(envelope.mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
      return Buffer.from(JSON.stringify(value), "utf8");
    }),
  };
}

describe("browser bridge native host", () => {
  it("authenticates the launch caller and returns an exactly bound result", async () => {
    const response = {
      v: 1,
      type: "browser_bridge.enroll_result",
      requestId,
      nonce,
      issuedAt: "2027-01-15T08:00:00.000Z",
      config: {
        apiBaseUrl: "http://127.0.0.1:31337",
        companionId: "companion-1",
        pairingToken: "pairing-secret",
        pairingTokenExpiresAt: "2027-01-15T08:05:00.000Z",
        browser: "chrome",
        profileId,
        profileLabel: "Personal",
        label: "Chrome Personal",
      },
    };
    const host = new BrowserBridgeNativeHost({
      launchedCaller: { browser: "chrome", id: callerId },
      allowlist: {
        chromeExtensionIds: [callerId],
        firefoxExtensionIds: [],
        safariExtensionIds: [],
      },
      brokerSecret: Buffer.alloc(32, 4),
      transport: transportReturning(response),
      now: () => 1_800_000_000_000,
    });

    await expect(host.handle(request)).resolves.toEqual(response);
  });

  it("rejects a rogue launch caller and mismatched broker echo", async () => {
    const rogue = new BrowserBridgeNativeHost({
      launchedCaller: {
        browser: "chrome",
        id: "ponmlkjihgfedcbaponmlkjihgfedcba",
      },
      allowlist: {
        chromeExtensionIds: [callerId],
        firefoxExtensionIds: [],
        safariExtensionIds: [],
      },
      brokerSecret: Buffer.alloc(32, 4),
      transport: transportReturning({}),
    });
    await expect(rogue.handle(request)).rejects.toMatchObject({
      code: "caller_not_allowed",
    });

    const mismatch = new BrowserBridgeNativeHost({
      launchedCaller: { browser: "chrome", id: callerId },
      allowlist: {
        chromeExtensionIds: [callerId],
        firefoxExtensionIds: [],
        safariExtensionIds: [],
      },
      brokerSecret: Buffer.alloc(32, 4),
      transport: transportReturning({
        v: 1,
        type: "browser_bridge.error",
        requestId: "123e4567-e89b-42d3-a456-426614174009",
        code: "broker_unavailable",
        retryable: true,
      }),
    });
    await expect(mismatch.handle(request)).rejects.toMatchObject({
      code: "response_binding_mismatch",
    });
  });
});
