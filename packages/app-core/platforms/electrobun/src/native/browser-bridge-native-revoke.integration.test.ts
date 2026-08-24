/**
 * Exercises extension Disconnect through the authenticated native host and
 * desktop broker into the owner-cookie and CSRF revocation boundary.
 */

import { describe, expect, it, vi } from "vitest";
import type { BrowserBridgeCompanionConfig } from "../../../../../browser-bridge-extension/src/browser-bridge-contracts";
import { performDurableDisconnect } from "../../../../../browser-bridge-extension/src/durable-disconnect";
import {
  EMPTY_NATIVE_ENROLLMENT_STATE,
  NativeEnrollmentCoordinator,
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

  it("quiesces delayed enrollment and revokes both old and newly minted companions before clearing", async () => {
    const activeCompanions = new Set(["companion-old"]);
    let releasePair!: () => void;
    const pairRelease = new Promise<void>((resolve) => {
      releasePair = resolve;
    });
    let notifyPairStarted!: () => void;
    const pairStarted = new Promise<void>((resolve) => {
      notifyPairStarted = resolve;
    });
    const ownerFetch = vi.fn<FetchLike>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/pair")) {
        activeCompanions.add("companion-new");
        notifyPairStarted();
        await pairRelease;
        return new Response(
          JSON.stringify({
            companion: {
              id: "companion-new",
              browser: "chrome",
              profileId,
              profileLabel: "Personal",
              label: "Chrome Personal",
            },
            pairingToken: "new-pairing-token",
            pairingTokenExpiresAt: null,
          }),
          { status: 201 },
        );
      }
      const match = url.pathname.match(/\/companions\/([^/]+)\/revoke$/);
      if (!match) return new Response("not found", { status: 404 });
      activeCompanions.delete(decodeURIComponent(match[1]));
      return new Response(JSON.stringify({ revoked: true }), { status: 200 });
    });
    const secret = Buffer.alloc(32, 22);
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
        socketPath: "/tmp/browser-bridge-race.sock",
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
    let state = { ...EMPTY_NATIVE_ENROLLMENT_STATE };
    const coordinator = new NativeEnrollmentCoordinator({
      getExtensionId: () => callerId,
      getExtensionVersion: () => "1.2.3",
      send: async (request) => await host.handle(request),
      loadState: async () => state,
      saveState: async (next) => {
        state = next;
      },
      now: () => nowMs,
      randomUUID: () => requestId,
      randomBytes: () => new Uint8Array(32).fill(13),
      timeoutMs: 10,
    });
    const oldConfig = {
      apiBaseUrl: "http://127.0.0.1:31337",
      companionId: "companion-old",
      pairingToken: "old-pairing-token",
      pairingTokenExpiresAt: "2030-01-01T00:00:00.000Z",
      browser: "chrome" as const,
      profileId,
      profileLabel: "Personal",
      label: "Chrome Personal",
    };
    let persistedConfig: BrowserBridgeCompanionConfig | null = oldConfig;
    const enrollment = coordinator.enroll({ browser: "chrome", profileId });
    await pairStarted;
    await expect(enrollment).rejects.toMatchObject({
      code: "native_enrollment_timeout",
    });

    let abandonedConfigs: readonly BrowserBridgeCompanionConfig[] = [];
    const disconnect = performDurableDisconnect({
      cancelSync: async () => undefined,
      cancelEnrollment: async () => {
        abandonedConfigs = await coordinator.cancel();
      },
      revoke: async () => {
        const targets = [persistedConfig, ...abandonedConfigs].filter(
          (config): config is BrowserBridgeCompanionConfig => config !== null,
        );
        await Promise.all(
          targets.map(
            async (config) =>
              await revokeNativeCompanion({
                config,
                extensionId: callerId,
                extensionVersion: "1.2.3",
                send: async (request) => await host.handle(request),
              }),
          ),
        );
      },
      suppressEnrollment: async () => undefined,
      clearConfig: async () => {
        expect(activeCompanions.size).toBe(0);
        persistedConfig = null;
      },
    });
    expect(activeCompanions).toEqual(
      new Set(["companion-old", "companion-new"]),
    );
    releasePair();
    await disconnect;
    expect(activeCompanions.size).toBe(0);
    expect(persistedConfig).toBeNull();
  });
});
