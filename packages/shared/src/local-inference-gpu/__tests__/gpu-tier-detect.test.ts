import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execSync: mocks.execSync }));
vi.mock("./gpu-tier-profiles.js", () => ({
  getGpuProfile: () => null,
  selectBestProfile: () => null,
}));

import { detectNvidiaGpu } from "./gpu-tier-detect.ts";

describe("detectNvidiaGpu", () => {
  it("parses nvidia-smi output", () => {
    mocks.execSync.mockReturnValue("NVIDIA GeForce RTX 4090, 24564, 8.9\n");
    const gpu = detectNvidiaGpu();
    expect(gpu?.name).toContain("RTX 4090");
    expect(gpu?.vram_mb).toBe(24564);
    expect(gpu?.cuda_compute).toBe("8.9");
  });

  it("handles missing compute capability", () => {
    mocks.execSync.mockReturnValue("Tesla T4, 15360, N/A\n");
    const gpu = detectNvidiaGpu();
    expect(gpu?.name).toContain("T4");
    expect(gpu?.cuda_compute).toBeNull();
  });

  it("returns null when nvidia-smi fails (fail-closed)", () => {
    mocks.execSync.mockImplementation(() => {
      throw new Error("command not found");
    });
    expect(detectNvidiaGpu()).toBeNull();
  });

  it("returns null on empty output", () => {
    mocks.execSync.mockReturnValue("\n\n");
    expect(detectNvidiaGpu()).toBeNull();
  });
});
