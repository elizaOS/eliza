/**
 * Exercises extension Disconnect through the authenticated native host and
 * desktop broker into the owner-cookie and CSRF revocation boundary.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type NativeRevokeRequest,
  revokeNativeCompanion,
} from "../../../../../browser-bridge-extension/src/native-enrollment";
import type { FetchLike } from "./auth-bridge";
import type { BrowserBridgeBrokerTransport } from "./browser-bridge-broker-transport";
import { BrowserBridgeEnrollmentBroker } from "./browser-bridge-enrollment-broker";
import { BrowserBridgeNativeHost } from "./browser-bridge-native-host";

const callerId = "abcdefghijklmnopabcdefghijklmnop";
const requestId = "123e4567-e89b-42d3-a456-426614174000";
const profileId = "123e4567-e89b-42d3-a456-426614174001";

describe("browser bridge native revoke integration", () => {
  it("keeps owner credentials in the broker while revoking the requested companion", async () => {
    const ownerFetch = vi.fn<FetchLike>(
      async (_input, _init) =>
        new Response(JSON.stringify({ revoked: true }), { status: 200 }),
    );
    const secret = Buffer.alloc(32, 21);
    const nowMs = 1_800_000_000_000;
    const broker = new BrowserBridgeEnrollmentBroker({
      apiBase: "http://127.0.0.1:31337",
      ownerSession: async () => ({
        sessionId: "owner-session",
        csrfToken: "owner-csrf",
        expiresAt: Date.now() + 60_000,
      }),
      brokerSecret: secret,
      callerAllowlist: {
        chromeExtensionIds: [callerId],
        firefoxExtensionIds: [],
        safariExtensionIds: [],
      },
      fetchImpl: ownerFetch,
      now: () => nowMs,
    });
    const transport: BrowserBridgeBrokerTransport = {
      descriptor: {
        kind: "unix",
        socketPath: "/tmp/browser-bridge-revoke.sock",
        directoryMode: 0o700,
        socketMode: 0o600,
        expectedUid: 501,
        directoryPolicy: "managed",
      },
      request: async (bytes) =>
        Buffer.from(
          JSON.stringify(
            await broker.handle(
              JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown,
            ),
          ),
        ),
    };
    const host = new BrowserBridgeNativeHost({
      launchedCaller: { browser: "chrome", id: callerId },
      allowlist: {
        chromeExtensionIds: [callerId],
        firefoxExtensionIds: [],
        safariExtensionIds: [],
      },
      brokerSecret: secret,
      transport,
      now: () => nowMs,
    });

    await expect(
      revokeNativeCompanion({
        config: {
          apiBaseUrl: "http://127.0.0.1:31337",
          companionId: "companion-1",
          pairingToken: "extension-pairing-token",
          pairingTokenExpiresAt: "2030-01-01T00:00:00.000Z",
          browser: "chrome",
          profileId,
          profileLabel: "Personal",
          label: "Chrome Personal",
        },
        extensionId: callerId,
        extensionVersion: "1.2.3",
        randomUUID: () => requestId,
        randomBytes: () => new Uint8Array(32).fill(12),
        send: async (request: NativeRevokeRequest) =>
          await host.handle(request),
      }),
    ).resolves.toBeUndefined();

    expect(ownerFetch).toHaveBeenCalledTimes(1);
    const init = ownerFetch.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({
      cookie: "eliza_session=owner-session",
      "x-eliza-csrf": "owner-csrf",
    });
    expect(init?.headers).not.toHaveProperty("authorization");
    expect(JSON.stringify(init)).not.toContain("extension-pairing-token");
  });
});
