/**
 * Tests configuration helpers whose first-run defaults and destructive-reset
 * boundary must remain safe without a live agent process.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config";
import {
  applyFirstRunVoicePreset,
  isSafeResetStateDir,
} from "./server-helpers-config";

const originalElevenLabsApiKey = process.env.ELEVENLABS_API_KEY;

afterEach(() => {
  if (originalElevenLabsApiKey === undefined) {
    delete process.env.ELEVENLABS_API_KEY;
  } else {
    process.env.ELEVENLABS_API_KEY = originalElevenLabsApiKey;
  }
});

describe("applyFirstRunVoicePreset", () => {
  it("stores persona voice metadata without pinning new installs to ElevenLabs", () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const config = { messages: { tts: {} } } as ElizaConfig;

    applyFirstRunVoicePreset(config, {}, "en");

    expect(config.messages?.tts?.provider).toBeUndefined();
    expect(config.messages?.tts?.elevenlabs?.voiceId).toBeTruthy();
    expect(config.messages?.tts?.elevenlabs?.modelId).toBe("eleven_flash_v2_5");
  });

  it("preserves an explicit provider while adding first-run voice metadata", () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const config = {
      messages: { tts: { provider: "eliza-cloud" } },
    } as ElizaConfig;

    applyFirstRunVoicePreset(config, {}, "en");

    expect(config.messages?.tts?.provider).toBe("eliza-cloud");
  });
});

describe("isSafeResetStateDir", () => {
  const home = "/home/user";

  it("allows a state dir under home that carries an 'eliza' segment", () => {
    expect(isSafeResetStateDir("/home/user/.local/state/eliza", home)).toBe(
      true,
    );
    expect(isSafeResetStateDir("/home/user/eliza", home)).toBe(true);
  });

  it("refuses the filesystem root", () => {
    expect(isSafeResetStateDir("/", home)).toBe(false);
  });

  it("refuses the home directory itself", () => {
    expect(isSafeResetStateDir(home, home)).toBe(false);
  });

  it("refuses any directory outside home (even with an eliza segment)", () => {
    expect(isSafeResetStateDir("/tmp/eliza", home)).toBe(false);
    expect(isSafeResetStateDir("/var/lib/eliza", home)).toBe(false);
  });

  it("refuses a traversal that escapes home", () => {
    expect(isSafeResetStateDir("/home/user/../etc/eliza", home)).toBe(false);
  });

  it("refuses a dir under home that lacks the allowed segment", () => {
    expect(isSafeResetStateDir("/home/user/Documents", home)).toBe(false);
    expect(
      isSafeResetStateDir("/home/user/.local/state/custom-app", home),
    ).toBe(false);
  });
});
