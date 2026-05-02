/**
 * Unit tests for the AOSP llama.cpp FFI adapter. The full inference loop
 * requires a real `libllama.so` + `libeliza-llama-shim.so` and is
 * exercised by integration tests on a real AOSP build. Here we cover:
 *
 *   1. Env gating — non-AOSP processes are no-ops.
 *   2. Library path resolution per ABI (libllama.so + shim).
 *   3. Failure modes when the .so is missing while the user opted in.
 *   4. The dlopen symbol manifests match the post-b4500 llama.h surface
 *      (sampler chain + embedding helpers) AND the
 *      libeliza-llama-shim.so surface (struct-by-value workaround,
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
  it("returns false when ELIZA_LOCAL_LLAMA is unset", async () => {
    delete process.env.ELIZA_LOCAL_LLAMA;
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
  }, 300_000);

  it("returns false when registerService is missing", async () => {
    process.env.ELIZA_LOCAL_LLAMA = "1";
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
      "/data/data/app/agent/arm64-v8a/libeliza-llama-shim.so",
    );
    expect(resolveLlamaShimPath("x64", "/data/data/app/agent")).toBe(
      "/data/data/app/agent/x86_64/libeliza-llama-shim.so",
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
  it("logs and returns false when ELIZA_LOCAL_LLAMA=1 but the .so is absent", async () => {
    process.env.ELIZA_LOCAL_LLAMA = "1";
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
  it("dlopens libllama.so first then libeliza-llama-shim.so with the right symbol manifests", async () => {
    process.env.ELIZA_LOCAL_LLAMA = "1";

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
    // global namespace), then libeliza-llama-shim.so (NEEDED libllama.so).
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
    expect(secondCall?.[0]).toMatch(/libeliza-llama-shim\.so$/);

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
    // through libeliza-llama-shim.so, NOT directly here. If a future
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

    // libeliza-llama-shim.so: pointer-style wrappers around the
    // struct-by-value entry points + per-field setters. Each *_default()
    // returns a malloc'd pointer; *_free() releases it; setters mutate
    // fields before the pointer is handed to the load/init/chain-init
    // wrapper.
    const shimDefaultsAndFrees = [
      "eliza_llama_model_params_default",
      "eliza_llama_model_params_free",
      "eliza_llama_context_params_default",
      "eliza_llama_context_params_free",
      "eliza_llama_sampler_chain_params_default",
      "eliza_llama_sampler_chain_params_free",
    ];
    const shimWrappers = [
      "eliza_llama_model_load_from_file",
      "eliza_llama_init_from_model",
      "eliza_llama_sampler_chain_init",
    ];
    const shimSetters = [
      // model_params: only n_gpu_layers is wired today (when LoadOptions
      // explicitly opts out of GPU we set it to 0). The other model_params
      // fields the shim could expose — use_mmap, use_mlock, vocab_only,
      // check_tensors — are intentionally left at llama.cpp's canonical
      // defaults (use_mmap=true, the rest false), which are correct for
      // the AOSP CPU path.
      "eliza_llama_model_params_set_n_gpu_layers",
      // context_params: the fields loadModel actually overrides.
      // n_ctx caps the context window so we don't OOM on phones.
      // n_batch / n_ubatch bound decode graph size so long prompts are
      // chunked without allocating the entire context window at once.
      // n_threads / n_threads_batch are bound to LoadOptions.maxThreads
      // (verified on context_params, NOT model_params, against b4500
      // llama.h:319-320). embeddings=true pre-allocates the buffer so
      // the first embed() call doesn't pay an allocation tax.
      // pooling_type=MEAN gives llama_get_embeddings_seq exactly n_embd
      // floats and removes the OOB-risk fallback.
      "eliza_llama_context_params_set_n_ctx",
      "eliza_llama_context_params_set_n_batch",
      "eliza_llama_context_params_set_n_ubatch",
      "eliza_llama_context_params_set_n_threads",
      "eliza_llama_context_params_set_n_threads_batch",
      "eliza_llama_context_params_set_embeddings",
      "eliza_llama_context_params_set_pooling_type",
      // type_k / type_v drive the apothic/llama.cpp-1bit-turboquant fork's
      // KV-cache compression path. TBQ3_0 (43) / TBQ4_0 (44) are the
      // fork's quant types; F16 (1) is the upstream default.
      "eliza_llama_context_params_set_type_k",
      "eliza_llama_context_params_set_type_v",
    ];
    for (const sym of [
      ...shimDefaultsAndFrees,
      ...shimWrappers,
      ...shimSetters,
    ]) {
      expect(shimSymbols).toHaveProperty(sym);
    }

    // Setters NOT bound — speculative bindings get dlsym'd at dlopen time
    // and silently widen the surface a future refactor might rely on.
    // If a future LoadOptions field needs one of these, add the binding
    // and add it to `shimSetters` above.
    const shimSettersThatMustNotBeHere = [
      "eliza_llama_model_params_set_use_mmap",
      "eliza_llama_model_params_set_use_mlock",
      "eliza_llama_model_params_set_vocab_only",
      "eliza_llama_model_params_set_check_tensors",
      "eliza_llama_context_params_set_offload_kqv",
      // set_flash_attn is gone from the shim entirely (b8198 changed
      // flash_attn to flash_attn_type, an enum, not a bool).
      "eliza_llama_context_params_set_flash_attn",
      "eliza_llama_sampler_chain_params_set_no_perf",
    ];
    for (const sym of shimSettersThatMustNotBeHere) {
      expect(shimSymbols).not.toHaveProperty(sym);
    }

    vi.doUnmock("node:fs");
  });
});

describe("aosp-llama-adapter / context_params override invocations", () => {
  /**
   * Regression for the F1 fix: AOSP must pin pooling_type=MEAN, n_ctx,
   * n_threads, n_threads_batch, and embeddings=true on the context_params
   * pointer BEFORE handing it to eliza_llama_init_from_model. Without
   * these the adapter ran at upstream defaults — under-using phone CPU
   * cores and leaving embeddings to read from a NONE-pooled buffer
   * (read-OOB risk).
   */
  it("calls the wired context_params setters before init_from_model", async () => {
    process.env.ELIZA_LOCAL_LLAMA = "1";

    const setterCalls: { name: string; args: unknown[] }[] = [];
    const initOrder: string[] = [];

    const llamaSymbols: Record<string, (...args: unknown[]) => unknown> = {
      llama_backend_init: () => 0,
      llama_model_get_vocab: () => 100,
      llama_n_ctx: () => 4096,
    };
    const shimSymbols: Record<string, (...args: unknown[]) => unknown> = {
      eliza_llama_model_params_default: () => 1,
      eliza_llama_model_load_from_file: () => 2,
      eliza_llama_model_params_free: () => undefined,
      eliza_llama_context_params_default: () => {
        initOrder.push("ctx_params_default");
        return 3;
      },
      eliza_llama_context_params_set_n_ctx: (...args: unknown[]) => {
        setterCalls.push({ name: "set_n_ctx", args });
        initOrder.push("set_n_ctx");
      },
      eliza_llama_context_params_set_n_batch: (...args: unknown[]) => {
        setterCalls.push({ name: "set_n_batch", args });
        initOrder.push("set_n_batch");
      },
      eliza_llama_context_params_set_n_ubatch: (...args: unknown[]) => {
        setterCalls.push({ name: "set_n_ubatch", args });
        initOrder.push("set_n_ubatch");
      },
      eliza_llama_context_params_set_n_threads: (...args: unknown[]) => {
        setterCalls.push({ name: "set_n_threads", args });
        initOrder.push("set_n_threads");
      },
      eliza_llama_context_params_set_n_threads_batch: (...args: unknown[]) => {
        setterCalls.push({ name: "set_n_threads_batch", args });
        initOrder.push("set_n_threads_batch");
      },
      eliza_llama_context_params_set_embeddings: (...args: unknown[]) => {
        setterCalls.push({ name: "set_embeddings", args });
        initOrder.push("set_embeddings");
      },
      eliza_llama_context_params_set_pooling_type: (...args: unknown[]) => {
        setterCalls.push({ name: "set_pooling_type", args });
        initOrder.push("set_pooling_type");
      },
      eliza_llama_init_from_model: () => {
        initOrder.push("init_from_model");
        return 4;
      },
      eliza_llama_context_params_free: () => {
        initOrder.push("ctx_params_free");
        return undefined;
      },
    };

    vi.doMock("node:fs", () => ({ existsSync: () => true }));
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
        const isShim = libPath.endsWith("libeliza-llama-shim.so");
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
    await mod.registerAospLlamaLoader(runtime);
    const loader = services.get("localInferenceLoader") as {
      loadModel: (a: { modelPath: string }) => Promise<void>;
    };
    await loader.loadModel({ modelPath: "/tmp/fake.gguf" });

    // pooling_type MEAN = 1 (LLAMA_POOLING_TYPE_MEAN per llama.h b4500).
    const poolingCall = setterCalls.find((c) => c.name === "set_pooling_type");
    expect(poolingCall).toBeDefined();
    expect(poolingCall?.args[1]).toBe(1);

    // n_ctx defaults to 8192 when LoadOptions doesn't override.
    const nCtxCall = setterCalls.find((c) => c.name === "set_n_ctx");
    expect(nCtxCall?.args[1]).toBe(8192);

    const nBatchCall = setterCalls.find((c) => c.name === "set_n_batch");
    expect(nBatchCall?.args[1]).toBe(2048);

    const nUBatchCall = setterCalls.find((c) => c.name === "set_n_ubatch");
    expect(nUBatchCall?.args[1]).toBe(512);

    // embeddings=true so the first embed() call doesn't pay alloc tax.
    const embeddingsCall = setterCalls.find((c) => c.name === "set_embeddings");
    expect(embeddingsCall?.args[1]).toBe(true);

    // All setters fire AFTER ctx_params_default and BEFORE init_from_model.
    const idxDefault = initOrder.indexOf("ctx_params_default");
    const idxInit = initOrder.indexOf("init_from_model");
    const idxFree = initOrder.indexOf("ctx_params_free");
    expect(idxDefault).toBeGreaterThanOrEqual(0);
    expect(idxInit).toBeGreaterThan(idxDefault);
    expect(idxFree).toBeGreaterThan(idxInit);

    const settersInOrder = initOrder.filter((step) => step.startsWith("set_"));
    for (const step of settersInOrder) {
      const i = initOrder.indexOf(step);
      expect(i).toBeGreaterThan(idxDefault);
      expect(i).toBeLessThan(idxInit);
    }

    vi.doUnmock("node:fs");
    vi.doUnmock("bun:ffi");
  });

  it("threads ELIZA_LLAMA_THREADS env into n_threads / n_threads_batch", async () => {
    process.env.ELIZA_LOCAL_LLAMA = "1";
    process.env.ELIZA_LLAMA_THREADS = "6";

    const captured: { name: string; args: unknown[] }[] = [];
    const llamaSymbols: Record<string, (...args: unknown[]) => unknown> = {
      llama_backend_init: () => 0,
      llama_model_get_vocab: () => 100,
      llama_n_ctx: () => 4096,
    };
    const shimSymbols: Record<string, (...args: unknown[]) => unknown> = {
      eliza_llama_model_params_default: () => 1,
      eliza_llama_model_load_from_file: () => 2,
      eliza_llama_model_params_free: () => undefined,
      eliza_llama_context_params_default: () => 3,
      eliza_llama_context_params_set_n_threads: (...args: unknown[]) => {
        captured.push({ name: "n_threads", args });
      },
      eliza_llama_context_params_set_n_threads_batch: (...args: unknown[]) => {
        captured.push({ name: "n_threads_batch", args });
      },
      eliza_llama_init_from_model: () => 4,
      eliza_llama_context_params_free: () => undefined,
    };

    vi.doMock("node:fs", () => ({ existsSync: () => true }));
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
        const isShim = libPath.endsWith("libeliza-llama-shim.so");
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
    await mod.registerAospLlamaLoader(runtime);
    const loader = services.get("localInferenceLoader") as {
      loadModel: (a: { modelPath: string }) => Promise<void>;
    };
    await loader.loadModel({ modelPath: "/tmp/fake.gguf" });

    const nThreads = captured.find((c) => c.name === "n_threads");
    const nThreadsBatch = captured.find((c) => c.name === "n_threads_batch");
    expect(nThreads?.args[1]).toBe(6);
    expect(nThreadsBatch?.args[1]).toBe(6);

    delete process.env.ELIZA_LLAMA_THREADS;
    vi.doUnmock("node:fs");
    vi.doUnmock("bun:ffi");
  });
});

