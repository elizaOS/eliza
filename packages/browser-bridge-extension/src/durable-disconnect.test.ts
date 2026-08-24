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

    expect(events.slice(0, 2).sort()).toEqual([
      "enrollment-cancelled",
      "sync-cancelled",
    ]);
    expect(events.slice(2)).toEqual([
      "server-revoked",
      "enrollment-suppressed",
      "config-cleared",
    ]);
  });

  it("does not resolve revocation until asynchronous enrollment cancellation quiesces", async () => {
    let releaseEnrollment: (() => void) | null = null;
    const enrollmentSettled = new Promise<void>((resolve) => {
      releaseEnrollment = resolve;
    });
    const revoke = vi.fn(async () => undefined);
    const disconnect = performDurableDisconnect({
      cancelSync: async () => undefined,
      cancelEnrollment: async () => await enrollmentSettled,
      revoke,
      clearConfig: async () => undefined,
      suppressEnrollment: async () => undefined,
    });

    await Promise.resolve();
    expect(revoke).not.toHaveBeenCalled();
    releaseEnrollment?.();
    await disconnect;
    expect(revoke).toHaveBeenCalledTimes(1);
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
