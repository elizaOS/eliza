import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { broadcastIntent } from "../src/lifeops/intent-sync.js";
import { publishDeviceIntentAction, __internal } from "../src/actions/device-bus.js";

vi.mock("../src/lifeops/intent-sync.js", () => ({
  broadcastIntent: vi.fn(async (_runtime, input) => ({
    id: "intent-local-1",
    agentId: "00000000-0000-0000-0000-000000000003",
    kind: input.kind,
    target: input.target ?? "all",
    title: input.title,
    body: input.body,
    actionUrl: input.actionUrl,
    priority: input.priority ?? "high",
    createdAt: "2026-04-18T00:00:00.000Z",
    metadata: input.metadata ?? {},
  })),
}));

const ORIGINAL_ENV = { ...process.env };

function makeMessage() {
  return {
    entityId: "00000000-0000-0000-0000-000000000003",
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
  vi.mocked(broadcastIntent).mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  broadcastIntent.mockClear();
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
  test("falls back to the local intent store when URL missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await publishDeviceIntentAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          kind: "alarm",
          payload: { title: "Stretch break", message: "Get up and stretch." },
        },
      },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(broadcastIntent).toHaveBeenCalledTimes(1);
    const r = result as { success: boolean; data?: Record<string, unknown> };
    expect(r.success).toBe(true);
    const data = r.data ?? {};
    expect(data.transport).toBe("local-fallback");
    expect(data.intentId).toBe("intent-local-1");
  });

  test("missing kind defaults to a local reminder when the bridge is absent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await publishDeviceIntentAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: {} },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(broadcastIntent).toHaveBeenCalledTimes(1);
    const r = result as { success: boolean; values?: Record<string, unknown> };
    expect(r.success).toBe(true);
    expect(r.values?.kind).toBe("reminder");
  });
});
