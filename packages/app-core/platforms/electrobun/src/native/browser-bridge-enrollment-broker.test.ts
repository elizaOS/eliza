/** Exercises authenticated broker enrollment and canonical bounded responses. */

import { describe, expect, it, vi } from "vitest";
import { BrowserBridgeEnrollmentBroker } from "./browser-bridge-enrollment-broker";
import {
  BROWSER_BRIDGE_BROKER_PROTOCOL,
  signBrokerEnvelope,
} from "./browser-bridge-native-protocol";

const secret = Buffer.alloc(32, 9);
const nowMs = 1_800_000_000_000;
const callerId = "abcdefghijklmnopabcdefghijklmnop";
const requestId = "123e4567-e89b-42d3-a456-426614174000";
const profileId = "123e4567-e89b-42d3-a456-426614174001";

function request(nonce = Buffer.alloc(32, 4).toString("base64url")) {
  return signBrokerEnvelope(
    {
      protocol: BROWSER_BRIDGE_BROKER_PROTOCOL,
      timestampMs: nowMs,
      caller: { browser: "chrome", id: callerId },
      request: {
        v: 1,
        type: "browser_bridge.enroll",
        requestId,
        nonce,
        browser: "chrome",
        extensionId: callerId,
        extensionVersion: "1.2.3",
        profileId,
      },
    },
    secret,
  );
}

const baseOptions = {
  apiBase: "http://127.0.0.1:31337",
  brokerSecret: secret,
  callerAllowlist: {
    chromeExtensionIds: [callerId],
    firefoxExtensionIds: [],
    safariExtensionIds: [],
  },
  now: () => nowMs,
};

describe("browser bridge enrollment broker", () => {
  it("returns the canonical narrow config after native and owner authentication", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            companion: {
              id: "companion-1",
              browser: "chrome",
              profileId,
              profileLabel: "Personal",
              label: "Chrome Personal",
            },
            pairingToken: "pairing-secret",
            pairingTokenExpiresAt: null,
          }),
          { status: 201 },
        ),
    );
    const broker = new BrowserBridgeEnrollmentBroker({
      ...baseOptions,
      ownerSession: async () => ({
        sessionId: "owner-session",
        csrfToken: "owner-csrf",
        expiresAt: Date.now() + 60_000,
      }),
      fetchImpl,
    });

    await expect(broker.handle(request())).resolves.toEqual({
      v: 1,
      type: "browser_bridge.enroll_result",
      requestId,
      nonce: Buffer.alloc(32, 4).toString("base64url"),
      issuedAt: new Date(nowMs).toISOString(),
      config: {
        apiBaseUrl: "http://127.0.0.1:31337",
        companionId: "companion-1",
        pairingToken: "pairing-secret",
        pairingTokenExpiresAt: new Date(nowMs + 5 * 60_000).toISOString(),
        browser: "chrome",
        profileId,
        profileLabel: "Personal",
        label: "Chrome Personal",
      },
    });
  });

  it("returns bounded errors without owner authority or adapter detail", async () => {
    const unavailable = new BrowserBridgeEnrollmentBroker({
      ...baseOptions,
      ownerSession: async () => null,
    });
    await expect(unavailable.handle(request())).resolves.toMatchObject({
      v: 1,
      type: "browser_bridge.error",
      requestId,
      code: "app_not_authenticated",
      retryable: true,
    });

    const adapterFailure = new BrowserBridgeEnrollmentBroker({
      ...baseOptions,
      ownerSession: async () => ({
        sessionId: "owner-session",
        csrfToken: "owner-csrf",
        expiresAt: Date.now() + 60_000,
      }),
      fetchImpl: async () =>
        new Response("secret internal detail", { status: 500 }),
    });
    const response = await adapterFailure.handle(
      request(Buffer.alloc(32, 5).toString("base64url")),
    );
    expect(response).toMatchObject({
      v: 1,
      type: "browser_bridge.error",
      requestId,
      code: "broker_unavailable",
      retryable: true,
    });
    expect(JSON.stringify(response)).not.toContain("secret internal detail");
  });

  it("maps forged authentication, replay, and stale envelopes to retryable bounded errors", async () => {
    const broker = new BrowserBridgeEnrollmentBroker({
      ...baseOptions,
      ownerSession: async () => ({
        sessionId: "owner-session",
        csrfToken: "owner-csrf",
        expiresAt: Date.now() + 60_000,
      }),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            companion: {
              id: "companion-1",
              browser: "chrome",
              profileId,
              profileLabel: "Personal",
              label: "Chrome Personal",
            },
            pairingToken: "pairing-secret",
            pairingTokenExpiresAt: null,
          }),
          { status: 201 },
        ),
    });
    const valid = request(Buffer.alloc(32, 6).toString("base64url"));
    expect(
      await broker.handle({ ...valid, mac: "A".repeat(43) }),
    ).toMatchObject({
      type: "browser_bridge.error",
      code: "broker_unavailable",
      retryable: true,
    });
    expect((await broker.handle(valid)).type).toBe(
      "browser_bridge.enroll_result",
    );
    expect(await broker.handle(valid)).toMatchObject({
      type: "browser_bridge.error",
      code: "broker_unavailable",
      retryable: true,
    });
    const stale = signBrokerEnvelope(
      {
        protocol: BROWSER_BRIDGE_BROKER_PROTOCOL,
        timestampMs: nowMs - 60_001,
        caller: { browser: "chrome", id: callerId },
        request: {
          ...request().request,
          nonce: Buffer.alloc(32, 7).toString("base64url"),
        },
      },
      secret,
    );
    expect(await broker.handle(stale)).toMatchObject({
      type: "browser_bridge.error",
      code: "broker_unavailable",
      retryable: true,
    });
  });

  it("preserves the typed revoked pairing state at the extension boundary", async () => {
    const broker = new BrowserBridgeEnrollmentBroker({
      ...baseOptions,
      ownerSession: async () => ({
        sessionId: "owner-session",
        csrfToken: "owner-csrf",
        expiresAt: Date.now() + 60_000,
      }),
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: "revoked" }), { status: 403 }),
    });
    await expect(
      broker.handle(request(Buffer.alloc(32, 8).toString("base64url"))),
    ).resolves.toMatchObject({
      type: "browser_bridge.error",
      requestId,
      code: "revoked",
      retryable: false,
    });
  });
});
