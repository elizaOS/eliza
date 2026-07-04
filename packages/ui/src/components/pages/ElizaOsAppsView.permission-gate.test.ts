/**
 * Verifies the native-app read permission gate blocks denied Contacts and
 * Messages bridge reads before Capacitor emits raw plugin errors.
 */
import { describe, expect, it, vi } from "vitest";
import { ensureNativeReadGranted } from "./ElizaOsAppsView";

// #10196: the contacts/messages reads in ElizaOsAppsView gate on this helper so
// a known permission-denied state never reaches the native plugin (which would
// reject → Capacitor logs a raw console.error). These cover the decision table.
describe("ensureNativeReadGranted", () => {
  it("proceeds when there is no permission model (web / null check)", async () => {
    expect(await ensureNativeReadGranted(null, null)).toBe(true);
  });

  it("proceeds when the existing permission is already granted (no request)", async () => {
    const request = vi.fn(async () => "granted");
    expect(await ensureNativeReadGranted(async () => "granted", request)).toBe(
      true,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("requests once when not-yet-granted and proceeds if the user grants", async () => {
    const request = vi.fn(async () => "granted");
    expect(await ensureNativeReadGranted(async () => "prompt", request)).toBe(
      true,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("blocks the read when permission stays denied after a request", async () => {
    expect(
      await ensureNativeReadGranted(
        async () => "denied",
        async () => "denied",
      ),
    ).toBe(false);
  });

  it("blocks the read when not granted and there is no request capability", async () => {
    expect(await ensureNativeReadGranted(async () => "denied", null)).toBe(
      false,
    );
  });

  it("treats a throwing check as not-granted and falls through to request", async () => {
    const request = vi.fn(async () => "granted");
    expect(
      await ensureNativeReadGranted(async () => {
        throw new Error("bridge unavailable");
      }, request),
    ).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("blocks the read when both check and request throw", async () => {
    expect(
      await ensureNativeReadGranted(
        async () => {
          throw new Error("check failed");
        },
        async () => {
          throw new Error("request failed");
        },
      ),
    ).toBe(false);
  });
});
