/**
 * Companion APNs push handling.
 *
 * Push notifications arrive from the OS and are UNTRUSTED input. Contracts
 * pinned here:
 *  - Non-session intents are ignored without error.
 *  - A session.start intent without a `pairing` field (or with a non-string
 *    one) surfaces a structured error via onError — never a crash, never a
 *    forged onIntent.
 *  - A session.start with an undecodable pairing payload (bad base64, non-
 *    object JSON, empty fields) surfaces the decode error via onError and
 *    never fabricates an intent.
 *  - Permission denial aborts registration with onError; the non-native
 *    platform path registers nothing.
 */

import { __state as capState } from "@capacitor/core";
import {
  __listeners,
  __state as pushState,
  __reset as resetPushMock,
} from "@capacitor/push-notifications";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type PushIntent, registerPush } from "./push";

function encodePayload(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

function fire(event: string, payload: unknown): void {
  const listener = __listeners.find((l) => l.event === event);
  expect(listener, `listener for ${event}`).toBeDefined();
  listener!.cb(payload);
}

const VALID_PAIRING = {
  agentId: "agent-1",
  pairingCode: "code-123",
  ingressUrl: "wss://ingress.example/session",
  sessionToken: "tok-abc",
};

describe("registerPush", () => {
  let onIntent: ReturnType<typeof vi.fn>;
  let onToken: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetPushMock();
    capState.native = true;
    capState.platform = "ios";
    onIntent = vi.fn();
    onToken = vi.fn();
    onError = vi.fn();
  });

  it("registers nothing on non-native platforms", async () => {
    capState.native = false;
    const handle = await registerPush({ onIntent });
    await handle.unregister();
    expect(pushState.registerCalls).toBe(0);
    expect(__listeners).toHaveLength(0);
    expect(onIntent).not.toHaveBeenCalled();
  });

  it("aborts with onError when APNs permission is denied", async () => {
    pushState.permission = "denied";
    const handle = await registerPush({ onIntent, onError });
    expect(pushState.registerCalls).toBe(0);
    expect(__listeners).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0] as Error;
    expect(err.message).toContain("APNs permission not granted");
    expect(err.message).toContain("denied");
    await handle.unregister();
  });

  it("registers all four listeners and calls register() when granted", async () => {
    await registerPush({ onIntent, onToken, onError });
    expect(pushState.registerCalls).toBe(1);
    expect(__listeners.map((l) => l.event)).toEqual([
      "registration",
      "registrationError",
      "pushNotificationReceived",
      "pushNotificationActionPerformed",
    ]);
  });

  it("reports the device token via onToken", async () => {
    await registerPush({ onIntent, onToken });
    fire("registration", { value: "dev-token-1" });
    expect(onToken).toHaveBeenCalledWith("dev-token-1");
  });

  it("reports registration failures via onError", async () => {
    await registerPush({ onIntent, onError });
    fire("registrationError", { error: "invalid token" });
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toContain(
      "APNs registration failed",
    );
  });

  it("ignores non-session intents without error", async () => {
    await registerPush({ onIntent, onError });
    fire("pushNotificationReceived", { data: { intent: "other.kind" } });
    expect(onIntent).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("errors when session.start lacks the pairing field", async () => {
    await registerPush({ onIntent, onError });
    fire("pushNotificationReceived", { data: { intent: "session.start" } });
    expect(onIntent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toContain(
      "missing `pairing` payload field",
    );
  });

  it("errors when pairing is present but not a string", async () => {
    await registerPush({ onIntent, onError });
    fire("pushNotificationReceived", {
      data: { intent: "session.start", pairing: 12345 },
    });
    expect(onIntent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toContain(
      "missing `pairing` payload field",
    );
  });

  it("surfaces decode failures for malformed pairing payloads", async () => {
    await registerPush({ onIntent, onError });
    // Base64 of "not json" — JSON.parse fails inside decodePairingPayload.
    fire("pushNotificationReceived", {
      data: {
        intent: "session.start",
        pairing: Buffer.from("not json").toString("base64"),
      },
    });
    expect(onIntent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("surfaces decode failures for JSON that is not a record", async () => {
    await registerPush({ onIntent, onError });
    fire("pushNotificationReceived", {
      data: { intent: "session.start", pairing: encodePayload(42) },
    });
    expect(onIntent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toContain(
      "PairingPayload decode: not an object",
    );
  });

  it("surfaces decode failures for empty required fields", async () => {
    await registerPush({ onIntent, onError });
    fire("pushNotificationReceived", {
      data: {
        intent: "session.start",
        pairing: encodePayload({ ...VALID_PAIRING, agentId: "  " }),
      },
    });
    expect(onIntent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toContain(
      "agentId must be a non-empty string",
    );
  });

  it("delivers a decoded session-start intent for a valid pairing", async () => {
    await registerPush({ onIntent, onError });
    fire("pushNotificationReceived", {
      data: { intent: "session.start", pairing: encodePayload(VALID_PAIRING) },
    });
    expect(onError).not.toHaveBeenCalled();
    expect(onIntent).toHaveBeenCalledTimes(1);
    const intent = onIntent.mock.calls[0][0] as PushIntent;
    expect(intent.kind).toBe("session-start");
    expect(intent.payload).toEqual(VALID_PAIRING);
  });

  it("handles intents from the actionPerformed path identically", async () => {
    await registerPush({ onIntent, onError });
    fire("pushNotificationActionPerformed", {
      notification: {
        data: {
          intent: "session.start",
          pairing: encodePayload(VALID_PAIRING),
        },
      },
    });
    expect(onIntent).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("unregister removes all listeners", async () => {
    const handle = await registerPush({ onIntent });
    expect(__listeners).toHaveLength(4);
    await handle.unregister();
    expect(__listeners).toHaveLength(0);
  });
});
