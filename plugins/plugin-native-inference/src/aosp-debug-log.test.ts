import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAospLlamaDebugLog } from "./aosp-debug-log";

const { appendFileSync, mkdirSync } = vi.hoisted(() => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
const { join, dirname } = vi.hoisted(() => ({
  join: (...parts: string[]) => parts.join("/"),
  dirname: (p: string) => p.split("/").slice(0, -1).join("/") || ".",
}));

vi.mock("node:fs", () => ({
  default: { appendFileSync, mkdirSync },
  appendFileSync,
  mkdirSync,
}));
vi.mock("node:path", () => ({
  default: { join, dirname },
  join,
  dirname,
}));

describe("writeAospLlamaDebugLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes nothing when the debug env var is unset", () => {
    vi.stubEnv("ELIZA_AOSP_LLAMA_DEBUG_LOG", undefined);
    writeAospLlamaDebugLog("bundle-activate");
    expect(appendFileSync).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
  });

  it("writes nothing for 0/false values", () => {
    vi.stubEnv("ELIZA_AOSP_LLAMA_DEBUG_LOG", "0");
    writeAospLlamaDebugLog("bundle-activate");
    vi.stubEnv("ELIZA_AOSP_LLAMA_DEBUG_LOG", "false");
    writeAospLlamaDebugLog("bundle-activate");
    vi.stubEnv("ELIZA_AOSP_LLAMA_DEBUG_LOG", "  FALSE ");
    writeAospLlamaDebugLog("bundle-activate");
    expect(appendFileSync).not.toHaveBeenCalled();
  });

  it("targets the state dir for 1/true values", () => {
    vi.stubEnv("ELIZA_AOSP_LLAMA_DEBUG_LOG", "1");
    vi.stubEnv("ELIZA_STATE_DIR", "/data/state");
    writeAospLlamaDebugLog("bundle-activate");
    expect(mkdirSync).toHaveBeenCalledWith("/data/state", { recursive: true });
    expect(appendFileSync).toHaveBeenCalledWith(
      "/data/state/aosp-llama-debug.log",
      expect.stringContaining("bundle-activate"),
      "utf8",
    );
  });

  it("writes nothing when 1/true is set but no state dir is configured", () => {
    vi.stubEnv("ELIZA_AOSP_LLAMA_DEBUG_LOG", "true");
    vi.stubEnv("ELIZA_STATE_DIR", undefined);
    writeAospLlamaDebugLog("bundle-activate");
    expect(appendFileSync).not.toHaveBeenCalled();
  });

  it("treats any other non-falsy value as an explicit path", () => {
    vi.stubEnv("ELIZA_AOSP_LLAMA_DEBUG_LOG", "/tmp/custom/debug.log");
    writeAospLlamaDebugLog("bundle-activate");
    expect(appendFileSync).toHaveBeenCalledWith(
      "/tmp/custom/debug.log",
      expect.stringContaining("bundle-activate"),
      "utf8",
    );
  });

  it("serializes bigint details without throwing", () => {
    vi.stubEnv("ELIZA_AOSP_LLAMA_DEBUG_LOG", "/tmp/custom/debug.log");
    writeAospLlamaDebugLog("bundle-activate", { tokens: 12345n, ok: true });
    const [, line] = appendFileSync.mock.calls[0];
    expect(line).toContain('"tokens":"12345"');
    expect(line).toContain('"ok":true');
    expect(line).toMatch(/\n$/);
  });

  it("swallows filesystem errors so diagnostics never throw", () => {
    vi.stubEnv("ELIZA_AOSP_LLAMA_DEBUG_LOG", "/tmp/custom/debug.log");
    mkdirSync.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });
    expect(() => writeAospLlamaDebugLog("bundle-activate")).not.toThrow();
    appendFileSync.mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });
    expect(() => writeAospLlamaDebugLog("bundle-activate")).not.toThrow();
  });
});
