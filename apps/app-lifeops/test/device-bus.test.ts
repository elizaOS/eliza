import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { publishDeviceIntentAction, __internal } from "../src/actions/device-bus.js";

const ORIGINAL_ENV = { ...process.env };

function makeMessage() {
  return {
    entityId: "00000000-0000-0000-0000-000000000001",
    roomId: "00000000-0000-0000-0000-000000000002",
    content: { text: "publish", ownerAccess: true },
  } as unknown as Parameters<
    NonNullable<typeof publishDeviceIntentAction.handler>
  >[1];
}

function makeRuntime(settings: Record<string, string> = {}) {
  return {
    agentId: "00000000-0000-0000-0000-000000000003",
    getSetting: (key: string) => settings[key],
  } as unknown as Parameters<
    NonNullable<typeof publishDeviceIntentAction.handler>
  >[0];
}

beforeEach(() => {
  delete process.env.MILADY_DEVICE_BUS_URL;
  delete process.env.MILADY_DEVICE_BUS_TOKEN;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("normalizeKind", () => {
  test("lowercases and trims known kinds", () => {
    expect(__internal.normalizeKind(" Alarm ")).toBe("alarm");
    expect(__internal.normalizeKind("REMINDER")).toBe("reminder");
  });
  test("accepts custom kinds", () => {
    expect(__internal.normalizeKind("custom_thing")).toBe("custom_thing");
  });
  test("rejects blank/missing", () => {
    expect(__internal.normalizeKind(undefined)).toBeNull();
    expect(__internal.normalizeKind("")).toBeNull();
    expect(__internal.normalizeKind("   ")).toBeNull();
  });
});

describe("PUBLISH_DEVICE_INTENT graceful degradation", () => {
  test("returns device-bus-not-configured when URL missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await publishDeviceIntentAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { kind: "alarm", payload: { time: "07:00" } } },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    const r = result as { success: boolean; data?: Record<string, unknown> };
    expect(r.success).toBe(false);
    const data = r.data ?? {};
    expect(
      data.reason === "device-bus-not-configured" ||
        data.error === "PERMISSION_DENIED",
    ).toBe(true);
  });

  test("missing kind fails cleanly", async () => {
    process.env.MILADY_DEVICE_BUS_URL = "https://example.test";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await publishDeviceIntentAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: {} },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    const r = result as { success: boolean };
    expect(r.success).toBe(false);
  });
});
