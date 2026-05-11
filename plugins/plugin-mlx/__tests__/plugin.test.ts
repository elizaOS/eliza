/**
 * Plugin-level surface tests: verify `mlxPlugin` exposes the expected
 * descriptor without standing up the full AI SDK plumbing. We mock the
 * detection helper so platform gating + reachability are deterministic.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/detect", () => ({
  detectMlx: vi.fn(async () => ({
    available: true,
    baseURL: "http://localhost:8080/v1",
    models: [{ id: "mlx-community/Qwen2.5-7B-Instruct-4bit" }],
  })),
}));

import { mlxPlugin } from "../plugin";

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

afterEach(() => {
  restoreHost();
});

describe("mlxPlugin", () => {
  it("identifies as 'mlx' with the OpenAI-compatible description", () => {
    expect(mlxPlugin.name).toBe("mlx");
    expect(mlxPlugin.description).toMatch(/MLX/i);
    expect(mlxPlugin.description).toMatch(/OpenAI-compatible/i);
  });

  it("declares MLX_BASE_URL as the env signal for auto-enable", () => {
    expect(mlxPlugin.autoEnable?.envKeys).toEqual(["MLX_BASE_URL"]);
  });

  it("registers ModelType handlers for text and embedding tiers", () => {
    const keys = Object.keys(mlxPlugin.models ?? {});
    expect(keys).toContain("TEXT_EMBEDDING");
    expect(keys).toContain("TEXT_SMALL");
    expect(keys).toContain("TEXT_LARGE");
    expect(keys).toContain("RESPONSE_HANDLER");
    expect(keys).toContain("ACTION_PLANNER");
  });

  it("shouldEnable predicate returns true on darwin-arm64 when server reachable", async () => {
    setHost("darwin", "arm64");
    const predicate = mlxPlugin.autoEnable?.shouldEnable;
    expect(typeof predicate).toBe("function");
    const result = await predicate?.({}, {});
    expect(result).toBe(true);
  });

  it("shouldEnable predicate returns false on darwin-x64 even when server reachable", async () => {
    setHost("darwin", "x64");
    const predicate = mlxPlugin.autoEnable?.shouldEnable;
    const result = await predicate?.({}, {});
    expect(result).toBe(false);
  });

  it("shouldEnable predicate returns false on linux-arm64", async () => {
    setHost("linux", "arm64");
    const predicate = mlxPlugin.autoEnable?.shouldEnable;
    const result = await predicate?.({}, {});
    expect(result).toBe(false);
  });

  it("plugin.init() does not throw on a darwin-arm64 host (reachable mock)", async () => {
    setHost("darwin", "arm64");
    const runtime = {
      character: { system: "" },
      emitEvent: vi.fn(),
      getSetting: () => null,
      fetch,
    } as unknown as IAgentRuntime;

    await mlxPlugin.init?.({}, runtime);
  });

  it("plugin.init() does not throw on a non-Apple-Silicon host (logs a warning)", async () => {
    setHost("linux", "x64");
    const runtime = {
      character: { system: "" },
      emitEvent: vi.fn(),
      getSetting: () => null,
      fetch,
    } as unknown as IAgentRuntime;

    await mlxPlugin.init?.({}, runtime);
  });
});
