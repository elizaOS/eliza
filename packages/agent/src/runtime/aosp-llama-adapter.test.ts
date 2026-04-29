/**
 * Unit tests for the AOSP llama.cpp FFI adapter. The full inference loop
 * requires a real `libllama.so` + `libmilady-llama-shim.so` and is
 * exercised by integration tests on a real AOSP build. Here we cover:
 *
 *   1. Env gating — non-AOSP processes are no-ops.
 *   2. Library path resolution per ABI (libllama.so + shim).
 *   3. Failure modes when the .so is missing while the user opted in.
 *   4. The dlopen symbol manifests match the post-b4500 llama.h surface
 *      (sampler chain + embedding helpers) AND the
 *      libmilady-llama-shim.so surface (struct-by-value workaround,
 *      malloc'd-pointer + per-field setter pattern). This is the
 *      regression test that catches "the binary ships with stale symbols
 *      and dlsym returns NULL at first call". See b3490 → b4500 pin bump
 *      and the bun:ffi struct-by-value workaround.
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

describe("aosp-llama-adapter / resolveLlamaShimPath", () => {
  it("resolves the shim alongside libllama.so in the per-ABI dir", async () => {
    const { resolveLlamaShimPath } = await import("./aosp-llama-adapter");
    expect(resolveLlamaShimPath("arm64", "/data/data/app/agent")).toBe(
      "/data/data/app/agent/arm64-v8a/libmilady-llama-shim.so",
    );
    expect(resolveLlamaShimPath("x64", "/data/data/app/agent")).toBe(
      "/data/data/app/agent/x86_64/libmilady-llama-shim.so",
    );
  });

  it("throws on unsupported architectures", async () => {
    const { resolveLlamaShimPath } = await import("./aosp-llama-adapter");
    expect(() => resolveLlamaShimPath("ia32", "/agent")).toThrow(
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
  it("dlopens libllama.so first then libmilady-llama-shim.so with the right symbol manifests", async () => {
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
    // Two dlopen calls: libllama.so first (its symbols populate the
    // global namespace), then libmilady-llama-shim.so (NEEDED libllama.so).
    expect(dlopenSpy).toHaveBeenCalledTimes(2);

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

    const firstCall = dlopenSpy.mock.calls[0];
    const secondCall = dlopenSpy.mock.calls[1];
    expect(firstCall?.[0]).toMatch(/libllama\.so$/);
    expect(secondCall?.[0]).toMatch(/libmilady-llama-shim\.so$/);

    const llamaSymbols = firstCall?.[1] as Record<string, unknown> | undefined;
    const shimSymbols = secondCall?.[1] as Record<string, unknown> | undefined;
    expect(llamaSymbols).toBeDefined();
    expect(shimSymbols).toBeDefined();
    if (!llamaSymbols || !shimSymbols) return;

    // libllama.so: sampler chain API (post-rewrite, b3700+). The previous
    // pin (b3490) had none of these.
    const samplerChainSymbols = [
      "llama_sampler_chain_add",
      "llama_sampler_init_temp",
      "llama_sampler_init_top_p",
      "llama_sampler_init_dist",
      "llama_sampler_init_greedy",
      "llama_sampler_sample",
      "llama_sampler_accept",
      "llama_sampler_free",
    ];
    for (const sym of samplerChainSymbols) {
      expect(llamaSymbols).toHaveProperty(sym);
    }

    // libllama.so: renamed model + vocab API (b4450+). Free/getter symbols
    // stay on libllama; the struct-by-value entry points move to the shim.
    const llamaSymbolsThatStay = [
      "llama_model_free",
      "llama_model_get_vocab",
      "llama_vocab_eos",
      "llama_vocab_is_eog",
    ];
    for (const sym of llamaSymbolsThatStay) {
      expect(llamaSymbols).toHaveProperty(sym);
    }

    // bun:ffi cannot pass struct-by-value arguments. These six symbols are
    // the struct-by-value entry points in llama.h b4500; they MUST be bound
    // through libmilady-llama-shim.so, NOT directly here. If a future
    // refactor adds them back to the libllama dlopen call, the wrapper
    // would silently fall back to passing zeroed buffers and clobber the
    // canonical defaults — exactly the bug this commit fixes.
    const structByValueSymbolsThatMustNotBeHere = [
      "llama_model_default_params",
      "llama_context_default_params",
      "llama_sampler_chain_default_params",
      "llama_model_load_from_file",
      "llama_init_from_model",
      "llama_sampler_chain_init",
    ];
    for (const sym of structByValueSymbolsThatMustNotBeHere) {
      expect(llamaSymbols).not.toHaveProperty(sym);
    }

    // libllama.so: embedding helpers — required for the bun:ffi embed() path.
    const embeddingSymbols = [
      "llama_set_embeddings",
      "llama_get_embeddings_seq",
      "llama_get_embeddings",
      "llama_model_n_embd",
    ];
    for (const sym of embeddingSymbols) {
      expect(llamaSymbols).toHaveProperty(sym);
    }

    // libmilady-llama-shim.so: pointer-style wrappers around the
    // struct-by-value entry points + per-field setters. Each *_default()
    // returns a malloc'd pointer; *_free() releases it; setters mutate
    // fields before the pointer is handed to the load/init/chain-init
    // wrapper.
    const shimDefaultsAndFrees = [
      "milady_llama_model_params_default",
      "milady_llama_model_params_free",
      "milady_llama_context_params_default",
      "milady_llama_context_params_free",
      "milady_llama_sampler_chain_params_default",
      "milady_llama_sampler_chain_params_free",
    ];
    const shimWrappers = [
      "milady_llama_model_load_from_file",
      "milady_llama_init_from_model",
      "milady_llama_sampler_chain_init",
    ];
    const shimSetters = [
      // model_params: the five user-overridable fields per llama.h b4500.
      "milady_llama_model_params_set_n_gpu_layers",
      "milady_llama_model_params_set_use_mmap",
      "milady_llama_model_params_set_use_mlock",
      "milady_llama_model_params_set_vocab_only",
      "milady_llama_model_params_set_check_tensors",
      // context_params: the runtime-tunable fields the adapter is likely
      // to override.
      "milady_llama_context_params_set_n_ctx",
      "milady_llama_context_params_set_n_batch",
      "milady_llama_context_params_set_n_ubatch",
      "milady_llama_context_params_set_n_threads",
      "milady_llama_context_params_set_n_threads_batch",
      "milady_llama_context_params_set_embeddings",
      "milady_llama_context_params_set_offload_kqv",
      "milady_llama_context_params_set_flash_attn",
      "milady_llama_context_params_set_pooling_type",
      // sampler_chain_params: only one field upstream (no_perf).
      "milady_llama_sampler_chain_params_set_no_perf",
    ];
    for (const sym of [
      ...shimDefaultsAndFrees,
      ...shimWrappers,
      ...shimSetters,
    ]) {
      expect(shimSymbols).toHaveProperty(sym);
    }

    vi.doUnmock("node:fs");
  });
});

describe("aosp-llama-adapter / shim integration with loadModel", () => {
  /**
   * Regression for the bun:ffi struct-by-value workaround: loadModel must
   * (1) materialize a model_params pointer via the shim,
   * (2) hand that exact pointer to milady_llama_model_load_from_file,
   * (3) free it via milady_llama_model_params_free after the load returns,
   * and the same for context_params. This proves no leak and no pointer
   * drift, which together prove the bun:ffi struct-by-value workaround
   * is wired correctly.
   *
   * We replace the bun:ffi mock with a pair of recording symbol stubs.
   */
  it("calls model/context params default + load + free in order", async () => {
    process.env.MILADY_LOCAL_LLAMA = "1";

    const callLog: string[] = [];
    // Synthetic pointers: 1=model-params, 2=model handle, 3=ctx-params,
    // 4=ctx handle.
    const llamaSymbols: Record<string, (...args: unknown[]) => unknown> = {
      llama_backend_init: () => {
        callLog.push("llama_backend_init");
        return 0;
      },
      llama_model_get_vocab: () => 100,
      llama_n_ctx: () => 4096,
    };
    const shimSymbols: Record<string, (...args: unknown[]) => unknown> = {
      milady_llama_model_params_default: () => {
        callLog.push("model_params_default");
        return 1;
      },
      milady_llama_model_load_from_file: (_path: unknown, params: unknown) => {
        callLog.push(`load_from_file(params=${params})`);
        return 2;
      },
      milady_llama_model_params_free: (params: unknown) => {
        callLog.push(`model_params_free(${params})`);
      },
      milady_llama_context_params_default: () => {
        callLog.push("context_params_default");
        return 3;
      },
      milady_llama_init_from_model: (_model: unknown, params: unknown) => {
        callLog.push(`init_from_model(params=${params})`);
        return 4;
      },
      milady_llama_context_params_free: (params: unknown) => {
        callLog.push(`context_params_free(${params})`);
      },
    };

    vi.doMock("node:fs", () => ({
      existsSync: () => true,
    }));

    vi.doMock("bun:ffi", () => ({
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
      dlopen: (libPath: string) => {
        const isShim = libPath.endsWith("libmilady-llama-shim.so");
        const table = isShim ? shimSymbols : llamaSymbols;
        const symbols = new Proxy(table, {
          get: (target: typeof table, prop: string) =>
            prop in target ? target[prop] : (..._args: unknown[]) => 0,
        });
        return { symbols, close() {} };
      },
      ptr: () => 0,
      CString: class {},
      read: { cstring: () => "" },
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
    const loader = services.get("localInferenceLoader") as {
      loadModel: (a: { modelPath: string }) => Promise<void>;
    };
    await loader.loadModel({ modelPath: "/tmp/fake.gguf" });

    // Order assertion: defaults() before wrapper, free() after — this is
    // the leak guard.
    const idxModelDefault = callLog.indexOf("model_params_default");
    const idxLoad = callLog.findIndex((c) => c.startsWith("load_from_file"));
    const idxModelFree = callLog.findIndex((c) =>
      c.startsWith("model_params_free"),
    );
    const idxCtxDefault = callLog.indexOf("context_params_default");
    const idxInit = callLog.findIndex((c) => c.startsWith("init_from_model"));
    const idxCtxFree = callLog.findIndex((c) =>
      c.startsWith("context_params_free"),
    );

    expect(idxModelDefault).toBeGreaterThanOrEqual(0);
    expect(idxLoad).toBeGreaterThan(idxModelDefault);
    expect(idxModelFree).toBeGreaterThan(idxLoad);
    expect(idxCtxDefault).toBeGreaterThan(idxModelFree);
    expect(idxInit).toBeGreaterThan(idxCtxDefault);
    expect(idxCtxFree).toBeGreaterThan(idxInit);

    // The pointer returned from default() must be the EXACT one passed
    // to load/init AND to free() — proves no double-malloc, no drift.
    expect(callLog).toContain("load_from_file(params=1)");
    expect(callLog).toContain("model_params_free(1)");
    expect(callLog).toContain("init_from_model(params=3)");
    expect(callLog).toContain("context_params_free(3)");

    vi.doUnmock("node:fs");
    vi.doUnmock("bun:ffi");
  });
});
