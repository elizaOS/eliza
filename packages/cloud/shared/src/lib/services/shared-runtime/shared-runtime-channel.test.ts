/**
 * Verifies channel metadata accepts canonical runtime values and rejects
 * malformed or unbounded coordinator payloads.
 */

import { describe, expect, test } from "bun:test";
import { ChannelType } from "@elizaos/core/edge";
import { parseSharedRuntimeChannel } from "./shared-runtime-channel";

describe("parseSharedRuntimeChannel", () => {
  test("accepts canonical voice and connector metadata", () => {
    expect(
      parseSharedRuntimeChannel({ type: ChannelType.VOICE_DM, source: "client_chat" }),
    ).toEqual({ type: ChannelType.VOICE_DM, source: "client_chat" });
    expect(parseSharedRuntimeChannel({ type: ChannelType.DM, source: "telegram" })).toEqual({
      type: ChannelType.DM,
      source: "telegram",
    });
  });

  test.each([
    [null],
    [{}],
    [{ type: "NOT_A_CHANNEL", source: "client_chat" }],
    [{ type: ChannelType.DM, source: "" }],
    [{ type: ChannelType.DM, source: "bad source" }],
    [{ type: ChannelType.DM, source: "x".repeat(65) }],
  ])("rejects malformed channel metadata %#", (value) => {
    expect(parseSharedRuntimeChannel(value)).toBeNull();
  });
});
