import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";

import {
  DFLASH_BINARY_PATH,
  expandHome,
  probeDflashFork,
  resolveLocalBaseUrl,
  startLocalServer,
} from "../local-llama-cpp.ts";

describe("expandHome", () => {
  it("expands leading ~/ to the home dir", () => {
    const expanded = expandHome("~/foo/bar");
    expect(expanded).not.toContain("~");
    expect(expanded.endsWith("/foo/bar")).toBe(true);
  });

  it("returns absolute paths verbatim", () => {
    expect(expandHome("/abs/path")).toBe("/abs/path");
  });

  it("handles bare ~", () => {
    const expanded = expandHome("~");
    expect(expanded).not.toBe("~");
  });
});

describe("probeDflashFork", () => {
  it("returns null when the binary is absent, otherwise the absolute path", () => {
    const result = probeDflashFork();
    if (result === null) {
      // Binary not present in this environment — confirm the default path
      // was the one checked.
      expect(existsSync(DFLASH_BINARY_PATH)).toBe(false);
    } else {
      expect(result).toBe(DFLASH_BINARY_PATH);
      expect(existsSync(result)).toBe(true);
    }
  });
});

describe("resolveLocalBaseUrl", () => {
  it("uses PARALLAX_OPENCODE_BASE_URL when set", () => {
    const result = resolveLocalBaseUrl({
      env: { PARALLAX_OPENCODE_BASE_URL: "http://example:5555/v1" },
    });
    expect(result.baseUrl).toBe("http://example:5555/v1");
    expect(result.source).toBe("ollama-env");
  });

  it("falls back to localhost:11434 when no override is set", () => {
    const result = resolveLocalBaseUrl({ env: {} });
    expect(result.baseUrl).toBe("http://localhost:11434/v1");
    expect(result.source).toBe("ollama-default");
  });

  it("ignores empty/whitespace override values", () => {
    const result = resolveLocalBaseUrl({
      env: { PARALLAX_OPENCODE_BASE_URL: "   " },
    });
    expect(result.source).toBe("ollama-default");
  });
});

describe("startLocalServer", () => {
  it("throws a helpful error when the dflash fork is not present", async () => {
    if (probeDflashFork() !== null) {
      // Binary IS present — skip this branch; the next test covers it.
      return;
    }
    await expect(
      startLocalServer({ bundlePath: "/nonexistent" }),
    ).rejects.toThrow(/dflash llama-server binary not found/);
  });

  it("throws when the bundle path does not exist (binary present)", async () => {
    if (probeDflashFork() === null) {
      // No binary — covered above.
      return;
    }
    await expect(
      startLocalServer({ bundlePath: "/nonexistent-bundle-xyz.gguf" }),
    ).rejects.toThrow(/dflash bundle path does not exist/);
  });
});
