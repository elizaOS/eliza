import { describe, expect, it } from "vitest";
import {
  getDflashTargetMetaBlockReason,
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
    expect(resolveGpuLayersForLoad({ modelPath: "/tmp/eliza-1-9b.gguf" })).toBe(
      "auto",
    );
    expect(
      resolveGpuLayersForLoad({
        modelPath: "/tmp/eliza-1-9b.gguf",
        useGpu: false,
      }),
    ).toBe(0);
  });
});

describe("getDflashTargetMetaBlockReason", () => {
  it("blocks staged stamp-only DFlash drafters", () => {
    expect(
      getDflashTargetMetaBlockReason({
        publishEligible: false,
        drafter: {
          matchesTargetCheckpoint: false,
          provenance: "dflash-drafter:stamp-only",
          sha256: "abc",
        },
        targetText: { sha256: "abc" },
      }),
    ).toBe("target-meta is not publishable");
  });

  it("blocks drafters with the same bytes as the target model", () => {
    expect(
      getDflashTargetMetaBlockReason({
        publishEligible: true,
        drafter: { sha256: "abc" },
        targetText: { sha256: "abc" },
      }),
    ).toBe("drafter bytes match the target model");
  });

  it("allows missing target metadata for older published bundles", () => {
    expect(getDflashTargetMetaBlockReason(null)).toBeNull();
  });
});
