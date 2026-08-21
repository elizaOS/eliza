/**
 * Adversarial unit coverage for the native-enrollment protocol, including
 * strict binding, expiry, size, single-flight, timeout, backoff, and revocation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_NATIVE_ENROLLMENT_STATE,
  NATIVE_ENROLLMENT_MAX_MESSAGE_BYTES,
  NativeEnrollmentCoordinator,
  type NativeEnrollmentRequest,
  type NativeEnrollmentResponse,
  type NativeEnrollmentState,
} from "./native-enrollment";

const NOW = Date.parse("2026-08-21T18:00:00.000Z");
const PROFILE_ID = "018f0000-0000-4000-8000-000000000001";

function resultFor(
  request: NativeEnrollmentRequest,
  overrides: Partial<NativeEnrollmentResponse> = {},
): NativeEnrollmentResponse {
  return {
    v: 1,
    type: "browser_bridge.enroll_result",
    requestId: request.requestId,
    nonce: request.nonce,
    issuedAt: new Date(NOW).toISOString(),
    config: {
      apiBaseUrl: "http://127.0.0.1:31337",
      companionId: "companion-123",
      pairingToken: "secret-token-value",
      pairingTokenExpiresAt: new Date(NOW + 60 * 60 * 1_000).toISOString(),
      browser: "chrome",
      profileId: PROFILE_ID,
      profileLabel: "Work",
      label: "Chrome Work",
    },
    ...overrides,
  } as NativeEnrollmentResponse;
}

function harness(
  send: (request: NativeEnrollmentRequest) => Promise<unknown>,
  timeoutMs = 5_000,
  initialState: NativeEnrollmentState = { ...EMPTY_NATIVE_ENROLLMENT_STATE },
) {
  let state: NativeEnrollmentState = initialState;
  const coordinator = new NativeEnrollmentCoordinator({
    getExtensionId: () => "abcdefghijklmnopabcdefghijklmnop",
    getExtensionVersion: () => "2.0.3.7",
    send,
    loadState: async () => state,
    saveState: async (next) => {
      state = next;
    },
    now: () => NOW,
    randomUUID: () => "018f0000-0000-4000-8000-000000000001",
    randomBytes: () => new Uint8Array(32).fill(7),
    timeoutMs,
  });
  return { coordinator, state: () => state };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("native enrollment", () => {
  it("accepts a strictly bound, fresh response and clears retry state", async () => {
    let observed: NativeEnrollmentRequest | null = null;
    const test = harness(async (request) => {
      observed = request;
      return resultFor(request);
    });

    await expect(
      test.coordinator.enroll({ browser: "chrome", profileId: PROFILE_ID }),
    ).resolves.toMatchObject({
      companionId: "companion-123",
      browser: "chrome",
      profileId: PROFILE_ID,
    });
    expect(observed).toMatchObject({
      v: 1,
      type: "browser_bridge.enroll",
      browser: "chrome",
      profileId: PROFILE_ID,
      extensionVersion: "2.0.3.7",
    });
    expect(test.state()).toEqual(EMPTY_NATIVE_ENROLLMENT_STATE);
  });

  it("rejects a non-UUID request ID before invoking the native host", async () => {
    const send = vi.fn(async () => ({}));
    let state: NativeEnrollmentState = { ...EMPTY_NATIVE_ENROLLMENT_STATE };
    const coordinator = new NativeEnrollmentCoordinator({
      getExtensionId: () => "abcdefghijklmnopabcdefghijklmnop",
      getExtensionVersion: () => "2.0.3-beta.7",
      send,
      loadState: async () => state,
      saveState: async (next) => {
        state = next;
      },
      now: () => NOW,
      randomUUID: () => "not-a-uuid",
      randomBytes: () => new Uint8Array(32).fill(7),
    });
    await expect(
      coordinator.enroll({ browser: "chrome", profileId: PROFILE_ID }),
    ).rejects.toMatchObject({ code: "invalid_native_request" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong request", { requestId: "wrong-request" }],
    ["wrong nonce", { nonce: "A".repeat(43) }],
    [
      "stale issuance",
      { issuedAt: new Date(NOW - 3 * 60 * 1_000).toISOString() },
    ],
    ["future issuance", { issuedAt: new Date(NOW + 31 * 1_000).toISOString() }],
  ])("rejects %s", async (_label, override) => {
    const test = harness(async (request) => resultFor(request, override));
    await expect(
      test.coordinator.enroll({ browser: "chrome", profileId: PROFILE_ID }),
    ).rejects.toMatchObject({ code: "invalid_native_response" });
  });

  it.each([
    "https://127.0.0.1:31337",
    "http://user:pass@127.0.0.1:31337",
    "http://127.0.0.1:31337/api",
    "http://127.0.0.1:31337?debug=1",
    "http://127.0.0.1:31337#fragment",
    "http://127.0.0.1.attacker.example:31337",
    "http://192.168.1.20:31337",
    "http://127.0.0.1:31337/",
  ])("rejects non-exact loopback API base %s", async (apiBaseUrl) => {
    const test = harness(async (request) => {
      const response = resultFor(request);
      if (response.type !== "browser_bridge.enroll_result") return response;
      return { ...response, config: { ...response.config, apiBaseUrl } };
    });
    await expect(
      test.coordinator.enroll({ browser: "chrome", profileId: PROFILE_ID }),
    ).rejects.toMatchObject({ code: "invalid_native_response" });
  });

  it.each([
    ["short token", { pairingToken: "short" }],
    ["oversized token", { pairingToken: "x".repeat(4_097) }],
    ["token whitespace", { pairingToken: ` ${"x".repeat(16)}` }],
    ["empty profile label", { profileLabel: "" }],
    ["oversized label", { label: "x".repeat(257) }],
    ["control character", { profileLabel: "Work\nProfile" }],
    ["empty companion ID", { companionId: "" }],
  ])("rejects invalid bounded config field %s", async (_label, config) => {
    const test = harness(async (request) => {
      const response = resultFor(request);
      if (response.type !== "browser_bridge.enroll_result") return response;
      return { ...response, config: { ...response.config, ...config } };
    });
    await expect(
      test.coordinator.enroll({ browser: "chrome", profileId: PROFILE_ID }),
    ).rejects.toMatchObject({ code: "invalid_native_response" });
  });

  it.each([
    ["browser", { browser: "firefox" }],
    ["profile", { profileId: "different-profile" }],
    [
      "expired credential",
      { pairingTokenExpiresAt: new Date(NOW - 1).toISOString() },
    ],
  ])("rejects a mismatched or expired config %s", async (_label, config) => {
    const test = harness(async (request) => {
      const response = resultFor(request);
      if (response.type !== "browser_bridge.enroll_result") return response;
      return { ...response, config: { ...response.config, ...config } };
    });
    await expect(
      test.coordinator.enroll({ browser: "chrome", profileId: PROFILE_ID }),
    ).rejects.toMatchObject({ code: "invalid_native_response" });
  });

  it("rejects unknown response fields and messages larger than 64 KiB", async () => {
    const unknownField = harness(async (request) => ({
      ...resultFor(request),
      unexpected: true,
    }));
    await expect(
      unknownField.coordinator.enroll({
        browser: "chrome",
        profileId: PROFILE_ID,
      }),
    ).rejects.toMatchObject({ code: "invalid_native_response" });

    const oversized = harness(async (request) => ({
      ...resultFor(request),
      padding: "x".repeat(NATIVE_ENROLLMENT_MAX_MESSAGE_BYTES),
    }));
    await expect(
      oversized.coordinator.enroll({
        browser: "chrome",
        profileId: PROFILE_ID,
      }),
    ).rejects.toMatchObject({ code: "native_message_too_large" });
  });

  it("deduplicates concurrent enrollment for the same browser profile", async () => {
    let resolveResponse: ((value: unknown) => void) | null = null;
    const send = vi.fn(
      async (request: NativeEnrollmentRequest) =>
        await new Promise((resolve) => {
          resolveResponse = () => resolve(resultFor(request));
        }),
    );
    const test = harness(send);
    const first = test.coordinator.enroll({
      browser: "chrome",
      profileId: PROFILE_ID,
    });
    const second = test.coordinator.enroll({
      browser: "chrome",
      profileId: PROFILE_ID,
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    resolveResponse?.(null);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("times out, persists bounded backoff, and blocks an early retry", async () => {
    vi.useFakeTimers();
    const test = harness(async () => await new Promise(() => undefined), 100);
    const pending = test.coordinator.enroll({
      browser: "chrome",
      profileId: PROFILE_ID,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      code: "native_enrollment_timeout",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(test.state()).toMatchObject({
      consecutiveFailures: 1,
      lastFailureCode: "native_enrollment_timeout",
      nextAttemptAt: new Date(NOW + 1_000).toISOString(),
    });
    await expect(
      test.coordinator.enroll({ browser: "chrome", profileId: PROFILE_ID }),
    ).rejects.toMatchObject({ code: "native_enrollment_backoff" });
  });

  it("lets one explicit retry bypass backoff without bypassing validation", async () => {
    const send = vi.fn(async (request: NativeEnrollmentRequest) =>
      resultFor(request),
    );
    const test = harness(send, 5_000, {
      consecutiveFailures: 2,
      nextAttemptAt: new Date(NOW + 60_000).toISOString(),
      lastFailureCode: "app_not_running",
      suppressedReason: null,
    });
    await expect(
      test.coordinator.enroll(
        { browser: "chrome", profileId: PROFILE_ID },
        { bypassBackoff: true },
      ),
    ).resolves.toMatchObject({ companionId: "companion-123" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("persists revocation suppression and does not call the host again", async () => {
    const send = vi.fn(async (request: NativeEnrollmentRequest) => ({
      v: 1,
      type: "browser_bridge.error",
      requestId: request.requestId,
      code: "revoked",
      retryable: false,
    }));
    const test = harness(send);
    await expect(
      test.coordinator.enroll({ browser: "chrome", profileId: PROFILE_ID }),
    ).rejects.toMatchObject({
      code: "revoked",
    });
    expect(test.state().suppressedReason).toBe("companion_revoked");
    await expect(
      test.coordinator.enroll(
        { browser: "chrome", profileId: PROFILE_ID },
        { bypassBackoff: true },
      ),
    ).rejects.toMatchObject({ code: "native_enrollment_suppressed" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["unknown code", "companion_revoked", false],
    ["prototype code", "constructor", false],
    ["forged retryability", "revoked", true],
    ["forged non-retryability", "app_not_running", false],
  ])(
    "rejects %s without creating a suppression tombstone",
    async (_label, code, retryable) => {
      const test = harness(async (request) => ({
        v: 1,
        type: "browser_bridge.error",
        requestId: request.requestId,
        code,
        retryable,
      }));
      await expect(
        test.coordinator.enroll({ browser: "chrome", profileId: PROFILE_ID }),
      ).rejects.toMatchObject({ code: "invalid_native_response" });
      expect(test.state().suppressedReason).toBeNull();
    },
  );

  it("fails closed when a conflicting profile starts during enrollment", async () => {
    let resolveResponse: ((value: unknown) => void) | null = null;
    let observedRequest: NativeEnrollmentRequest | null = null;
    const test = harness(
      async (request) =>
        await new Promise((resolve) => {
          observedRequest = request;
          resolveResponse = resolve;
        }),
    );
    const first = test.coordinator.enroll({
      browser: "chrome",
      profileId: PROFILE_ID,
    });
    await vi.waitFor(() => expect(observedRequest).not.toBeNull());
    await expect(
      test.coordinator.enroll({
        browser: "chrome",
        profileId: "another-profile",
      }),
    ).rejects.toMatchObject({ code: "native_enrollment_conflict" });
    if (!observedRequest) throw new Error("missing native enrollment request");
    resolveResponse?.(resultFor(observedRequest));
    await expect(first).resolves.toMatchObject({ profileId: PROFILE_ID });
  });
});
