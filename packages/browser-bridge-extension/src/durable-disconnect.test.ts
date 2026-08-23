/**
 * Unit coverage for the durable Disconnect transaction, including the failure
 * contract that retains the only usable credential when server revoke fails.
 */
import { describe, expect, it, vi } from "vitest";
import {
  disconnectFailureMessage,
  performDurableDisconnect,
} from "./durable-disconnect";

describe("performDurableDisconnect", () => {
  it("waits for cancellation and revocation before clearing local state", async () => {
    const events: string[] = [];
    await performDurableDisconnect({
      cancelSync: async () => {
        events.push("sync-cancelled");
      },
      cancelEnrollment: async () => {
        events.push("enrollment-cancelled");
      },
      revoke: async () => {
        events.push("server-revoked");
      },
      clearConfig: async () => {
        events.push("config-cleared");
      },
      suppressEnrollment: async () => {
        events.push("enrollment-suppressed");
      },
    });

    expect(events.slice(0, 3).sort()).toEqual([
      "enrollment-cancelled",
      "server-revoked",
      "sync-cancelled",
    ]);
    expect(events.slice(3)).toEqual([
      "enrollment-suppressed",
      "config-cleared",
    ]);
  });

  it("retains config and reports failure when server revocation fails", async () => {
    const clearConfig = vi.fn(async () => undefined);
    const suppressEnrollment = vi.fn(async () => undefined);

    const disconnect = performDurableDisconnect({
      cancelSync: async () => undefined,
      cancelEnrollment: async () => undefined,
      revoke: async () => {
        throw new Error("agent unavailable");
      },
      clearConfig,
      suppressEnrollment,
    });

    let observedError: unknown = null;
    try {
      await disconnect;
    } catch (error) {
      observedError = error;
    }
    expect(observedError).toBeInstanceOf(Error);
    expect(disconnectFailureMessage(observedError)).toBe(
      "Disconnect failed: agent unavailable",
    );
    expect(clearConfig).not.toHaveBeenCalled();
    expect(suppressEnrollment).not.toHaveBeenCalled();
  });

  it("retains config when durable enrollment suppression fails", async () => {
    const clearConfig = vi.fn(async () => undefined);

    await expect(
      performDurableDisconnect({
        cancelSync: async () => undefined,
        cancelEnrollment: async () => undefined,
        revoke: async () => undefined,
        clearConfig,
        suppressEnrollment: async () => {
          throw new Error("storage unavailable");
        },
      }),
    ).rejects.toThrow("storage unavailable");
    expect(clearConfig).not.toHaveBeenCalled();
  });
});
