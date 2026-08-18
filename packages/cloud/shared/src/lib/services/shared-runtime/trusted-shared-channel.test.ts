/** Validates the narrow server-owned channel envelope accepted across the DO boundary. */

import { describe, expect, test } from "bun:test";
import { ChannelType } from "@elizaos/core/edge";
import { parseTrustedSharedChannelEnvelope } from "./trusted-shared-channel";

describe("trusted Shared channel envelope", () => {
  test("accepts messaging and voice room semantics", () => {
    expect(
      parseTrustedSharedChannelEnvelope({ source: "discord", channelType: ChannelType.GROUP }),
    ).toEqual({ source: "discord", channelType: ChannelType.GROUP });
    expect(
      parseTrustedSharedChannelEnvelope({ source: "voice", channelType: ChannelType.VOICE_DM }),
    ).toEqual({ source: "voice", channelType: ChannelType.VOICE_DM });
  });

  test("rejects unsupported, empty, and structurally forged envelopes", () => {
    expect(parseTrustedSharedChannelEnvelope({ source: "discord", channelType: "API" })).toBe(
      undefined,
    );
    expect(parseTrustedSharedChannelEnvelope({ source: " ", channelType: ChannelType.DM })).toBe(
      undefined,
    );
    expect(
      parseTrustedSharedChannelEnvelope({ source: { value: "voice" }, channelType: "DM" }),
    ).toBe(undefined);
  });
});
