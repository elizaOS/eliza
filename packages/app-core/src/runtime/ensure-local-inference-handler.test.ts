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

    expect(
      runtime.registrations.filter(
        (r) => r.provider === "milady-device-bridge",
      ),
    ).toHaveLength(2);
    expect(runtime.getService("localInferenceLoader")).toBeTruthy();
  });
});
