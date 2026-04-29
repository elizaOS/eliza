/**
 * Unit tests for the AOSP llama.cpp FFI adapter. The full inference loop
 * requires a real `libllama.so` and is exercised by integration tests on a
 * real AOSP build. Here we cover:
 *
 *   1. Env gating — non-AOSP processes are no-ops.
 *   2. Library path resolution per ABI.
 *   3. Failure modes when the .so is missing while the user opted in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub `bun:ffi` so the adapter can be imported under Vitest (Node), which
// has no `bun:ffi` built-in. We use `vi.hoisted` so the alias is set before
// the dynamic import inside the adapter resolves.
vi.mock("bun:ffi", () => ({
  FFIType: {
    void: 0,
    bool: 1,
    i32: 2,
    u32: 3,
    i64: 4,
    f32: 5,
    ptr: 6,
    cstring: 7,
  },
  dlopen: vi.fn(() => ({
    symbols: new Proxy(
      {},
      {
        get:
          () =>
          (..._args: unknown[]) =>
            0,
      },
    ),
    close() {},
  })),
  ptr: () => 0,
  CString: class {},
  read: { cstring: () => "" },
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  // Restore env to prevent leakage across tests.
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    process.env[k] = v;
  }
});

describe("aosp-llama-adapter / env gating", () => {
  it("returns false when MILADY_LOCAL_LLAMA is unset", async () => {
    delete process.env.MILADY_LOCAL_LLAMA;
    const mod = await import("./aosp-llama-adapter");
    const services = new Map<string, unknown>();
    const runtime = {
      registerService(name: string, impl: unknown) {
        services.set(name, impl);
      },
    };
    const result = await mod.registerAospLlamaLoader(runtime);
    expect(result).toBe(false);
    expect(services.has("localInferenceLoader")).toBe(false);
  });

  it("returns false when registerService is missing", async () => {
    process.env.MILADY_LOCAL_LLAMA = "1";
    const mod = await import("./aosp-llama-adapter");
    const result = await mod.registerAospLlamaLoader({});
    expect(result).toBe(false);
  });
});

describe("aosp-llama-adapter / resolveLibllamaPath", () => {
  it("maps arm64 to arm64-v8a/libllama.so under cwd", async () => {
    const { resolveLibllamaPath } = await import("./aosp-llama-adapter");
    const p = resolveLibllamaPath("arm64", "/data/data/app/agent");
    expect(p).toBe("/data/data/app/agent/arm64-v8a/libllama.so");
  });

  it("maps x64 to x86_64/libllama.so under cwd", async () => {
    const { resolveLibllamaPath } = await import("./aosp-llama-adapter");
    const p = resolveLibllamaPath("x64", "/data/data/app/agent");
    expect(p).toBe("/data/data/app/agent/x86_64/libllama.so");
  });

  it("throws on unsupported architectures", async () => {
    const { resolveLibllamaPath } = await import("./aosp-llama-adapter");
    expect(() => resolveLibllamaPath("ia32", "/agent")).toThrow(
      /Unsupported process.arch/,
    );
  });
});

describe("aosp-llama-adapter / missing libllama.so", () => {
  it("logs and returns false when MILADY_LOCAL_LLAMA=1 but the .so is absent", async () => {
    process.env.MILADY_LOCAL_LLAMA = "1";
    const mod = await import("./aosp-llama-adapter");
    mod.__resetForTests();
    const services = new Map<string, unknown>();
    const runtime = {
      registerService(name: string, impl: unknown) {
        services.set(name, impl);
      },
    };
    // CWD in vitest is the package root, so `<cwd>/x86_64/libllama.so` does
    // not exist — the adapter should detect that, log, and refuse to register.
    const result = await mod.registerAospLlamaLoader(runtime);
    expect(result).toBe(false);
    expect(services.has("localInferenceLoader")).toBe(false);
  });
});
