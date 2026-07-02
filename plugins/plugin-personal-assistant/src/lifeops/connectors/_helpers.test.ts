/**
 * Real (no-mock) unit suite for the connector translation spine.
 *
 * Exercises the ACTUAL helpers against the REAL `LifeOpsServiceError`
 * (`@elizaos/shared`) — the same class the connectors throw at runtime, so the
 * `instanceof` branch in `errorToDispatchResult` is covered for real rather than
 * against a stand-in. The spine feeds failure-classification / retry /
 * degradation for every send-capable connector, so its mapping and its
 * payload guard must be pinned exactly.
 */
import { LifeOpsServiceError } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  errorToDispatchResult,
  isConnectorSendPayload,
  legacyStatusToConnectorStatus,
  rejectInvalidPayload,
} from "./_helpers.js";
import type { DispatchResult } from "./contract.js";

describe("errorToDispatchResult", () => {
  it("maps 401/410 to auth_expired (user-actionable)", () => {
    for (const status of [401, 410]) {
      const result = errorToDispatchResult(
        new LifeOpsServiceError(status, "token gone"),
      );
      expect(result).toEqual({
        ok: false,
        reason: "auth_expired",
        userActionable: true,
        message: "token gone",
      });
    }
  });

  it("maps 403 to auth_expired (missing permission still needs user action)", () => {
    const result = errorToDispatchResult(
      new LifeOpsServiceError(403, "forbidden"),
    );
    expect(result).toEqual({
      ok: false,
      reason: "auth_expired",
      userActionable: true,
      message: "forbidden",
    });
  });

  it("maps 404 to unknown_recipient", () => {
    const result = errorToDispatchResult(
      new LifeOpsServiceError(404, "no such chat"),
    );
    expect(result).toEqual({
      ok: false,
      reason: "unknown_recipient",
      userActionable: true,
      message: "no such chat",
    });
  });

  it("maps 409 and 503 to disconnected", () => {
    for (const status of [409, 503]) {
      const result = errorToDispatchResult(
        new LifeOpsServiceError(status, "not connected"),
      );
      expect(result).toEqual({
        ok: false,
        reason: "disconnected",
        userActionable: true,
        message: "not connected",
      });
    }
  });

  it("maps 429 to rate_limited with a default retryAfterMinutes", () => {
    const result = errorToDispatchResult(
      new LifeOpsServiceError(429, "slow down"),
    );
    expect(result).toEqual({
      ok: false,
      reason: "rate_limited",
      retryAfterMinutes: 5,
      userActionable: false,
      message: "slow down",
    });
  });

  it("maps any other status to transport_error", () => {
    const result = errorToDispatchResult(
      new LifeOpsServiceError(500, "upstream boom"),
    );
    expect(result).toEqual({
      ok: false,
      reason: "transport_error",
      userActionable: false,
      message: "upstream boom",
    });
  });

  it("maps a generic Error to transport_error, preserving its message", () => {
    const result = errorToDispatchResult(new Error("socket hang up"));
    expect(result).toEqual({
      ok: false,
      reason: "transport_error",
      userActionable: false,
      message: "socket hang up",
    });
  });

  it("stringifies a non-Error throw into the transport_error message", () => {
    const result = errorToDispatchResult("kaboom");
    expect(result).toEqual({
      ok: false,
      reason: "transport_error",
      userActionable: false,
      message: "kaboom",
    });
  });

  // Regression for the crash found by the #11003 payload fuzzer: a connector
  // that rejects with a value whose primitive conversion throws would take down
  // the whole dispatch path (`TypeError: Cannot convert object to primitive
  // value`) instead of producing a failure result. The helper must always
  // return a `DispatchResult`, never rethrow.
  describe("adversarial: unstringifiable rejection values (crash-safety)", () => {
    it("survives a null-prototype object (no toString on the chain)", () => {
      const poisoned = Object.create(null) as unknown;
      let result: DispatchResult | undefined;
      expect(() => {
        result = errorToDispatchResult(poisoned);
      }).not.toThrow();
      expect(result).toEqual({
        ok: false,
        reason: "transport_error",
        userActionable: false,
        message: "[object Object]",
      });
    });

    it("survives an object whose toString throws", () => {
      const poisoned = {
        toString() {
          throw new Error("poisoned toString");
        },
      };
      let result: DispatchResult | undefined;
      expect(() => {
        result = errorToDispatchResult(poisoned);
      }).not.toThrow();
      expect(result).toEqual({
        ok: false,
        reason: "transport_error",
        userActionable: false,
        message: "[object Object]",
      });
    });

    it("survives an object whose Symbol.toPrimitive throws", () => {
      const poisoned = {
        [Symbol.toPrimitive]() {
          throw new Error("poisoned Symbol.toPrimitive");
        },
      };
      let result: DispatchResult | undefined;
      expect(() => {
        result = errorToDispatchResult(poisoned);
      }).not.toThrow();
      expect(result).toEqual({
        ok: false,
        reason: "transport_error",
        userActionable: false,
        message: "[object Object]",
      });
    });

    it("stringifies a Symbol without throwing", () => {
      const result = errorToDispatchResult(Symbol("boom"));
      expect(result).toEqual({
        ok: false,
        reason: "transport_error",
        userActionable: false,
        message: "Symbol(boom)",
      });
    });

    it("still prefers a real Error's message over any fallback", () => {
      const result = errorToDispatchResult(new Error("socket hang up"));
      expect(result.message).toBe("socket hang up");
    });
  });
});

