/**
 * Auto-enable predicate tests.
 *
 * The auto-enable contract is "Apple Silicon AND env signal" — verify both
 * gates independently. We mock `process.platform` / `process.arch` via
 * `Object.defineProperty` because the plugin reads them directly.
 */

import type { PluginAutoEnableContext } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";

import { shouldEnable } from "../auto-enable";

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_ARCH = process.arch;

function setHost(platform: string, arch: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
}

function restoreHost(): void {
  Object.defineProperty(process, "platform", {
    value: ORIGINAL_PLATFORM,
    configurable: true,
  });
  Object.defineProperty(process, "arch", { value: ORIGINAL_ARCH, configurable: true });
}

function makeCtx(env: Record<string, string | undefined>): PluginAutoEnableContext {
  return { env } as unknown as PluginAutoEnableContext;
}

afterEach(() => {
  restoreHost();
});

describe("plugin-mlx auto-enable", () => {
  it("returns true on darwin-arm64 with MLX_BASE_URL set", () => {
    setHost("darwin", "arm64");
    expect(shouldEnable(makeCtx({ MLX_BASE_URL: "http://localhost:8080" }))).toBe(true);
  });

  it("returns false on darwin-arm64 without MLX_BASE_URL", () => {
    setHost("darwin", "arm64");
    expect(shouldEnable(makeCtx({}))).toBe(false);
  });

  it("treats empty MLX_BASE_URL as unset", () => {
    setHost("darwin", "arm64");
    expect(shouldEnable(makeCtx({ MLX_BASE_URL: "   " }))).toBe(false);
  });

  it("returns false on darwin-x64 even with MLX_BASE_URL", () => {
    setHost("darwin", "x64");
    expect(shouldEnable(makeCtx({ MLX_BASE_URL: "http://localhost:8080" }))).toBe(false);
  });

  it("returns false on linux-arm64 (no MLX framework)", () => {
    setHost("linux", "arm64");
    expect(shouldEnable(makeCtx({ MLX_BASE_URL: "http://localhost:8080" }))).toBe(false);
  });

  it("returns false on win32-x64", () => {
    setHost("win32", "x64");
    expect(shouldEnable(makeCtx({ MLX_BASE_URL: "http://localhost:8080" }))).toBe(false);
  });
});