describe("aosp-llama-adapter / embed pooling contract", () => {
  /**
   * Regression for F3: when llama_get_embeddings_seq returns NULL the
   * adapter must reject with a clear "pooling_type contract violated"
   * message rather than silently falling back to a per-token mean-pool
   * read that risks OOB on output-pruning models. Since loadModel pins
   * pooling_type=MEAN, a NULL return strictly indicates contract
   * violation (someone disabled pooling externally) and must surface.
   */
  it("rejects when llama_get_embeddings_seq returns NULL after decode", async () => {
    process.env.ELIZA_LOCAL_LLAMA = "1";

    const llamaSymbols: Record<string, (...args: unknown[]) => unknown> = {
      llama_backend_init: () => 0,
      llama_model_get_vocab: () => 100,
      llama_n_ctx: () => 4096,
      llama_model_n_embd: () => 384,
      llama_set_embeddings: () => undefined,
      llama_tokenize: (..._args: unknown[]) => {
        // Probe pass returns -required (negative). Real pass returns
        // `required` directly (we just need a positive number).
        return _args[4] === 0 ? -3 : 3;
      },
      // The contract violation: pooling was disabled externally and
      // get_embeddings_seq returns NULL (0 in bun:ffi pointer space).
      llama_get_embeddings_seq: () => 0,
    };
    const shimSymbols: Record<string, (...args: unknown[]) => unknown> = {
      eliza_llama_model_params_default: () => 1,
      eliza_llama_model_load_from_file: () => 2,
      eliza_llama_model_params_free: () => undefined,
      eliza_llama_context_params_default: () => 3,
      eliza_llama_init_from_model: () => 4,
      eliza_llama_context_params_free: () => undefined,
      eliza_llama_batch_get_one: () => 99,
      eliza_llama_batch_free: () => undefined,
      eliza_llama_decode: () => 0,
    };

    vi.doMock("node:fs", () => ({ existsSync: () => true }));
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
        const isShim = libPath.endsWith("libeliza-llama-shim.so");
        const table = isShim ? shimSymbols : llamaSymbols;
        const symbols = new Proxy(table, {
          get: (target: typeof table, prop: string) =>
            prop in target ? target[prop] : (..._args: unknown[]) => 0,
        });
        return { symbols, close() {} };
      },
      ptr: () => 0,
      toArrayBuffer: () => new ArrayBuffer(0),
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
    await mod.registerAospLlamaLoader(runtime);
    const loader = services.get("localInferenceLoader") as {
      loadModel: (a: { modelPath: string }) => Promise<void>;
      embed: (a: { input: string }) => Promise<unknown>;
    };
    await loader.loadModel({ modelPath: "/tmp/fake.gguf" });

    await expect(loader.embed({ input: "hello" })).rejects.toThrow(
      /pooling_type contract violated/,
    );

    vi.doUnmock("node:fs");
    vi.doUnmock("bun:ffi");
  });
});

