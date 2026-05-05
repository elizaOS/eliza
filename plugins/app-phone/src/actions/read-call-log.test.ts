import type { HandlerOptions, IAgentRuntime, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const phoneMock = vi.hoisted(() => ({
  listRecentCalls: vi.fn(),
}));

vi.mock("@elizaos/capacitor-phone", () => ({
  Phone: phoneMock,
}));

import { readCallLogAction } from "./read-call-log";

describe("READ_CALL_LOG", () => {
  beforeEach(() => {
    phoneMock.listRecentCalls.mockReset();
  });

  it("caps call-log reads at the Android plugin maximum", async () => {
    const calls = [
      {
        id: "call-1",
        number: "+15551234567",
        cachedName: "Ada",
        date: 1_700_000_000_000,
        durationSeconds: 12,
        type: "incoming",
        rawType: 1,
        isNew: false,
        phoneAccountId: null,
        geocodedLocation: null,
        transcription: null,
        voicemailUri: null,
        agentTranscript: null,
        agentSummary: null,
        agentTranscriptUpdatedAt: null,
      },
    ];
    phoneMock.listRecentCalls.mockResolvedValue({ calls });

    const result = await readCallLogAction.handler(
      {} as IAgentRuntime,
      {} as Memory,
      undefined,
      { parameters: { limit: 500 } } satisfies HandlerOptions,
    );

    expect(phoneMock.listRecentCalls).toHaveBeenCalledWith({ limit: 50 });
    expect(result).toMatchObject({
      success: true,
      data: { calls, limit: 50 },
    });
  });
});
