import { ChannelType, type UUID, createMessageMemory } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { shouldUseSimpleChatBypass } from "../chat-routes.ts";

// Env vars consulted by shouldUseSimpleChatBypass. Reset between tests so a
// prior case doesn't leak (the function reads them via `process.env`).
const ENV_KEYS = [
  "ELIZA_FORCE_DIRECT_REPLY",
  "ELIZA_DEVICE_BRIDGE_ENABLED",
  "ELIZA_LOCAL_LLAMA",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const USER_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const AGENT_ID = "22222222-2222-2222-2222-222222222222" as UUID;
const ROOM_ID = "33333333-3333-3333-3333-333333333333" as UUID;

function makeMessage(
  content: Record<string, unknown> = {},
): ReturnType<typeof createMessageMemory> {
  return createMessageMemory({
    entityId: USER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: {
      text: "hi",
      source: "client_chat",
      channelType: ChannelType.DM,
      ...content,
    } as Parameters<typeof createMessageMemory>[0]["content"],
  });
}

describe("shouldUseSimpleChatBypass (Stage-1 RESPONSE_HANDLER bypass for small local models)", () => {
  it("returns false on stock cloud setup (no env signals, no client opt-in)", () => {
    expect(shouldUseSimpleChatBypass(makeMessage())).toBe(false);
  });

  it("returns true when ELIZA_FORCE_DIRECT_REPLY=1 (highest precedence, any transport)", () => {
    process.env.ELIZA_FORCE_DIRECT_REPLY = "1";
    // No device bridge, no local llama, no conversationMode — still routes
    // around Stage-1. This is the operator escape hatch from #7618.
    expect(shouldUseSimpleChatBypass(makeMessage())).toBe(true);
  });

  it("returns true when device bridge + ELIZA_LOCAL_LLAMA=1 (on-device llama.cpp)", () => {
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
    process.env.ELIZA_LOCAL_LLAMA = "1";
    expect(shouldUseSimpleChatBypass(makeMessage())).toBe(true);
  });

  it("returns false with ELIZA_LOCAL_LLAMA=1 but device bridge NOT enabled (CLI / cloud route)", () => {
    // Operator may set ELIZA_LOCAL_LLAMA=1 for the local-inference plugin but
    // route chat through a different surface (CLI to a remote provider, dev
    // server with cloud routing). Don't hijack that.
    process.env.ELIZA_LOCAL_LLAMA = "1";
    expect(shouldUseSimpleChatBypass(makeMessage())).toBe(false);
  });

  it("returns true on device bridge + client conversationMode='simple' (back-compat for voice / iOS smoke)", () => {
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
    expect(
      shouldUseSimpleChatBypass(makeMessage({ conversationMode: "simple" })),
    ).toBe(true);
  });

  it("returns false on device bridge with client conversationMode='power' (default useChatSend path)", () => {
    // packages/ui/src/state/useChatSend.ts:568 sets conversationMode from
    // chatMode for non-voice channels; chatMode defaults to "power" via
    // Header.tsx:159. The pre-#7618 gate fired ONLY on "simple", so power
    // turns went through Stage-1 even with a small local llama active.
    // The new gate falls through unless ELIZA_LOCAL_LLAMA flips it.
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
    expect(
      shouldUseSimpleChatBypass(makeMessage({ conversationMode: "power" })),
    ).toBe(false);
  });

  it("returns false on device bridge with no conversationMode and no llama signal", () => {
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
    expect(shouldUseSimpleChatBypass(makeMessage())).toBe(false);
  });

  it("ELIZA_FORCE_DIRECT_REPLY wins over conversationMode='power'", () => {
    process.env.ELIZA_FORCE_DIRECT_REPLY = "1";
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
    expect(
      shouldUseSimpleChatBypass(makeMessage({ conversationMode: "power" })),
    ).toBe(true);
  });

  it("only accepts the literal '1' for ELIZA_FORCE_DIRECT_REPLY (not 'true', not '0', not 'yes')", () => {
    // Match the conventions used by the existing ELIZA_DEVICE_BRIDGE_ENABLED /
    // ELIZA_LOCAL_LLAMA checks: strict "1" comparison, no truthy-string drift.
    for (const value of ["true", "yes", "0", "", "1 "]) {
      process.env.ELIZA_FORCE_DIRECT_REPLY = value;
      expect(shouldUseSimpleChatBypass(makeMessage())).toBe(false);
    }
    process.env.ELIZA_FORCE_DIRECT_REPLY = "1";
    expect(shouldUseSimpleChatBypass(makeMessage())).toBe(true);
  });

  it("only accepts the literal '1' for ELIZA_LOCAL_LLAMA", () => {
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
    for (const value of ["true", "yes", "0", ""]) {
      process.env.ELIZA_LOCAL_LLAMA = value;
      expect(shouldUseSimpleChatBypass(makeMessage())).toBe(false);
    }
    process.env.ELIZA_LOCAL_LLAMA = "1";
    expect(shouldUseSimpleChatBypass(makeMessage())).toBe(true);
  });
});
