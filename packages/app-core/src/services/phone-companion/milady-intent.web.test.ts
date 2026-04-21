import { describe, expect, it, vi } from "vitest";
import { MiladyIntentWeb } from "./milady-intent";

describe("MiladyIntentWeb", () => {
  it("getPairingStatus returns unpaired in web fallback", async () => {
    const plugin = new MiladyIntentWeb();
    const status = await plugin.getPairingStatus();
    expect(status).toEqual({
      paired: false,
      agentUrl: null,
      deviceId: null,
    });
  });

  it("receiveIntent rejects with explicit reason (no silent success)", async () => {
    const plugin = new MiladyIntentWeb();
    const result = await plugin.receiveIntent({
      kind: "alarm",
      payload: { timeIso: "2026-04-17T06:30:00Z" },
      issuedAtIso: "2026-04-17T00:00:00Z",
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("web-fallback");
  });

  it("scheduleAlarm throws unavailable on web — does not fake success", async () => {
    const plugin = new MiladyIntentWeb();
    await expect(
      plugin.scheduleAlarm({
        timeIso: "2026-04-17T06:30:00Z",
        title: "Flight",
        body: "6:30 alarm",
      }),
    ).rejects.toThrow(/iOS native runtime/);
  });

  it("logs when scheduleAlarm is attempted so dev sees the absence", async () => {
    const plugin = new MiladyIntentWeb();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      plugin.scheduleAlarm({
        timeIso: "2026-04-17T06:30:00Z",
        title: "t",
        body: "b",
      }),
    ).rejects.toBeDefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
