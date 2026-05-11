import { afterEach, describe, expect, it } from "vitest";
import {
  BackendDispatcher,
  decideBackend,
  gpuLayersForKvOffload,
  type LocalInferenceBackend,
  readBackendOverride,
} from "./backend";
import { LocalInferenceEngine } from "./engine";
import type { CatalogModel } from "./types";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const BASE_CATALOG: CatalogModel = {
  id: "test-model",
  displayName: "Test Model",
  hfRepo: "fake/Test-GGUF",
  ggufFile: "Test-Q4.gguf",
  params: "4B",
  quant: "Q4_K_M",
  sizeGb: 2.5,
  minRamGb: 5,
  category: "chat",
  bucket: "small",
  blurb: "test",
};

function withRuntime(
  base: CatalogModel,
  runtime: CatalogModel["runtime"],
): CatalogModel {
  return { ...base, runtime };
}

describe("readBackendOverride", () => {
  it("returns 'auto' when unset", () => {
    delete process.env.ELIZA_LOCAL_BACKEND;
    expect(readBackendOverride()).toBe("auto");
  });

  it("returns 'auto' for unknown values", () => {
    process.env.ELIZA_LOCAL_BACKEND = "magic";
    expect(readBackendOverride()).toBe("auto");
  });

  it("respects explicit overrides", () => {
    process.env.ELIZA_LOCAL_BACKEND = "node-llama-cpp";
    expect(readBackendOverride()).toBe("node-llama-cpp");
    process.env.ELIZA_LOCAL_BACKEND = "llama-server";
    expect(readBackendOverride()).toBe("llama-server");
  });
});

describe("gpuLayersForKvOffload", () => {
  it("maps KV placement requests onto backend gpuLayers settings", () => {
    expect(gpuLayersForKvOffload("cpu")).toBe(0);
    expect(gpuLayersForKvOffload("gpu")).toBe("max");
    expect(gpuLayersForKvOffload("split")).toBe("auto");
    expect(gpuLayersForKvOffload({ gpuLayers: 12 })).toBe(12);
  });
});

describe("decideBackend", () => {
  it("defaults to node-llama-cpp for stock GGUFs", () => {
    const decision = decideBackend({
      override: "auto",
      catalog: BASE_CATALOG,
      llamaServerAvailable: true,
      dflashRequired: false,
    });
    expect(decision.backend).toBe("node-llama-cpp");
    expect(decision.reason).toBe("default");
  });

  it("routes to llama-server when a kernel is required", () => {
    const catalog = withRuntime(BASE_CATALOG, {
      optimizations: { requiresKernel: ["dflash"] },
    });
    const decision = decideBackend({
      override: "auto",
      catalog,
      llamaServerAvailable: false,
      dflashRequired: false,
    });
    expect(decision.backend).toBe("llama-server");
    expect(decision.reason).toBe("kernel-required");
    expect(decision.kernels).toEqual(["dflash"]);
  });

  it("env override wins over default", () => {
    const decision = decideBackend({
      override: "llama-server",
      catalog: BASE_CATALOG,
      llamaServerAvailable: true,
      dflashRequired: false,
    });
    expect(decision.backend).toBe("llama-server");
    expect(decision.reason).toBe("env-override");
  });

  it("env override is overridden by hard kernel requirement", () => {
    const catalog = withRuntime(BASE_CATALOG, {
      optimizations: { requiresKernel: ["turbo3"] },
    });
    const decision = decideBackend({
      override: "node-llama-cpp",
      catalog,
      llamaServerAvailable: true,
      dflashRequired: false,
    });
    // The user can't ask the in-process binding to run turbo3.
    expect(decision.backend).toBe("llama-server");
    expect(decision.reason).toBe("kernel-required");
  });

  it("respects preferredBackend=llama-server when binary available", () => {
    const catalog = withRuntime(BASE_CATALOG, {
      preferredBackend: "llama-server",
    });
    const decision = decideBackend({
      override: "auto",
      catalog,
      llamaServerAvailable: true,
      dflashRequired: false,
    });
    expect(decision.backend).toBe("llama-server");
    expect(decision.reason).toBe("preferred-backend");
  });

  it("falls back to node-llama-cpp when preferredBackend=llama-server but binary missing and DFlash not required", () => {
    const catalog = withRuntime(BASE_CATALOG, {
      preferredBackend: "llama-server",
    });
    const decision = decideBackend({
      override: "auto",
      catalog,
      llamaServerAvailable: false,
      dflashRequired: false,
    });
    expect(decision.backend).toBe("node-llama-cpp");
    expect(decision.reason).toBe("default");
  });

  it("forces llama-server when DFlash is required and configured, even if binary probe is false", () => {
    const catalog = withRuntime(BASE_CATALOG, {
      preferredBackend: "llama-server",
      dflash: {
        drafterModelId: "x",
        specType: "dflash",
        contextSize: 8192,
        draftContextSize: 256,
        draftMin: 1,
        draftMax: 16,
        gpuLayers: "auto",
        draftGpuLayers: "auto",
        disableThinking: true,
      },
    });
    const decision = decideBackend({
      override: "auto",
      catalog,
      llamaServerAvailable: false,
      dflashRequired: true,
    });
    expect(decision.backend).toBe("llama-server");
    expect(decision.reason).toBe("dflash-required");
  });

  it("returns default when no catalog entry is supplied", () => {
    const decision = decideBackend({
      override: "auto",
      catalog: undefined,
      llamaServerAvailable: true,
      dflashRequired: false,
    });
    expect(decision.backend).toBe("node-llama-cpp");
    expect(decision.reason).toBe("default");
  });
});

