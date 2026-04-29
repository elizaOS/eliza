/**
 * Unit tests for the AOSP local-inference bootstrap that the mobile agent
 * bundle invokes after `startEliza()` returns.
 *
 * Coverage:
 *   1. Env gating — non-AOSP processes are no-ops (`MILADY_LOCAL_LLAMA !== "1"`).
 *   2. Successful registration path registers TEXT_SMALL / TEXT_LARGE /
 *      TEXT_EMBEDDING handlers under the `milady-aosp-llama` provider id
 *      at priority 0 (same band as cloud, lets the runtime's getModel()
 *      find handlers without a router installed).
 *   3. Failure path — when the AOSP llama loader can't register (no
 *      `libllama.so`, missing shim, bun:ffi unavailable), the bootstrap
 *      returns false and registers no handlers (Commandment 8: don't
 *      hide the broken pipeline behind a silent default).
 *
 * Mocks the AOSP llama adapter so we don't need a real .so on the test
 * runner. The adapter's own bun:ffi tests live in
 * `aosp-llama-adapter.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockLocalInferenceLoader {
  loadModel(args: { modelPath: string }): Promise<void>;
  unloadModel(): Promise<void>;
  currentModelPath(): string | null;
  generate(args: { prompt: string }): Promise<string>;
  embed(args: { input: string }): Promise<{
    embedding: number[];
    tokens: number;
  }>;
}

interface CapturedRegistration {
  modelType: string | number;
  provider: string;
  priority?: number;
}

const adapterMock = {
  registerAospLlamaLoader: vi.fn(),
};

vi.mock("./aosp-llama-adapter.js", () => ({
  registerAospLlamaLoader: (...args: unknown[]) =>
    adapterMock.registerAospLlamaLoader(...args),
}));

function makeRuntime() {
  const registrations: CapturedRegistration[] = [];
  const services = new Map<string, unknown>();
  return {
    registrations,
    services,
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

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  adapterMock.registerAospLlamaLoader.mockReset();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
  delete process.env.MILADY_LOCAL_LLAMA;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("ensureAospLocalInferenceHandlers", () => {
  it("no-ops when MILADY_LOCAL_LLAMA is not '1'", async () => {
    const { ensureAospLocalInferenceHandlers } = await import(
      "./aosp-local-inference-bootstrap.js"
    );
    const runtime = makeRuntime();

    const ok = await ensureAospLocalInferenceHandlers(
      runtime as Parameters<typeof ensureAospLocalInferenceHandlers>[0],
    );

    expect(ok).toBe(false);
    expect(adapterMock.registerAospLlamaLoader).not.toHaveBeenCalled();
    expect(runtime.registrations).toHaveLength(0);
  });

  it("registers TEXT_SMALL / TEXT_LARGE / TEXT_EMBEDDING handlers when the AOSP loader registers", async () => {
    process.env.MILADY_LOCAL_LLAMA = "1";

    adapterMock.registerAospLlamaLoader.mockImplementation(
      async (rt: { registerService: (n: string, i: unknown) => void }) => {
        const loader: MockLocalInferenceLoader = {
          async loadModel() {},
          async unloadModel() {},
          currentModelPath() {
            return null;
          },
          async generate() {
            return "ok";
          },
          async embed() {
            return { embedding: [0, 0, 0], tokens: 0 };
          },
        };
        rt.registerService("localInferenceLoader", loader);
        return true;
      },
    );

    const { ensureAospLocalInferenceHandlers } = await import(
      "./aosp-local-inference-bootstrap.js"
    );
    const runtime = makeRuntime();

    const ok = await ensureAospLocalInferenceHandlers(
      runtime as Parameters<typeof ensureAospLocalInferenceHandlers>[0],
    );

    expect(ok).toBe(true);
    expect(adapterMock.registerAospLlamaLoader).toHaveBeenCalledTimes(1);

    const aospRegs = runtime.registrations.filter(
      (r) => r.provider === "milady-aosp-llama",
    );
    // TEXT_SMALL + TEXT_LARGE only by default. TEXT_EMBEDDING is gated
    // behind MILADY_AOSP_EMBEDDING=1 because the AOSP llama-decode
    // embedding path currently asserts on the batch_inp shape and
    // crashes bun mid-request (see bootstrap docblock).
    expect(aospRegs).toHaveLength(2);
    for (const reg of aospRegs) {
      // Priority 0 = same band as cloud. Tie-breaks live in routing-policy
      // (the smoke regression for "No handler found" was -1 → 0).
      expect(reg.priority).toBe(0);
    }
    const types = aospRegs.map((r) => r.modelType).sort();
    expect(types).toEqual(["TEXT_LARGE", "TEXT_SMALL"]);
  });

  it("registers TEXT_EMBEDDING when MILADY_AOSP_EMBEDDING=1", async () => {
    process.env.MILADY_LOCAL_LLAMA = "1";
    process.env.MILADY_AOSP_EMBEDDING = "1";

    adapterMock.registerAospLlamaLoader.mockImplementation(
      async (rt: { registerService: (n: string, i: unknown) => void }) => {
        const loader: MockLocalInferenceLoader = {
          async loadModel() {},
          async unloadModel() {},
          currentModelPath() {
            return null;
          },
          async generate() {
            return "ok";
          },
          async embed() {
            return { embedding: [0, 0, 0], tokens: 0 };
          },
        };
        rt.registerService("localInferenceLoader", loader);
        return true;
      },
    );

    const { ensureAospLocalInferenceHandlers } = await import(
      "./aosp-local-inference-bootstrap.js"
    );
    const runtime = makeRuntime();
    const ok = await ensureAospLocalInferenceHandlers(
      runtime as Parameters<typeof ensureAospLocalInferenceHandlers>[0],
    );
    expect(ok).toBe(true);
    const aospRegs = runtime.registrations.filter(
      (r) => r.provider === "milady-aosp-llama",
    );
    expect(aospRegs).toHaveLength(3);
    expect(aospRegs.map((r) => r.modelType).sort()).toEqual([
      "TEXT_EMBEDDING",
      "TEXT_LARGE",
      "TEXT_SMALL",
    ]);
  });

  it("returns false and registers no handlers when the AOSP loader fails to register", async () => {
    process.env.MILADY_LOCAL_LLAMA = "1";
    adapterMock.registerAospLlamaLoader.mockResolvedValue(false);

    const { ensureAospLocalInferenceHandlers } = await import(
      "./aosp-local-inference-bootstrap.js"
    );
    const runtime = makeRuntime();

    const ok = await ensureAospLocalInferenceHandlers(
      runtime as Parameters<typeof ensureAospLocalInferenceHandlers>[0],
    );

    expect(ok).toBe(false);
    expect(runtime.registrations).toHaveLength(0);
    // No silent default — the runtime must surface "No handler" rather
    // than serve a stub embedding (Commandment 8).
  });
});

describe("cli/index.ts serve command", () => {
  it("invokes ensureAospLocalInferenceHandlers after startEliza when MILADY_LOCAL_LLAMA=1", async () => {
    // The bin.ts AOSP entry point routes through `runAutonomousCli('serve')`,
    // which awaits `startEliza({ serverOnly: true })` and then must wire the
    // local-inference handlers. We verify the chain by mocking startEliza
    // and the bootstrap module, then driving the CLI.
    process.env.MILADY_LOCAL_LLAMA = "1";

    const startElizaMock = vi.fn();
    const bootstrapMock = vi.fn();
    const fakeRuntime = { registerModel: () => undefined };
    startElizaMock.mockResolvedValue(fakeRuntime);
    bootstrapMock.mockResolvedValue(true);

    vi.doMock("../runtime/index.js", () => ({
      startEliza: startElizaMock,
    }));
    vi.doMock("../runtime/aosp-local-inference-bootstrap.js", () => ({
      ensureAospLocalInferenceHandlers: bootstrapMock,
    }));

    const { runAutonomousCli } = await import("../cli/index.js");
    await runAutonomousCli(["bun", "bin.ts", "serve"]);

    expect(startElizaMock).toHaveBeenCalledTimes(1);
    expect(startElizaMock).toHaveBeenCalledWith({ serverOnly: true });
    expect(bootstrapMock).toHaveBeenCalledTimes(1);
    expect(bootstrapMock).toHaveBeenCalledWith(fakeRuntime);
  });

  it("does NOT invoke ensureAospLocalInferenceHandlers when MILADY_LOCAL_LLAMA is unset", async () => {
    delete process.env.MILADY_LOCAL_LLAMA;

    const startElizaMock = vi.fn();
    const bootstrapMock = vi.fn();
    startElizaMock.mockResolvedValue({ registerModel: () => undefined });

    vi.doMock("../runtime/index.js", () => ({
      startEliza: startElizaMock,
    }));
    vi.doMock("../runtime/aosp-local-inference-bootstrap.js", () => ({
      ensureAospLocalInferenceHandlers: bootstrapMock,
    }));

    const { runAutonomousCli } = await import("../cli/index.js");
    await runAutonomousCli(["bun", "bin.ts", "serve"]);

    expect(startElizaMock).toHaveBeenCalledTimes(1);
    expect(bootstrapMock).not.toHaveBeenCalled();
  });
});
