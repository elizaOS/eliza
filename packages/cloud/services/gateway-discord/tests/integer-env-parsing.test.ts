/**
 * Exercises the gateway-discord integer environment parsers against the real
 * modules. Both helpers already raise on input they recognize as invalid; these
 * cover the input they previously failed to recognize.
 */
import { afterEach, describe, expect, test } from "bun:test";

const VOICE_KEYS = ["VOICE_AUDIO_TTL_SECONDS", "VOICE_CLEANUP_INTERVAL_MS"];
const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

function stub(key: string, value: string): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  process.env[key] = value;
}

describe("gateway-discord integer env parsing", () => {
  test("a trailing-garbage TTL is rejected rather than prefix-parsed", async () => {
    // parseInt("3600junk") is 3600, so the NaN guard never fired and the module
    // loaded with a TTL nobody configured.
    for (const key of VOICE_KEYS) stub(key, "3600junk");

    await expect(
      import(`../src/voice-message-handler?case=garbage-${Date.now()}`),
    ).rejects.toThrow("is not a valid integer");
  });

  test("a clean TTL still loads", async () => {
    for (const key of VOICE_KEYS) stub(key, "3600");

    const mod = await import(
      `../src/voice-message-handler?case=clean-${Date.now()}`
    );
    expect(mod).toBeDefined();
  });
});
