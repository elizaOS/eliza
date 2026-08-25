import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockWebPlugin {
    unavailable(message: string): Error {
      return new Error(message);
    }
  }
  return {
    registerPlugin: vi.fn(() => ({})),
    MockWebPlugin,
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
  };
});

vi.mock("@capacitor/core", () => ({
  registerPlugin: mocks.registerPlugin,
  WebPlugin: mocks.MockWebPlugin,
}));

vi.mock("./logger", () => ({ logger: mocks.logger }));

import { ElizaIntent, ElizaIntentWeb } from "./eliza-intent";

describe("ElizaIntentWeb (web fallback)", () => {
  it("registers the plugin with web and android factories", () => {
    expect(mocks.registerPlugin).toHaveBeenCalledWith(
      "ElizaIntent",
      expect.objectContaining({
        web: expect.any(Function),
        android: expect.any(Function),
      }),
    );
    const registration = mocks.registerPlugin.mock.calls[0][1];
    expect(registration.web()).toBeInstanceOf(ElizaIntentWeb);
  });

  it("rejects scheduleAlarm on the web fallback instead of faking success", async () => {
    const web = new ElizaIntentWeb();
    await expect(
      web.scheduleAlarm({
        timeIso: "2026-08-25T10:00:00Z",
        title: "x",
        body: "y",
      }),
    ).rejects.toThrow(/requires iOS native runtime/);
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it("reports receiveIntent as not accepted on the web fallback", async () => {
    const web = new ElizaIntentWeb();
    const result = await web.receiveIntent({
      kind: "reminder",
      payload: {},
      issuedAtIso: "2026-08-25T10:00:00Z",
    });
    expect(result).toEqual({
      accepted: false,
      reason: "web-fallback: no native intent bus available",
    });
  });

  it("reports the device as unpaired on the web fallback", async () => {
    const web = new ElizaIntentWeb();
    await expect(web.getPairingStatus()).resolves.toEqual({
      paired: false,
      agentUrl: null,
      deviceId: null,
    });
  });

  it("tolerates an invalid agent url in setPairingStatus logging", async () => {
    const web = new ElizaIntentWeb();
    await expect(
      web.setPairingStatus({ deviceId: "dev-1", agentUrl: "not a url" }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.logger.debug).toHaveBeenCalled();
  });

  it("exposes the registered plugin instance", () => {
    expect(ElizaIntent).toBeDefined();
  });
});