describe("legacyStatusToConnectorStatus", () => {
  it("maps connected without degradations to ok", () => {
    const status = legacyStatusToConnectorStatus({ connected: true });
    expect(status.state).toBe("ok");
    expect(status.message).toBeUndefined();
    expect(Number.isNaN(Date.parse(status.observedAt))).toBe(false);
  });

  it("maps connected with degradations to degraded (first message wins)", () => {
    const status = legacyStatusToConnectorStatus({
      connected: true,
      degradations: [
        {
          axis: "media",
          code: "no_media",
          message: "media unavailable",
          retryable: true,
        },
        { axis: "reach", code: "slow", message: "slow reach", retryable: true },
      ],
    });
    expect(status.state).toBe("degraded");
    expect(status.message).toBe("media unavailable");
  });

  it("maps not-connected to disconnected, preferring authError over reason", () => {
    const status = legacyStatusToConnectorStatus({
      connected: false,
      authError: "token expired",
      reason: "some reason",
    });
    expect(status.state).toBe("disconnected");
    expect(status.message).toBe("token expired");
  });

  it("falls back to reason when there is no authError, else undefined", () => {
    expect(
      legacyStatusToConnectorStatus({ connected: false, reason: "offline" })
        .message,
    ).toBe("offline");
    expect(
      legacyStatusToConnectorStatus({ connected: false }).message,
    ).toBeUndefined();
  });

  it("treats a missing connected flag as disconnected", () => {
    expect(legacyStatusToConnectorStatus({}).state).toBe("disconnected");
  });
});

describe("rejectInvalidPayload", () => {
  it("returns a non-actionable transport_error failure", () => {
    expect(rejectInvalidPayload()).toEqual({
      ok: false,
      reason: "transport_error",
      userActionable: false,
      message:
        "ConnectorContribution.send requires { target: string; message: string } payload.",
    });
  });
});

describe("isConnectorSendPayload", () => {
  it("accepts a well-formed payload", () => {
    expect(
      isConnectorSendPayload({ target: "+15550000000", message: "hi" }),
    ).toBe(true);
  });

  it("accepts a well-formed payload with metadata", () => {
    expect(
      isConnectorSendPayload({
        target: "chat-123",
        message: "hi",
        metadata: { threadId: "t1" },
      }),
    ).toBe(true);
  });

  it("rejects non-object and structurally invalid payloads", () => {
    expect(isConnectorSendPayload(null)).toBe(false);
    expect(isConnectorSendPayload(undefined)).toBe(false);
    expect(isConnectorSendPayload("target")).toBe(false);
    expect(isConnectorSendPayload({ message: "hi" })).toBe(false);
    expect(isConnectorSendPayload({ target: "x" })).toBe(false);
    expect(isConnectorSendPayload({ target: 42, message: "hi" })).toBe(false);
    expect(isConnectorSendPayload({ target: "x", message: 42 })).toBe(false);
  });

  it("rejects an empty-string target (adversarial: unroutable recipient)", () => {
    expect(isConnectorSendPayload({ target: "", message: "hi" })).toBe(false);
  });

  it("rejects a whitespace-only target (adversarial: unroutable recipient)", () => {
    expect(isConnectorSendPayload({ target: "   ", message: "hi" })).toBe(
      false,
    );
    expect(isConnectorSendPayload({ target: "\t\n", message: "hi" })).toBe(
      false,
    );
  });
});
