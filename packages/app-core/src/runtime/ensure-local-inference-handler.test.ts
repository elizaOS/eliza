import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureLocalInferenceHandler } from "./ensure-local-inference-handler";

type CapacitorGlobal = {
  Capacitor?: {
    isNativePlatform?: () => boolean;
  };
};

interface CapturedRegistration {
  modelType: string | number;
  provider: string;
  priority?: number;
}

interface MockLocalInferenceLoader {
  currentModelPath(): string | null;
}

vi.mock("@elizaos/capacitor-llama", () => ({
  registerCapacitorLlamaLoader(runtime: {
    registerService?: (name: string, impl: MockLocalInferenceLoader) => unknown;
  }) {
    runtime.registerService?.("localInferenceLoader", {
      currentModelPath: () => null,
    });
  },
}));

vi.mock("@elizaos/agent/runtime/aosp-llama-adapter", () => ({
  registerAospLlamaLoader(runtime: {
    registerService?: (name: string, impl: MockLocalInferenceLoader) => unknown;
  }) {
    runtime.registerService?.("localInferenceLoader", {
      currentModelPath: () => null,
      // The AOSP adapter exposes an `embed` surface (bun:ffi via
      // llama_get_embeddings_seq). Tests that exercise the AOSP code path
      // expect TEXT_EMBEDDING to be registered alongside generate slots.
      async embed() {
        return { embedding: [0, 0, 0], tokens: 0 };
      },
    });
    return true;
  },
}));

function makeRuntime() {
  const registrations: CapturedRegistration[] = [];
  const services = new Map<string, unknown>();
  return {
    registrations,
    getModel: () => undefined,
    registerModel(
      modelType: string | number,
      _handler: unknown,
      provider: string,
      priority?: number,
    ) {
      registrations.push({ modelType, provider, priority });
    },
    registerService(name: string, impl: unknown) {
      services.set(name, impl);
    },
    getService(name: string) {
      return services.get(name);
    },
  };
}

afterEach(() => {
  delete (globalThis as CapacitorGlobal).Capacitor;
  delete process.env.ELIZA_DEVICE_BRIDGE_ENABLED;
  delete process.env.MILADY_LOCAL_LLAMA;
  delete process.env.MILADY_PLATFORM;
});

describe("ensureLocalInferenceHandler", () => {
  it("registers mobile handlers under the capacitor-llama provider id", async () => {
    (globalThis as CapacitorGlobal).Capacitor = {
      isNativePlatform: () => true,
    };
    const runtime = makeRuntime();

    await ensureLocalInferenceHandler(
      runtime as Parameters<typeof ensureLocalInferenceHandler>[0],
    );

    expect(
      runtime.registrations.filter((r) => r.provider === "capacitor-llama"),
    ).toHaveLength(2);
    expect(runtime.getService("localInferenceLoader")).toBeTruthy();
  });

  it("registers paired-device handlers under the device-bridge provider id", async () => {
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
    const runtime = makeRuntime();

    await ensureLocalInferenceHandler(
      runtime as Parameters<typeof ensureLocalInferenceHandler>[0],
    );

    // TEXT_SMALL + TEXT_LARGE + TEXT_EMBEDDING — the device-bridge
    // loader exposes `embed` so the embedding handler is wired in too.
    expect(
      runtime.registrations.filter(
        (r) => r.provider === "milady-device-bridge",
      ),
    ).toHaveLength(3);
    expect(runtime.getService("localInferenceLoader")).toBeTruthy();
  });

  it("registers device-bridge loader when MILADY_PLATFORM=android with ELIZA_DEVICE_BRIDGE_ENABLED=1", async () => {
    process.env.MILADY_PLATFORM = "android";
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
    const runtime = makeRuntime();

    await ensureLocalInferenceHandler(
      runtime as Parameters<typeof ensureLocalInferenceHandler>[0],
    );

    expect(
      runtime.registrations.filter(
        (r) => r.provider === "milady-device-bridge",
      ),
    ).toHaveLength(3);
  });

  it("registers AOSP llama loader under the milady-aosp-llama provider when MILADY_LOCAL_LLAMA=1", async () => {
    process.env.MILADY_PLATFORM = "android";
    process.env.MILADY_LOCAL_LLAMA = "1";
    const runtime = makeRuntime();

    await ensureLocalInferenceHandler(
      runtime as Parameters<typeof ensureLocalInferenceHandler>[0],
    );

    // TEXT_SMALL + TEXT_LARGE + TEXT_EMBEDDING because the AOSP loader
    // exposes `embed` (bun:ffi via llama_get_embeddings_seq).
    expect(
      runtime.registrations.filter((r) => r.provider === "milady-aosp-llama"),
    ).toHaveLength(3);
    expect(runtime.getService("localInferenceLoader")).toBeTruthy();
    // AOSP wins over Capacitor and device-bridge.
    expect(
      runtime.registrations.filter(
        (r) =>
          r.provider === "capacitor-llama" ||
          r.provider === "milady-device-bridge",
      ),
    ).toHaveLength(0);
  });

  it("registers TEXT_EMBEDDING under the AOSP provider when the loader exposes embed()", async () => {
    process.env.MILADY_PLATFORM = "android";
    process.env.MILADY_LOCAL_LLAMA = "1";
    const runtime = makeRuntime();

    await ensureLocalInferenceHandler(
      runtime as Parameters<typeof ensureLocalInferenceHandler>[0],
    );

    // The router-handler ALSO registers TEXT_EMBEDDING at MAX_SAFE_INTEGER
    // priority, so we look specifically for the AOSP-provider registration
    // that proves the loader-backed embedding handler was wired in.
    const aospEmbeddingRegs = runtime.registrations.filter(
      (r) =>
        r.modelType === "TEXT_EMBEDDING" && r.provider === "milady-aosp-llama",
    );
    expect(aospEmbeddingRegs).toHaveLength(1);
  });

  it("does NOT register a loader-backed TEXT_EMBEDDING when the active loader has no embed surface", async () => {
    // Capacitor mock doesn't expose embed — TEXT_EMBEDDING must fall
    // through to the operator's configured cloud provider, not be served
    // by a silent stub. (Commandment 8.) The router still registers a
    // TEXT_EMBEDDING entry at max priority, but the local-inference
    // provider must not.
    (globalThis as CapacitorGlobal).Capacitor = {
      isNativePlatform: () => true,
    };
    const runtime = makeRuntime();

    await ensureLocalInferenceHandler(
      runtime as Parameters<typeof ensureLocalInferenceHandler>[0],
    );

    const capacitorEmbeddingRegs = runtime.registrations.filter(
      (r) =>
        r.modelType === "TEXT_EMBEDDING" && r.provider === "capacitor-llama",
    );
    expect(capacitorEmbeddingRegs).toHaveLength(0);
  });
});
