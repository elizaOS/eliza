/**
 * Tests for the destructive-reset guard (#8801 / #9943) and the config secret
 * redaction walk. isSafeResetStateDir decides whether a path may be wiped by
 * the "reset state" operation. A bug here could erase the filesystem root,
 * $HOME, or an unrelated directory — so the guard (under-home AND contains an
 * "eliza" segment, never root/home itself) is pinned.
 *
 * The redaction walk is load-bearing for GET /api/config and /api/connectors:
 * origin develop RangeError'd cyclic graphs and invoked enumerable getters.
 * Depth/node/cycle fail-closed replaces that with typed CONFIG_SECRET_FILTER_UNBOUNDED.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  CONFIG_SECRET_FILTER_UNBOUNDED,
  isSafeResetStateDir,
  MAX_CONFIG_SECRET_FILTER_DEPTH,
  redactConfigSecrets,
  stripRedactedPlaceholderValuesDeep,
} from "./server-helpers-config";

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

describe("redactConfigSecrets fail-closed walk", () => {
  it("redacts nested secret-shaped config values", () => {
    const redacted = redactConfigSecrets({
      cloud: { apiKey: "eliza_secret" },
      messages: {
        tts: {
          provider: "elevenlabs",
          elevenlabs: { apiKey: "voice_secret", voiceId: "voice" },
        },
      },
      env: { OPENAI_API_KEY: "sk-secret", SAFE_FLAG: "1" },
    });

    expect(redacted.cloud).toEqual({ apiKey: "[REDACTED]" });
    expect(redacted.messages).toEqual({
      tts: {
        provider: "elevenlabs",
        elevenlabs: { apiKey: "[REDACTED]", voiceId: "voice" },
      },
    });
    expect(redacted.env).toEqual({
      OPENAI_API_KEY: "[REDACTED]",
      SAFE_FLAG: "1",
    });
  });

  it("fail-closed on a cyclic config graph instead of RangeError", () => {
    const cyclic: Record<string, unknown> = {
      env: { SAFE_FLAG: "1" },
      cloud: { apiKey: "eliza_secret" },
    };
    cyclic.self = cyclic;

    try {
      redactConfigSecrets(cyclic);
      throw new Error("expected CONFIG_SECRET_FILTER_UNBOUNDED");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(CONFIG_SECRET_FILTER_UNBOUNDED);
      expect(error).not.toBeInstanceOf(RangeError);
    }
  });

  it("fail-closed on over-deep config nests before the walk RangeErrors", () => {
    let nest: Record<string, unknown> = { leaf: "ok" };
    for (let i = 0; i < MAX_CONFIG_SECRET_FILTER_DEPTH + 8; i += 1) {
      nest = { nest };
    }

    try {
      redactConfigSecrets(nest);
      throw new Error("expected CONFIG_SECRET_FILTER_UNBOUNDED");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(CONFIG_SECRET_FILTER_UNBOUNDED);
    }
  });

  it("does not invoke enumerable getters while redacting", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "apiKey", {
      enumerable: true,
      get() {
        throw new Error("GETTER_INVOKED");
      },
    });

    try {
      redactConfigSecrets({ cloud: hostile });
      throw new Error("expected CONFIG_SECRET_FILTER_UNBOUNDED");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(CONFIG_SECRET_FILTER_UNBOUNDED);
      expect(String(error)).not.toContain("GETTER_INVOKED");
    }
  });

  it("fail-closed on cyclic placeholder strip instead of RangeError", () => {
    const cyclic: Record<string, unknown> = { a: "[REDACTED]" };
    cyclic.self = cyclic;

    try {
      stripRedactedPlaceholderValuesDeep(cyclic);
      throw new Error("expected CONFIG_SECRET_FILTER_UNBOUNDED");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(CONFIG_SECRET_FILTER_UNBOUNDED);
      expect(error).not.toBeInstanceOf(RangeError);
    }
  });

  it("still strips honest [REDACTED] placeholders in place", () => {
    const patch = {
      env: { OPENAI_API_KEY: "[REDACTED]", SAFE_FLAG: "1" },
      cloud: { apiKey: "[REDACTED]", region: "us" },
    };
    stripRedactedPlaceholderValuesDeep(patch);
    expect(patch).toEqual({
      env: { SAFE_FLAG: "1" },
      cloud: { region: "us" },
    });
  });
});
