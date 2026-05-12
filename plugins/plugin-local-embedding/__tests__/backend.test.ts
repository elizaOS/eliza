import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chooseBackend } from "../src/index.ts";

const ORIG_PLATFORM = process.platform;
const ORIG_ARCH = process.arch;
const ORIG_CUDA = process.env.CUDA_VISIBLE_DEVICES;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function setArch(arch: NodeJS.Architecture): void {
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
}

function defaultConfig(overrides: Partial<{ LOCAL_EMBEDDING_FORCE_CPU: boolean }> = {}) {
  return {
    LOCAL_EMBEDDING_MODEL: "test.gguf",
    LOCAL_EMBEDDING_GPU_LAYERS: 0,
    LOCAL_EMBEDDING_USE_MMAP: true,
    LOCAL_EMBEDDING_FORCE_CPU: false,
    LOCAL_EMBEDDING_NORMALIZE: true,
    ...overrides,
  } as Parameters<typeof chooseBackend>[0];
}

describe("chooseBackend (hardware-aware probe)", () => {
  beforeEach(() => {
    delete process.env.CUDA_VISIBLE_DEVICES;
  });

  afterEach(() => {
    setPlatform(ORIG_PLATFORM);
    setArch(ORIG_ARCH);
    if (ORIG_CUDA === undefined) delete process.env.CUDA_VISIBLE_DEVICES;
    else process.env.CUDA_VISIBLE_DEVICES = ORIG_CUDA;
  });

  it("forces CPU on aarch64 when LOCAL_EMBEDDING_FORCE_CPU=1", () => {
    setArch("arm64");
    setPlatform("linux");
    const choice = chooseBackend(defaultConfig({ LOCAL_EMBEDDING_FORCE_CPU: true }));
    expect(choice.backend).toBe("neon-cpu");
    expect(choice.gpuOption).toBe(false);
    expect(choice.forced).toBe(true);
  });

  it("forces CPU on x86_64 when LOCAL_EMBEDDING_FORCE_CPU=1", () => {
    setArch("x64");
    setPlatform("linux");
    const choice = chooseBackend(defaultConfig({ LOCAL_EMBEDDING_FORCE_CPU: true }));
    expect(choice.backend).toBe("cpu");
    expect(choice.gpuOption).toBe(false);
    expect(choice.forced).toBe(true);
  });

  it("picks CUDA when CUDA_VISIBLE_DEVICES is set", () => {
    setPlatform("linux");
    setArch("x64");
    process.env.CUDA_VISIBLE_DEVICES = "0";
    const choice = chooseBackend(defaultConfig());
    expect(choice.backend).toBe("cuda");
    expect(choice.gpuOption).toBe("cuda");
  });

  it("ignores CUDA_VISIBLE_DEVICES=-1 (off marker)", () => {
    setPlatform("linux");
    setArch("x64");
    process.env.CUDA_VISIBLE_DEVICES = "-1";
    const choice = chooseBackend(defaultConfig());
    expect(choice.backend).toBe("vulkan");
    expect(choice.gpuOption).toBe("auto");
  });

  it("picks Metal on darwin", () => {
    setPlatform("darwin");
    setArch("arm64");
    const choice = chooseBackend(defaultConfig());
    expect(choice.backend).toBe("metal");
    expect(choice.gpuOption).toBe("metal");
  });

  it("falls through to NEON CPU on unknown platforms", () => {
    setPlatform("openbsd" as NodeJS.Platform);
    setArch("arm64");
    const choice = chooseBackend(defaultConfig());
    expect(choice.backend).toBe("neon-cpu");
    expect(choice.gpuOption).toBe(false);
  });

  it("falls through to generic CPU on unknown platforms with x64", () => {
    setPlatform("openbsd" as NodeJS.Platform);
    setArch("x64");
    const choice = chooseBackend(defaultConfig());
    expect(choice.backend).toBe("cpu");
    expect(choice.gpuOption).toBe(false);
  });
});
