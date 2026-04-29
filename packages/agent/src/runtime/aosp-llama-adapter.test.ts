/**
 * Unit tests for the AOSP llama.cpp FFI adapter. The full inference loop
 * requires a real `libllama.so` and is exercised by integration tests on a
 * real AOSP build. Here we cover:
 *
 *   1. Env gating — non-AOSP processes are no-ops.
 *   2. Library path resolution per ABI.
 *   3. Failure modes when the .so is missing while the user opted in.
 *   4. The dlopen symbol manifest matches the post-b4500 llama.h surface
 *      (sampler chain + embedding helpers). This is the regression test
 *      that catches "the binary ships with stale symbols and dlsym returns
 *      NULL at first call". See b3490 → b4500 pin bump.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dlopenSpy = vi.fn();

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
  dlopen: (...args: unknown[]) => {
    dlopenSpy(...args);
    return {
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
    };
  },
  ptr: () => 0,
  CString: class {},
  read: { cstring: () => "" },
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  dlopenSpy.mockClear();
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

describe("aosp-llama-adapter / dlopen symbol manifest", () => {
  /**
   * Regression for the b3490 → b4500 pin bump: the adapter must request
   * the post-rewrite symbol set. If a future change drops a symbol the
   * adapter relies on, dlopen() in Bun would resolve it to NULL and
   * the first inference call would explode at runtime — this test
   * catches that at compile/test time instead.
   *
   * We intercept `node:fs.existsSync` so the adapter's libllama.so guard
   * passes, then assert the symbol map handed to dlopen.
   */
  it("requests sampler-chain + embedding + post-rewrite model/vocab symbols", async () => {
    process.env.MILADY_LOCAL_LLAMA = "1";

    vi.doMock("node:fs", () => ({
      existsSync: () => true,
    }));

    const mod = await import("./aosp-llama-adapter");
    mod.__resetForTests();
    const services = new Map<string, unknown>();
    const runtime = {
      registerService(name: string, impl: unknown) {
        services.set(name, impl);
      },
    };

    const result = await mod.registerAospLlamaLoader(runtime);
    expect(result).toBe(true);
    expect(dlopenSpy).toHaveBeenCalledTimes(1);

    // The registered loader implements the embed() surface from
    // LocalInferenceLoader. Other shape assertions live in the contract
    // tests; here we just confirm the function exists so a future refactor
    // can't drop it silently from the registerService payload.
    const loader = services.get("localInferenceLoader") as
      | { embed?: unknown; generate?: unknown }
      | undefined;
    expect(loader).toBeDefined();
    expect(typeof loader?.embed).toBe("function");
    expect(typeof loader?.generate).toBe("function");

    const symbolMap = dlopenSpy.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(symbolMap).toBeDefined();
    if (!symbolMap) return;

    // Sampler chain API (post-rewrite, b3700+): the previous pin (b3490)
    // had none of these. dlsym on b3490 would have returned NULL.
    const samplerChainSymbols = [
      "llama_sampler_chain_init",
      "llama_sampler_chain_add",
      "llama_sampler_chain_default_params",
      "llama_sampler_init_temp",
      "llama_sampler_init_top_p",
      "llama_sampler_init_dist",
      "llama_sampler_init_greedy",
      "llama_sampler_sample",
      "llama_sampler_accept",
      "llama_sampler_free",
    ];
    for (const sym of samplerChainSymbols) {
      expect(symbolMap).toHaveProperty(sym);
    }

    // Renamed model + vocab API (b4450+).
    const renamedSymbols = [
      "llama_model_load_from_file",
      "llama_model_free",
      "llama_init_from_model",
      "llama_model_get_vocab",
      "llama_vocab_eos",
      "llama_vocab_is_eog",
    ];
    for (const sym of renamedSymbols) {
      expect(symbolMap).toHaveProperty(sym);
    }

    // Embedding helpers — required for the bun:ffi embed() path.
    const embeddingSymbols = [
      "llama_set_embeddings",
      "llama_get_embeddings_seq",
      "llama_get_embeddings",
      "llama_model_n_embd",
    ];
    for (const sym of embeddingSymbols) {
      expect(symbolMap).toHaveProperty(sym);
    }

    vi.doUnmock("node:fs");
  });
});