class FakeBackend implements LocalInferenceBackend {
  loaded = false;
  unloads = 0;
  loadCalls: string[] = [];

  constructor(public readonly id: "node-llama-cpp" | "llama-server") {}

  async available(): Promise<boolean> {
    return true;
  }

  async load(plan: { modelPath: string }): Promise<void> {
    this.loaded = true;
    this.loadCalls.push(plan.modelPath);
  }

  async unload(): Promise<void> {
    this.loaded = false;
    this.unloads += 1;
  }

  async generate(): Promise<string> {
    return `${this.id}:reply`;
  }

  hasLoadedModel(): boolean {
    return this.loaded;
  }

  currentModelPath(): string | null {
    return this.loaded ? (this.loadCalls.at(-1) ?? null) : null;
  }
}

describe("BackendDispatcher", () => {
  it("loads node-llama-cpp by default", async () => {
    const node = new FakeBackend("node-llama-cpp");
    const server = new FakeBackend("llama-server");
    const d = new BackendDispatcher(
      node,
      server,
      () => true,
      () => false,
    );
    await d.load({ modelPath: "/m.gguf", catalog: BASE_CATALOG });
    expect(d.activeBackendId()).toBe("node-llama-cpp");
    expect(node.loaded).toBe(true);
    expect(server.loaded).toBe(false);
    expect(await d.generate({ prompt: "hi" })).toBe("node-llama-cpp:reply");
  });

  it("switches backends when the decision differs and unloads the previous", async () => {
    const node = new FakeBackend("node-llama-cpp");
    const server = new FakeBackend("llama-server");
    const d = new BackendDispatcher(
      node,
      server,
      () => true,
      () => false,
    );
    await d.load({ modelPath: "/m.gguf", catalog: BASE_CATALOG });
    expect(d.activeBackendId()).toBe("node-llama-cpp");

    const kernelCatalog = withRuntime(BASE_CATALOG, {
      optimizations: { requiresKernel: ["dflash"] },
    });
    await d.load({ modelPath: "/m2.gguf", catalog: kernelCatalog });
    expect(d.activeBackendId()).toBe("llama-server");
    expect(node.unloads).toBe(1);
    expect(server.loaded).toBe(true);
  });

  it("throws on generate before load", async () => {
    const d = new BackendDispatcher(
      new FakeBackend("node-llama-cpp"),
      new FakeBackend("llama-server"),
      () => true,
      () => false,
    );
    await expect(d.generate({ prompt: "x" })).rejects.toThrow(
      /No backend loaded/,
    );
  });
});

