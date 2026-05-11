import { describe, expect, it } from "vitest";
import {
  gpuLayersForKvOffload,
  resolveGpuLayersForLoad,
} from "./engine";

describe("gpuLayersForKvOffload", () => {
  it("maps KV placement requests onto node-llama-cpp gpuLayers settings", () => {
    expect(gpuLayersForKvOffload("cpu")).toBe(0);
    expect(gpuLayersForKvOffload("gpu")).toBe("max");
    expect(gpuLayersForKvOffload("split")).toBe("auto");
    expect(gpuLayersForKvOffload({ gpuLayers: 12 })).toBe(12);
  });
});

describe("resolveGpuLayersForLoad", () => {
  it("gives explicit gpuLayers precedence over kvOffload and useGpu", () => {
    expect(
      resolveGpuLayersForLoad({
        modelPath: "/tmp/eliza-1-9b.gguf",
        gpuLayers: 7,
        kvOffload: "cpu",
        useGpu: false,
      }),
    ).toBe(7);
  });

  it("uses kvOffload when no explicit gpuLayers override is present", () => {
    expect(
      resolveGpuLayersForLoad({
        modelPath: "/tmp/eliza-1-9b.gguf",
        kvOffload: "cpu",
      }),
    ).toBe(0);
    expect(
      resolveGpuLayersForLoad({
        modelPath: "/tmp/eliza-1-9b.gguf",
        kvOffload: "gpu",
      }),
    ).toBe("max");
  });

  it("keeps the previous auto/default behavior when no override is present", () => {
    expect(
      resolveGpuLayersForLoad({ modelPath: "/tmp/eliza-1-9b.gguf" }),
    ).toBe("auto");
    expect(
      resolveGpuLayersForLoad({
        modelPath: "/tmp/eliza-1-9b.gguf",
        useGpu: false,
      }),
    ).toBe(0);
  });
});
