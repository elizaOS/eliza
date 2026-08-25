import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    resolveAliasedEnvValue: (key: string) => process.env[key] ?? null,
  };
});

vi.mock("@elizaos/core", () => ({
  logger: h.logger,
  resolveAliasedEnvValue: h.resolveAliasedEnvValue,
}));

vi.mock("node:fs", () => ({
  promises: { access: vi.fn() },
}));

const accessMock = vi.mocked(fs.access);
const warnMock = vi.spyOn(h.logger, "warn").mockImplementation(() => {});

/** Re-import the module fresh so the memoized bindingsPromise is reset. */
async function loadModule() {
  vi.resetModules();
  return await import("./yolo-ffi");
}

const ORIG_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  if (ORIG_PLATFORM) {
    Object.defineProperty(process, "platform", ORIG_PLATFORM);
  }
});

describe("defaultYoloWeightsPath", () => {
  it("prefers the ELIZA_YOLO_GGUF override verbatim", async () => {
    vi.stubEnv("ELIZA_YOLO_GGUF", "/custom/weights/yolov8n.gguf");
    const { defaultYoloWeightsPath } = await loadModule();
    expect(defaultYoloWeightsPath()).toBe("/custom/weights/yolov8n.gguf");
  });

  it("resolves under the aliased ELIZA_STATE_DIR", async () => {
    vi.stubEnv("ELIZA_STATE_DIR", "/data/eliza");
    delete process.env.ELIZA_YOLO_GGUF;
    const { defaultYoloWeightsPath } = await loadModule();
    expect(defaultYoloWeightsPath()).toBe(
      "/data/eliza/models/vision/yolov8n.gguf",
    );
  });

  it("falls back to ~/.eliza when no state dir or override is set", async () => {
    delete process.env.ELIZA_STATE_DIR;
    delete process.env.ELIZA_YOLO_GGUF;
    const { defaultYoloWeightsPath } = await loadModule();
    expect(defaultYoloWeightsPath()).toMatch(
      /(^|\/)\.eliza\/models\/vision\/yolov8n\.gguf$/,
    );
  });
});

describe("isYoloReady", () => {
  it("fails closed with a diagnostic reason when the GGUF is missing", async () => {
    vi.stubEnv("ELIZA_YOLO_GGUF", "/missing/model.gguf");
    accessMock.mockRejectedValue(new Error("ENOENT"));
    const { isYoloReady } = await loadModule();
    await expect(isYoloReady()).resolves.toEqual({
      ready: false,
      reason: "YOLO GGUF missing: /missing/model.gguf",
    });
    expect(accessMock).toHaveBeenCalledWith("/missing/model.gguf");
  });

  it("respects an explicit weightsPath option", async () => {
    accessMock.mockRejectedValue(new Error("ENOENT"));
    const { isYoloReady } = await loadModule();
    await expect(
      isYoloReady({ weightsPath: "/opt/weights/yolo.gguf" }),
    ).resolves.toEqual({
      ready: false,
      reason: "YOLO GGUF missing: /opt/weights/yolo.gguf",
    });
  });

  it("fails closed when the native library cannot load, reporting the expected .so path on linux", async () => {
    vi.stubEnv("ELIZA_YOLO_GGUF", "/w/yolov8n.gguf");
    Object.defineProperty(process, "platform", { value: "linux" });
    // weights exist, library access fails
    accessMock.mockImplementation((p: string) => {
      if (p === "/w/yolov8n.gguf") return Promise.resolve();
      return Promise.reject(new Error("ENOENT"));
    });
    const { isYoloReady } = await loadModule();
    const result = await isYoloReady();
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/native library failed to load/);
    expect(result.reason).toContain("libyolo.so");
  });

  it("reports a .dll path on win32 and .dylib on darwin", async () => {
    vi.stubEnv("ELIZA_YOLO_GGUF", "/w/yolov8n.gguf");
    accessMock.mockImplementation((p: string) => {
      if (p === "/w/yolov8n.gguf") return Promise.resolve();
      return Promise.reject(new Error("ENOENT"));
    });
    for (const [platform, ext] of [
      ["win32", "libyolo.dll"],
      ["darwin", "libyolo.dylib"],
    ] as const) {
      Object.defineProperty(process, "platform", { value: platform });
      const { isYoloReady } = await loadModule();
      const result = await isYoloReady();
      expect(result.ready).toBe(false);
      expect(result.reason).toContain(ext);
    }
  });

  it("honors ELIZA_YOLO_LIB when reporting the expected library path", async () => {
    vi.stubEnv("ELIZA_YOLO_GGUF", "/w/yolov8n.gguf");
    vi.stubEnv("ELIZA_YOLO_LIB", "/opt/yolo/libyolo-custom.so");
    accessMock.mockImplementation((p: string) => {
      if (p === "/w/yolov8n.gguf") return Promise.resolve();
      return Promise.reject(new Error("ENOENT"));
    });
    const { isYoloReady } = await loadModule();
    const result = await isYoloReady();
    expect(result.reason).toContain("/opt/yolo/libyolo-custom.so");
  });
});

describe("loadYoloBindings", () => {
  it("returns null and warns when the native library is missing", async () => {
    accessMock.mockRejectedValue(new Error("ENOENT"));
    const { loadYoloBindings } = await loadModule();
    await expect(loadYoloBindings()).resolves.toBeNull();
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining("native library not found"),
    );
  });

  it("returns null and warns when bun:ffi is unavailable in the runtime", async () => {
    accessMock.mockResolvedValue(undefined);
    const { loadYoloBindings } = await loadModule();
    await expect(loadYoloBindings()).resolves.toBeNull();
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining("bun:ffi unavailable"),
    );
  });

  it("memoizes the bindings result across calls", async () => {
    accessMock.mockResolvedValue(undefined);
    const { loadYoloBindings } = await loadModule();
    const first = await loadYoloBindings();
    const second = await loadYoloBindings();
    expect(first).toBeNull();
    expect(second).toBe(first);
  });

  it("does not throw for a missing library — the vision path degrades to unavailable", async () => {
    accessMock.mockRejectedValue(new Error("ENOENT"));
    const { loadYoloBindings } = await loadModule();
    await expect(loadYoloBindings()).resolves.toBeNull();
    // no unhandled rejection, no throw
    expect(warnMock).toHaveBeenCalled();
  });
});