describe("LocalInferenceEngine backend fallback", () => {
  it("does not fall back when llama-server was selected for required kernels", async () => {
    const engine = new LocalInferenceEngine();
    const internals = engine as unknown as {
      dispatcher: {
        load(plan: unknown): Promise<void>;
        decide(plan: unknown): ReturnType<typeof decideBackend>;
      };
      nodeBackend: { load(plan: unknown): Promise<void> };
    };
    let nodeLoads = 0;
    internals.dispatcher.load = async () => {
      throw new Error("missing turbo3 kernel");
    };
    internals.dispatcher.decide = () => ({
      backend: "llama-server",
      reason: "kernel-required",
      kernels: ["turbo3"],
      unsatisfiedKernels: ["turbo3"],
    });
    internals.nodeBackend.load = async () => {
      nodeLoads += 1;
    };

    await expect(engine.load("/tmp/eliza-1.gguf")).rejects.toThrow(
      /missing turbo3 kernel/,
    );
    expect(nodeLoads).toBe(0);
  });

  it("still falls back when llama-server was only a soft preference", async () => {
    const engine = new LocalInferenceEngine();
    const internals = engine as unknown as {
      dispatcher: {
        load(plan: unknown): Promise<void>;
        decide(plan: unknown): ReturnType<typeof decideBackend>;
      };
      nodeBackend: { load(plan: unknown): Promise<void> };
    };
    let nodeLoads = 0;
    internals.dispatcher.load = async () => {
      throw new Error("llama-server unavailable");
    };
    internals.dispatcher.decide = () => ({
      backend: "llama-server",
      reason: "preferred-backend",
      kernels: [],
    });
    internals.nodeBackend.load = async () => {
      nodeLoads += 1;
    };

    await expect(engine.load("/tmp/soft-preference.gguf")).resolves.toBe(
      undefined,
    );
    expect(nodeLoads).toBe(1);
  });
});

describe("decideBackend kernel-availability probe", () => {
  it("returns no unsatisfiedKernels when no probe is provided (older binaries)", () => {
    const catalog = withRuntime(BASE_CATALOG, {
      optimizations: { requiresKernel: ["dflash"] },
    });
    const decision = decideBackend({
      override: "auto",
      catalog,
      llamaServerAvailable: true,
      dflashRequired: false,
    });
    expect(decision.unsatisfiedKernels).toBeUndefined();
  });

  it("returns empty unsatisfiedKernels when binary advertises required kernels", () => {
    const catalog = withRuntime(BASE_CATALOG, {
      optimizations: { requiresKernel: ["dflash", "turbo3"] },
    });
    const decision = decideBackend({
      override: "auto",
      catalog,
      llamaServerAvailable: true,
      dflashRequired: false,
      binaryKernels: { dflash: true, turbo3: true, turbo4: false },
    });
    expect(decision.unsatisfiedKernels).toEqual([]);
  });

  it("flags missing kernels when binary lacks them", () => {
    const catalog = withRuntime(BASE_CATALOG, {
      optimizations: { requiresKernel: ["dflash", "turbo3_tcq"] },
    });
    const decision = decideBackend({
      override: "auto",
      catalog,
      llamaServerAvailable: true,
      dflashRequired: false,
      binaryKernels: { dflash: true, turbo3_tcq: false },
    });
    expect(decision.unsatisfiedKernels).toEqual(["turbo3_tcq"]);
  });

  it("rejects load when required kernels are unsatisfied", async () => {
    const node = new FakeBackend("node-llama-cpp");
    const server = new FakeBackend("llama-server");
    const d = new BackendDispatcher(
      node,
      server,
      () => true,
      () => false,
      () => ({ dflash: true, turbo3_tcq: false }),
    );
    const catalog = withRuntime(BASE_CATALOG, {
      optimizations: { requiresKernel: ["turbo3_tcq"] },
    });
    await expect(d.load({ modelPath: "/m.gguf", catalog })).rejects.toThrow(
      /turbo3_tcq.*does not advertise/,
    );
    expect(server.loaded).toBe(false);
    expect(node.loaded).toBe(false);
  });

  it("loads cleanly when probed kernels match the requirement", async () => {
    const node = new FakeBackend("node-llama-cpp");
    const server = new FakeBackend("llama-server");
    const d = new BackendDispatcher(
      node,
      server,
      () => true,
      () => false,
      () => ({ dflash: true, turbo3: true }),
    );
    const catalog = withRuntime(BASE_CATALOG, {
      optimizations: { requiresKernel: ["dflash"] },
    });
    await d.load({ modelPath: "/m.gguf", catalog });
    expect(d.activeBackendId()).toBe("llama-server");
  });
});
