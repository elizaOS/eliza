import type { HandlerOptions, IAgentRuntime, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const phoneMock = vi.hoisted(() => ({
  placeCall: vi.fn(),
}));

vi.mock("@elizaos/capacitor-phone", () => ({
  Phone: phoneMock,
}));

import { placeCallAction } from "./place-call";

describe("PLACE_CALL", () => {
  beforeEach(() => {
    phoneMock.placeCall.mockReset();
  });

  it("normalizes the requested number before placing a call", async () => {
    phoneMock.placeCall.mockResolvedValue(undefined);

    const result = await placeCallAction.handler(
      {} as IAgentRuntime,
      {} as Memory,
      undefined,
      {
        parameters: { phoneNumber: "+1 (555) 123-4567" },
      } satisfies HandlerOptions,
    );

    expect(phoneMock.placeCall).toHaveBeenCalledWith({
      number: "+15551234567",
    });
    expect(result).toMatchObject({
      success: true,
      data: { phoneNumber: "+15551234567" },
    });
  });

  it("fails without calling native code when phoneNumber is missing", async () => {
    const result = await placeCallAction.handler(
      {} as IAgentRuntime,
      {} as Memory,
      undefined,
      { parameters: {} } satisfies HandlerOptions,
    );

    expect(phoneMock.placeCall).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      text: "phoneNumber is required",
    });
  });
});