describe("aosp-llama-adapter / shim integration with loadModel", () => {
  /**
   * Regression for the bun:ffi struct-by-value workaround: loadModel must
   * (1) materialize a model_params pointer via the shim,
   * (2) hand that exact pointer to eliza_llama_model_load_from_file,
   * (3) free it via eliza_llama_model_params_free after the load returns,
   * and the same for context_params. This proves no leak and no pointer
   * drift, which together prove the bun:ffi struct-by-value workaround
   * is wired correctly.
   *
   * We replace the bun:ffi mock with a pair of recording symbol stubs.
   */
  it("calls model/context params default + load + free in order", async () => {
    process.env.ELIZA_LOCAL_LLAMA = "1";

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
      eliza_llama_model_params_default: () => {
        callLog.push("model_params_default");
        return 1;
      },
      eliza_llama_model_load_from_file: (_path: unknown, params: unknown) => {
        callLog.push(`load_from_file(params=${params})`);
        return 2;
      },
      eliza_llama_model_params_free: (params: unknown) => {
        callLog.push(`model_params_free(${params})`);
      },
      eliza_llama_context_params_default: () => {
        callLog.push("context_params_default");
        return 3;
      },
      eliza_llama_init_from_model: (_model: unknown, params: unknown) => {
        callLog.push(`init_from_model(params=${params})`);
        return 4;
      },
      eliza_llama_context_params_free: (params: unknown) => {
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
        const isShim = libPath.endsWith("libeliza-llama-shim.so");
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

describe("aosp-llama-adapter / TBQ KV-cache wiring", () => {
  /**
   * Regression for the apothic/llama.cpp-1bit-turboquant integration. The
   * fork ships TBQ3_0 (43) / TBQ4_0 (44) ggml_type ids and the matching
   * Bonsai-8B-1bit GGUF is trained against them. The adapter MUST:
   *
   *   1. Auto-detect Bonsai by filename (any model basename that contains
   *      "bonsai" — case-insensitive).
   *   2. Forward the resolved enum values to eliza_llama_context_params_
   *      set_type_k / set_type_v BEFORE init_from_model.
   *   3. Honour explicit LoadOptions.kvCacheType overrides.
   *   4. Honour ELIZA_LLAMA_CACHE_TYPE_K / _V env overrides.
   *   5. Skip the setters entirely for non-Bonsai models with no override —
   *      that keeps the fp16 default which is the safe choice for any
   *      stock GGUF.
   */

  it("kvCacheTypeNameToEnum maps the documented names to ggml_type ids", async () => {
    const { kvCacheTypeNameToEnum } = await import("./aosp-llama-adapter");
    expect(kvCacheTypeNameToEnum("f16")).toBe(1);
    expect(kvCacheTypeNameToEnum("tbq3_0")).toBe(43);
    expect(kvCacheTypeNameToEnum("tbq4_0")).toBe(44);
  });

  it("looksLikeBonsai matches the canonical filename and rename variants", async () => {
    const { looksLikeBonsai } = await import("./aosp-llama-adapter");
    expect(looksLikeBonsai("/data/agent/models/Bonsai-8B.gguf")).toBe(true);
    expect(looksLikeBonsai("bonsai-8b-1bit.gguf")).toBe(true);
    expect(looksLikeBonsai("BONSAI.GGUF")).toBe(true);
    expect(looksLikeBonsai("Llama-3-8B-Q4_K_M.gguf")).toBe(false);
    expect(looksLikeBonsai("Hermes-3-Llama.gguf")).toBe(false);
  });

  it("resolveKvCacheType auto-picks tbq4_0/tbq3_0 for Bonsai filenames", async () => {
    const { resolveKvCacheType } = await import("./aosp-llama-adapter");
    expect(
      resolveKvCacheType("/tmp/models/Bonsai-8B.gguf", undefined, {}),
    ).toEqual({ k: "tbq4_0", v: "tbq3_0" });
  });

  it("resolveKvCacheType returns undefined for non-Bonsai with no overrides", async () => {
    const { resolveKvCacheType } = await import("./aosp-llama-adapter");
    expect(
      resolveKvCacheType("/tmp/models/Llama-3-8B.gguf", undefined, {}),
    ).toBeUndefined();
  });

  it("resolveKvCacheType honours explicit LoadOptions overrides over auto-detect", async () => {
    const { resolveKvCacheType } = await import("./aosp-llama-adapter");
    expect(
      resolveKvCacheType(
        "/tmp/models/Bonsai-8B.gguf",
        { k: "f16", v: "f16" },
        {},
      ),
    ).toEqual({ k: "f16", v: "f16" });
  });

  it("resolveKvCacheType honours env overrides over auto-detect", async () => {
    const { resolveKvCacheType } = await import("./aosp-llama-adapter");
    expect(
      resolveKvCacheType("/tmp/models/Bonsai-8B.gguf", undefined, {
        ELIZA_LLAMA_CACHE_TYPE_K: "f16",
        ELIZA_LLAMA_CACHE_TYPE_V: "tbq4_0",
      }),
    ).toEqual({ k: "f16", v: "tbq4_0" });
  });

  it("resolveKvCacheType lets explicit LoadOptions trump env overrides", async () => {
    const { resolveKvCacheType } = await import("./aosp-llama-adapter");
    expect(
      resolveKvCacheType(
        "/tmp/models/Bonsai-8B.gguf",
        { k: "tbq3_0" },
        { ELIZA_LLAMA_CACHE_TYPE_K: "f16" },
      ),
    ).toEqual({ k: "tbq3_0", v: "tbq3_0" });
  });

  it("resolveKvCacheType ignores unrecognised env values rather than throwing", async () => {
    const { resolveKvCacheType } = await import("./aosp-llama-adapter");
    expect(
      resolveKvCacheType("/tmp/models/Llama-3-8B.gguf", undefined, {
        ELIZA_LLAMA_CACHE_TYPE_K: "garbage",
      }),
    ).toBeUndefined();
  });

  it("forwards tbq4_0/tbq3_0 to set_type_k/set_type_v before init_from_model on Bonsai loads", async () => {
    process.env.ELIZA_LOCAL_LLAMA = "1";
    delete process.env.ELIZA_LLAMA_CACHE_TYPE_K;
    delete process.env.ELIZA_LLAMA_CACHE_TYPE_V;

    const setterCalls: { name: string; args: unknown[] }[] = [];
    const initOrder: string[] = [];

    const llamaSymbols: Record<string, (...args: unknown[]) => unknown> = {
      llama_backend_init: () => 0,
      llama_model_get_vocab: () => 100,
      llama_n_ctx: () => 4096,
    };
    const shimSymbols: Record<string, (...args: unknown[]) => unknown> = {
      eliza_llama_model_params_default: () => 1,
      eliza_llama_model_load_from_file: () => 2,
      eliza_llama_model_params_free: () => undefined,
      eliza_llama_context_params_default: () => 3,
      eliza_llama_context_params_set_type_k: (...args: unknown[]) => {
        setterCalls.push({ name: "set_type_k", args });
        initOrder.push("set_type_k");
      },
      eliza_llama_context_params_set_type_v: (...args: unknown[]) => {
        setterCalls.push({ name: "set_type_v", args });
        initOrder.push("set_type_v");
      },
      eliza_llama_init_from_model: () => {
        initOrder.push("init_from_model");
        return 4;
      },
      eliza_llama_context_params_free: () => undefined,
    };

    vi.doMock("node:fs", () => ({ existsSync: () => true }));
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
        const isShim = libPath.endsWith("libeliza-llama-shim.so");
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
    await mod.registerAospLlamaLoader(runtime);
    const loader = services.get("localInferenceLoader") as {
      loadModel: (a: { modelPath: string }) => Promise<void>;
    };
    await loader.loadModel({ modelPath: "/tmp/models/Bonsai-8B.gguf" });

    // tbq4_0 = 44, tbq3_0 = 43 — verified against
    //   ~/.cache/eliza-android-agent/llama-cpp-main-b8198-b2b5273/
    //     ggml/include/ggml.h:434
    const k = setterCalls.find((c) => c.name === "set_type_k");
    const v = setterCalls.find((c) => c.name === "set_type_v");
    expect(k?.args[1]).toBe(44);
    expect(v?.args[1]).toBe(43);

    // Both setters fire BEFORE init_from_model.
    expect(initOrder.indexOf("set_type_k")).toBeGreaterThanOrEqual(0);
    expect(initOrder.indexOf("set_type_v")).toBeGreaterThanOrEqual(0);
    expect(initOrder.indexOf("init_from_model")).toBeGreaterThan(
      initOrder.indexOf("set_type_k"),
    );
    expect(initOrder.indexOf("init_from_model")).toBeGreaterThan(
      initOrder.indexOf("set_type_v"),
    );

    vi.doUnmock("node:fs");
    vi.doUnmock("bun:ffi");
  });

  it("does NOT call set_type_k/set_type_v on non-Bonsai loads with no override", async () => {
    process.env.ELIZA_LOCAL_LLAMA = "1";
    delete process.env.ELIZA_LLAMA_CACHE_TYPE_K;
    delete process.env.ELIZA_LLAMA_CACHE_TYPE_V;

    let setTypeKCalled = false;
    let setTypeVCalled = false;

    const llamaSymbols: Record<string, (...args: unknown[]) => unknown> = {
      llama_backend_init: () => 0,
      llama_model_get_vocab: () => 100,
      llama_n_ctx: () => 4096,
    };
    const shimSymbols: Record<string, (...args: unknown[]) => unknown> = {
      eliza_llama_model_params_default: () => 1,
      eliza_llama_model_load_from_file: () => 2,
      eliza_llama_model_params_free: () => undefined,
      eliza_llama_context_params_default: () => 3,
      eliza_llama_context_params_set_type_k: () => {
        setTypeKCalled = true;
      },
      eliza_llama_context_params_set_type_v: () => {
        setTypeVCalled = true;
      },
      eliza_llama_init_from_model: () => 4,
      eliza_llama_context_params_free: () => undefined,
    };

    vi.doMock("node:fs", () => ({ existsSync: () => true }));
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
        const isShim = libPath.endsWith("libeliza-llama-shim.so");
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
    await mod.registerAospLlamaLoader(runtime);
    const loader = services.get("localInferenceLoader") as {
      loadModel: (a: { modelPath: string }) => Promise<void>;
    };
    await loader.loadModel({ modelPath: "/tmp/models/Llama-3-8B.gguf" });

    expect(setTypeKCalled).toBe(false);
    expect(setTypeVCalled).toBe(false);

    vi.doUnmock("node:fs");
    vi.doUnmock("bun:ffi");
  });
});

describe("aosp-llama-adapter / embeddings flag reset", () => {
  /**
   * Regression for the cuttlefish chat assert: llama.cpp's `llama_decode`
   * rejects token-only batches when the context is in embedding mode with
   *   GGML_ASSERT((!batch_inp.token && batch_inp.embd) ||
   *               (batch_inp.token && !batch_inp.embd))
   * The single-context adapter shares one ctx between generate() and
   * embed(), so a prior embed() call leaves the flag on and the next
   * generate() call asserts inside libllama.so. Both decode paths must
   * therefore set the flag explicitly before their first llama_decode —
   * generate() to FALSE, embed() to TRUE — so cross-mode bleed cannot
   * crash the bun process.
   */
  function buildBunFfiMock(
    llamaSymbols: Record<string, (...args: unknown[]) => unknown>,
    shimSymbols: Record<string, (...args: unknown[]) => unknown>,
  ): Record<string, unknown> {
    return {
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
        const isShim = libPath.endsWith("libeliza-llama-shim.so");
        const table = isShim ? shimSymbols : llamaSymbols;
        const symbols = new Proxy(table, {
          get: (target: typeof table, prop: string) =>
            prop in target ? target[prop] : (..._args: unknown[]) => 0,
        });
        return { symbols, close() {} };
      },
      ptr: () => 0,
      toArrayBuffer: () => new Float32Array([0.1, 0.2, 0.3]).buffer,
      CString: class {},
      read: { cstring: () => "" },
    };
  }

  it("generate() sets embeddings=false before the first llama_decode", async () => {
    process.env.ELIZA_LOCAL_LLAMA = "1";

    const callOrder: string[] = [];
    const setEmbeddingsCalls: { value: unknown }[] = [];

    const llamaSymbols: Record<string, (...args: unknown[]) => unknown> = {
      llama_backend_init: () => 0,
      llama_model_get_vocab: () => 100,
      llama_n_ctx: () => 4096,
      llama_set_embeddings: (...args: unknown[]) => {
        setEmbeddingsCalls.push({ value: args[1] });
        callOrder.push(`set_embeddings(${args[1]})`);
      },
      llama_tokenize: (..._args: unknown[]) => (_args[4] === 0 ? -3 : 3), // negative on probe, positive on fill
      // Force the EOG path on the first sampled token so we don't loop.
      llama_sampler_sample: () => 999,
      llama_vocab_is_eog: () => true,
      llama_sampler_accept: () => undefined,
      llama_sampler_chain_add: () => undefined,
      llama_sampler_init_temp: () => 1,
      llama_sampler_init_top_p: () => 2,
      llama_sampler_init_dist: () => 3,
      llama_sampler_init_greedy: () => 4,
      llama_sampler_free: () => undefined,
      llama_token_to_piece: () => 0,
    };
    const shimSymbols: Record<string, (...args: unknown[]) => unknown> = {
      eliza_llama_model_params_default: () => 1,
      eliza_llama_model_load_from_file: () => 2,
      eliza_llama_model_params_free: () => undefined,
      eliza_llama_context_params_default: () => 3,
      eliza_llama_init_from_model: () => 4,
      eliza_llama_context_params_free: () => undefined,
      eliza_llama_sampler_chain_params_default: () => 5,
      eliza_llama_sampler_chain_params_free: () => undefined,
      eliza_llama_sampler_chain_init: () => 6,
      eliza_llama_batch_get_one: () => 99,
      eliza_llama_batch_free: () => undefined,
      eliza_llama_decode: () => {
        callOrder.push("llama_decode");
        return 0;
      },
    };

    vi.doMock("node:fs", () => ({ existsSync: () => true }));
    vi.doMock("bun:ffi", () => buildBunFfiMock(llamaSymbols, shimSymbols));

    const mod = await import("./aosp-llama-adapter");
    mod.__resetForTests();
    const services = new Map<string, unknown>();
    const runtime = {
      registerService(name: string, impl: unknown) {
        services.set(name, impl);
      },
    };
    await mod.registerAospLlamaLoader(runtime);
    const loader = services.get("localInferenceLoader") as {
      loadModel: (a: { modelPath: string }) => Promise<void>;
      generate: (a: { prompt: string; maxTokens?: number }) => Promise<string>;
    };
    await loader.loadModel({ modelPath: "/tmp/fake.gguf" });
    await loader.generate({ prompt: "hi", maxTokens: 1 });

    // The generate() path must call set_embeddings(false) at least once
    // BEFORE the first llama_decode. bun:ffi marshals a JS `false` to the
    // C `bool` ABI as 0; either form is acceptable here as long as the
    // flag is unambiguously OFF.
    const firstDecodeIdx = callOrder.indexOf("llama_decode");
    expect(firstDecodeIdx).toBeGreaterThanOrEqual(0);
    const flagOffBeforeDecode = callOrder
      .slice(0, firstDecodeIdx)
      .some((step) => step === "set_embeddings(false)");
    expect(flagOffBeforeDecode).toBe(true);
    expect(
      setEmbeddingsCalls.some((c) => c.value === false || c.value === 0),
    ).toBe(true);

    vi.doUnmock("node:fs");
    vi.doUnmock("bun:ffi");
  });

  it("embed() sets embeddings=true before the embed llama_decode and resets to false in finally", async () => {
    process.env.ELIZA_LOCAL_LLAMA = "1";

    const callOrder: string[] = [];

    const llamaSymbols: Record<string, (...args: unknown[]) => unknown> = {
      llama_backend_init: () => 0,
      llama_model_get_vocab: () => 100,
      llama_n_ctx: () => 4096,
      llama_model_n_embd: () => 3,
      llama_set_embeddings: (...args: unknown[]) => {
        callOrder.push(`set_embeddings(${args[1]})`);
      },
      llama_tokenize: (..._args: unknown[]) => (_args[4] === 0 ? -3 : 3),
      llama_get_embeddings_seq: () => 1, // non-NULL
    };
    const shimSymbols: Record<string, (...args: unknown[]) => unknown> = {
      eliza_llama_model_params_default: () => 1,
      eliza_llama_model_load_from_file: () => 2,
      eliza_llama_model_params_free: () => undefined,
      eliza_llama_context_params_default: () => 3,
      eliza_llama_init_from_model: () => 4,
      eliza_llama_context_params_free: () => undefined,
      eliza_llama_batch_get_one: () => 99,
      eliza_llama_batch_free: () => undefined,
      eliza_llama_decode: () => {
        callOrder.push("llama_decode");
        return 0;
      },
    };

    vi.doMock("node:fs", () => ({ existsSync: () => true }));
    vi.doMock("bun:ffi", () => buildBunFfiMock(llamaSymbols, shimSymbols));

    const mod = await import("./aosp-llama-adapter");
    mod.__resetForTests();
    const services = new Map<string, unknown>();
    const runtime = {
      registerService(name: string, impl: unknown) {
        services.set(name, impl);
      },
    };
    await mod.registerAospLlamaLoader(runtime);
    const loader = services.get("localInferenceLoader") as {
      loadModel: (a: { modelPath: string }) => Promise<void>;
      embed: (a: { input: string }) => Promise<{
        embedding: number[];
        tokens: number;
      }>;
    };
    await loader.loadModel({ modelPath: "/tmp/fake.gguf" });
    await loader.embed({ input: "hello" });

    // embed() must call set_embeddings(true) BEFORE its llama_decode and
    // then restore set_embeddings(false) in the finally block so the next
    // generate() call doesn't inherit embeddings mode from this call.
    const decodeIdx = callOrder.indexOf("llama_decode");
    const trueBeforeDecodeIdx = callOrder.indexOf("set_embeddings(true)");
    const falseAfterDecodeIdx = callOrder.lastIndexOf("set_embeddings(false)");
    expect(decodeIdx).toBeGreaterThanOrEqual(0);
    expect(trueBeforeDecodeIdx).toBeGreaterThanOrEqual(0);
    expect(trueBeforeDecodeIdx).toBeLessThan(decodeIdx);
    expect(falseAfterDecodeIdx).toBeGreaterThan(decodeIdx);

    vi.doUnmock("node:fs");
    vi.doUnmock("bun:ffi");
  });
});
