/**
 * Behavioral coverage for the GPU tier detection utilities: the nvidia-smi
 * output parser (comma-safe name splitting, N/A compute capability, malformed
 * rows) and the auto-select override/fallback contract. The module must never
 * throw — every failure path returns null so callers fall back to CPU.
 */

import { execSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { autoSelectProfile, detectNvidiaGpu } from "./gpu-tier-detect.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

function captureEnv(key: string): string | undefined {
  const value = process.env[key];
  delete process.env[key];
  return value;
}

describe("detectNvidiaGpu", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("parses a canonical nvidia-smi row", () => {
    mockExecSync.mockReturnValue(
      "NVIDIA GeForce RTX 4090, 24564, 8.9\n" as never,
    );
    expect(detectNvidiaGpu()).toEqual({
      name: "NVIDIA GeForce RTX 4090",
      vram_mb: 24564,
      cuda_compute: "8.9",
    });
  });

  it("keeps a GPU name that itself contains commas intact", () => {
    mockExecSync.mockReturnValue("NVIDIA A100 SXM4, 40960, 8.0\n" as never);
    expect(detectNvidiaGpu()).toEqual({
      name: "NVIDIA A100 SXM4",
      vram_mb: 40960,
      cuda_compute: "8.0",
    });
  });

  it("treats an N/A compute capability as null", () => {
    mockExecSync.mockReturnValue("NVIDIA GTX 1080, 8192, N/A\n" as never);
    expect(detectNvidiaGpu()).toEqual({
      name: "NVIDIA GTX 1080",
      vram_mb: 8192,
      cuda_compute: null,
    });
  });

  it("returns null for an empty or whitespace-only output", () => {
    mockExecSync.mockReturnValue("" as never);
    expect(detectNvidiaGpu()).toBeNull();
    mockExecSync.mockReturnValue("\n\n" as never);
    expect(detectNvidiaGpu()).toBeNull();
  });

  it("returns null when a row has too few fields", () => {
    mockExecSync.mockReturnValue("NVIDIA GTX 1080, 8192\n" as never);
    expect(detectNvidiaGpu()).toBeNull();
  });

  it("returns null when the VRAM field is not a positive integer", () => {
    mockExecSync.mockReturnValue("NVIDIA GTX 1080, abc, 6.1\n" as never);
    expect(detectNvidiaGpu()).toBeNull();
    mockExecSync.mockReturnValue("NVIDIA GTX 1080, 0, 6.1\n" as never);
    expect(detectNvidiaGpu()).toBeNull();
  });

  it("returns null when the execSync failure path is taken (missing binary / no GPU)", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("spawn nvidia-smi ENOENT");
    });
    expect(detectNvidiaGpu()).toBeNull();
  });
});

describe("autoSelectProfile", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the named profile when ELIZA_GPU_PROFILE is set, without probing the GPU", () => {
    const previous = captureEnv("ELIZA_GPU_PROFILE");
    try {
      process.env.ELIZA_GPU_PROFILE = "rtx-4090";
      const profile = autoSelectProfile();
      expect(profile).not.toBeNull();
      expect(profile?.id).toBe("rtx-4090");
      expect(mockExecSync).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.ELIZA_GPU_PROFILE;
      else process.env.ELIZA_GPU_PROFILE = previous;
    }
  });

  it("returns null for an unrecognised ELIZA_GPU_PROFILE id", () => {
    const previous = captureEnv("ELIZA_GPU_PROFILE");
    try {
      process.env.ELIZA_GPU_PROFILE = "not-a-real-card";
      expect(autoSelectProfile()).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.ELIZA_GPU_PROFILE;
      else process.env.ELIZA_GPU_PROFILE = previous;
    }
  });

  it("returns null when no GPU is detected", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("spawn nvidia-smi ENOENT");
    });
    expect(autoSelectProfile()).toBeNull();
  });

  it("selects the best fitting profile from a detected GPU", () => {
    mockExecSync.mockReturnValue("NVIDIA RTX A6000, 49152, 8.6\n" as never);
    const profile = autoSelectProfile();
    expect(profile).not.toBeNull();
    expect(profile?.vram_gb).toBeLessThanOrEqual(49152 / 1024);
  });
});
