/**
 * Tests the phoneCallLog provider over a mocked `@elizaos/capacitor-phone`
 * bridge: asserts the projected `{ count, items }` result and the empty-log
 * case, without touching the native call log.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const phoneBridge = vi.hoisted(() => ({
  listRecentCalls: vi.fn(),
}));

vi.mock("@elizaos/capacitor-phone", () => ({
  Phone: phoneBridge,
}));

import { phoneCallLogProvider } from "./call-log";

afterEach(() => {
  vi.clearAllMocks();
});

describe("phoneCallLogProvider", () => {
  it("returns structured recent calls without leaking native-only fields", async () => {
    phoneBridge.listRecentCalls.mockResolvedValue({
      calls: [
        {
          id: "call-1",
          number: "+15550100",
          cachedName: "Ada",
          date: 1_700_000_000_000,
          durationSeconds: 12,
          type: "incoming",
          rawType: 1,
          isNew: false,
          voicemailUri: "content://voicemail/1",
        },
      ],
    });

    const result = await phoneCallLogProvider.get(
      {} as never,
      {} as never,
      {} as never,
    );

    expect(phoneBridge.listRecentCalls).toHaveBeenCalledWith({ limit: 50 });
    expect(result.values).toEqual({
      callLogAvailable: true,
      callLogCount: 1,
    });
    expect(result.data).toMatchObject({
      count: 1,
      limit: 50,
      calls: [
        {
          id: "call-1",
          number: "+15550100",
          cachedName: "Ada",
          date: 1_700_000_000_000,
          durationSeconds: 12,
          type: "incoming",
          isNew: false,
        },
      ],
    });
    expect(result.text).toContain('"phone_call_log"');
    expect(result.text).not.toContain("voicemailUri");
  });

  it("turns native call-log permission failures into unavailable provider state", async () => {
    phoneBridge.listRecentCalls.mockRejectedValue(
      new Error("READ_CALL_LOG denied"),
    );

    const result = await phoneCallLogProvider.get(
      {} as never,
      {} as never,
      {} as never,
    );

    expect(result).toEqual({
      text: "",
      values: {
        callLogAvailable: false,
        callLogCount: 0,
        callLogError: "READ_CALL_LOG denied",
      },
      data: {
        calls: [],
        count: 0,
        limit: 50,
        error: "READ_CALL_LOG denied",
      },
    });
  });
});
