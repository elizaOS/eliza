/**
 * elizaOS Rust WASM Runtime for React
 *
 * This module provides the Rust WASM-powered AgentRuntime with:
 * - Classic ELIZA pattern matching (no LLM required)
 * - LocalDB storage via localStorage
 *
 * The Rust runtime handles all message processing in WebAssembly while
 * delegating model inference to JavaScript (where we use plugin-eliza-classic).
 */

import type { IDatabaseAdapter } from "@elizaos/core";
import {
  generateElizaResponse,
  getElizaGreeting,
} from "@elizaos/plugin-eliza-classic";
import { createDatabaseAdapter } from "@elizaos/plugin-localdb";
import { v4 as uuidv4 } from "uuid";

// ============================================================================
// Types
// ============================================================================

export interface ElizaRuntimeState {
  isInitialized: boolean;
  isInitializing: boolean;
  error: Error | null;
}

export interface ChatMessage {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: Date;
}

interface WasmExports {
  WasmAgentRuntime: WasmAgentRuntimeClass;
  stringToUuid: (input: string) => string;
  generateUUID: () => string;
  getVersion: () => string;
  init_wasm: () => void;
}

interface WasmAgentRuntimeClass {
  create(characterJson: string): WasmAgentRuntime;
}

interface WasmAgentRuntime {
  initialize(): void;
  registerModelHandler(
    modelType: string,
    handler: (paramsJson: string) => Promise<string>,
  ): void;
  handleMessage(messageJson: string): Promise<string>;
  stop(): void;
  readonly agentId: string;
  readonly characterName: string;
  readonly character: string;
  free(): void;
}

// ============================================================================
// WASM Loading
// ============================================================================

let wasmModule: WasmExports | null = null;
let wasmInitPromise: Promise<WasmExports> | null = null;

/**
 * Load the Rust WASM module
 */
async function loadWasmModule(): Promise<WasmExports> {
  if (wasmModule) {
    return wasmModule;
  }

  if (wasmInitPromise) {
    return wasmInitPromise;
  }

  wasmInitPromise = (async () => {
    console.log("[elizaOS] Loading Rust WASM module...");

    // Fetch the WASM file
    const wasmResponse = await fetch("/wasm/elizaos_bg.wasm");
    if (!wasmResponse.ok) {
      throw new Error(
        `Failed to load elizaos_bg.wasm: ${wasmResponse.status} ${wasmResponse.statusText}`,
      );
    }

    const wasmBuffer = await wasmResponse.arrayBuffer();

    // Create the imports object that the WASM module expects
    const imports: WebAssembly.Imports = {
      __wbindgen_placeholder__: {},
    };

    // Text encoder/decoder for string handling
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder("utf-8", {
      ignoreBOM: true,
      fatal: true,
    });

    let wasmMemory: WebAssembly.Memory;
    let WASM_VECTOR_LEN = 0;
    let cachedUint8Array: Uint8Array | null = null;
    let cachedDataView: DataView | null = null;
    let externrefTable: WebAssembly.Table;

    function getUint8Memory(): Uint8Array {
      if (cachedUint8Array === null || cachedUint8Array.byteLength === 0) {
        cachedUint8Array = new Uint8Array(wasmMemory.buffer);
      }
      return cachedUint8Array;
    }

    function getDataViewMemory(): DataView {
      if (
        cachedDataView === null ||
        cachedDataView.buffer !== wasmMemory.buffer
      ) {
        cachedDataView = new DataView(wasmMemory.buffer);
      }
      return cachedDataView;
    }

    function passStringToWasm(
      arg: string,
      malloc: (size: number, align: number) => number,
      realloc?: (
        ptr: number,
        oldSize: number,
        newSize: number,
        align: number,
      ) => number,
    ): number {
      if (realloc === undefined) {
        const buf = textEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8Memory()
          .subarray(ptr, ptr + buf.length)
          .set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
      }

      let len = arg.length;
      let ptr = malloc(len, 1) >>> 0;
      const mem = getUint8Memory();
      let offset = 0;

      for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7f) break;
        mem[ptr + offset] = code;
      }

      if (offset !== len) {
        if (offset !== 0) {
          arg = arg.slice(offset);
        }
        const newLen = offset + arg.length * 3;
        ptr = realloc(ptr, len, newLen, 1) >>> 0;
        len = newLen;
        const view = getUint8Memory().subarray(ptr + offset, ptr + len);
        const ret = textEncoder.encodeInto(arg, view);
        offset += ret.written ?? 0;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
      }

      WASM_VECTOR_LEN = offset;
      return ptr;
    }

    function getStringFromWasm(ptr: number, len: number): string {
      ptr = ptr >>> 0;
      return textDecoder.decode(getUint8Memory().subarray(ptr, ptr + len));
    }

    function addToExternrefTable(obj: unknown): number {
      const idx = (wasm.__externref_table_alloc as () => number)();
      externrefTable.set(idx, obj);
      return idx;
    }

    function takeFromExternrefTable(idx: number): unknown {
      const value = externrefTable.get(idx);
      (wasm.__externref_table_dealloc as (idx: number) => void)(idx);
      return value;
    }

    function isLikeNone(x: unknown): x is null | undefined {
      return x === undefined || x === null;
    }

    function debugString(val: unknown): string {
      const type = typeof val;
      if (type === "number" || type === "boolean" || val == null) {
        return `${val}`;
      }
      if (type === "string") {
        return `"${val}"`;
      }
      if (type === "function") {
        const name = (val as { name?: string }).name;
        return typeof name === "string" && name.length > 0
          ? `Function(${name})`
          : "Function";
      }
      if (Array.isArray(val)) {
        return `[${val.map(debugString).join(", ")}]`;
      }
      if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
      }
      return `Object(${JSON.stringify(val)})`;
    }

    // Closure handling
    const CLOSURE_DTORS = new FinalizationRegistry(
      (state: {
        dtor: (a: number, b: number) => void;
        a: number;
        b: number;
      }) => {
        state.dtor(state.a, state.b);
      },
    );

    function makeMutClosure<T extends unknown[]>(
      arg0: number,
      arg1: number,
      dtor: (a: number, b: number) => void,
      f: (a: number, b: number, ...args: T) => unknown,
    ): ((...args: T) => unknown) & { _wbg_cb_unref: () => void } {
      const state = { a: arg0, b: arg1, cnt: 1, dtor };
      const real = ((...args: T) => {
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
          return f(a, state.b, ...args);
        } finally {
          state.a = a;
          (real as { _wbg_cb_unref: () => void })._wbg_cb_unref();
        }
      }) as ((...args: T) => unknown) & { _wbg_cb_unref: () => void };
      real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
          state.dtor(state.a, state.b);
          state.a = 0;
          CLOSURE_DTORS.unregister(state);
        }
      };
      CLOSURE_DTORS.register(real, state, state);
      return real;
    }

    // Placeholder for wasm exports - will be filled after instantiation
    let wasm: WebAssembly.Exports;

    // Set up imports
    const placeholder = imports.__wbindgen_placeholder__;

    placeholder.__wbg___wbindgen_debug_string_adfb662ae34724b6 = (
      arg0: number,
      arg1: unknown,
    ) => {
      const ret = debugString(arg1);
      const ptr1 = passStringToWasm(
        ret,
        wasm.__wbindgen_malloc as (a: number, b: number) => number,
        wasm.__wbindgen_realloc as (
          a: number,
          b: number,
          c: number,
          d: number,
        ) => number,
      );
      const len1 = WASM_VECTOR_LEN;
      getDataViewMemory().setInt32(arg0 + 4, len1, true);
      getDataViewMemory().setInt32(arg0, ptr1, true);
    };

    placeholder.__wbg___wbindgen_is_function_8d400b8b1af978cd = (
      arg0: unknown,
    ) => typeof arg0 === "function";

    placeholder.__wbg___wbindgen_is_undefined_f6b95eab589e0269 = (
      arg0: unknown,
    ) => arg0 === undefined;

    placeholder.__wbg___wbindgen_string_get_a2a31e16edf96e42 = (
      arg0: number,
      arg1: unknown,
    ) => {
      const obj = arg1;
      const ret = typeof obj === "string" ? obj : undefined;
      const ptr1 = isLikeNone(ret)
        ? 0
        : passStringToWasm(
            ret,
            wasm.__wbindgen_malloc as (a: number, b: number) => number,
            wasm.__wbindgen_realloc as (
              a: number,
              b: number,
              c: number,
              d: number,
            ) => number,
          );
      const len1 = WASM_VECTOR_LEN;
      getDataViewMemory().setInt32(arg0 + 4, len1, true);
      getDataViewMemory().setInt32(arg0, ptr1, true);
    };

    placeholder.__wbg___wbindgen_throw_dd24417ed36fc46e = (
      arg0: number,
      arg1: number,
    ) => {
      throw new Error(getStringFromWasm(arg0, arg1));
    };

    placeholder.__wbg__wbg_cb_unref_87dfb5aaa0cbcea7 = (arg0: {
      _wbg_cb_unref: () => void;
    }) => {
      arg0._wbg_cb_unref();
    };

    placeholder.__wbg_call_3020136f7a2d6e44 = (
      arg0: (this: unknown, arg: unknown) => unknown,
      arg1: unknown,
      arg2: unknown,
    ) => {
      try {
        return arg0.call(arg1, arg2);
      } catch (e) {
        const idx = addToExternrefTable(e);
        (wasm.__wbindgen_exn_store as (idx: number) => void)(idx);
        return undefined;
      }
    };

    placeholder.__wbg_call_abb4ff46ce38be40 = (
      arg0: (this: unknown) => unknown,
      arg1: unknown,
    ) => {
      try {
        return arg0.call(arg1);
      } catch (e) {
        const idx = addToExternrefTable(e);
        (wasm.__wbindgen_exn_store as (idx: number) => void)(idx);
        return undefined;
      }
    };

    placeholder.__wbg_error_7534b8e9a36f1ab4 = (arg0: number, arg1: number) => {
      console.error(getStringFromWasm(arg0, arg1));
      (
        wasm.__wbindgen_free as (
          ptr: number,
          len: number,
          align: number,
        ) => void
      )(arg0, arg1, 1);
    };

    placeholder.__wbg_getRandomValues_9b655bdd369112f2 = (
      arg0: number,
      arg1: number,
    ) => {
      try {
        globalThis.crypto.getRandomValues(
          getUint8Memory().subarray(arg0, arg0 + arg1),
        );
      } catch (e) {
        const idx = addToExternrefTable(e);
        (wasm.__wbindgen_exn_store as (idx: number) => void)(idx);
      }
    };

    placeholder.__wbg_instanceof_Promise_eca6c43a2610558d = (arg0: unknown) =>
      arg0 instanceof Promise;

    placeholder.__wbg_new_8a6f238a6ece86ea = () => new Error();

    placeholder.__wbg_new_ff12d2b041fb48f1 = (arg0: number, arg1: number) => {
      const state = { a: arg0, b: arg1 };
      const cb = (
        resolve: (value: unknown) => void,
        reject: (reason: unknown) => void,
      ) => {
        const a = state.a;
        state.a = 0;
        try {
          (
            wasm.wasm_bindgen__convert__closures_____invoke__h519f681884664509 as (
              a: number,
              b: number,
              c: unknown,
              d: unknown,
            ) => void
          )(a, state.b, resolve, reject);
        } finally {
          state.a = a;
        }
      };
      try {
        return new Promise(cb);
      } finally {
        state.a = state.b = 0;
      }
    };

    placeholder.__wbg_new_no_args_cb138f77cf6151ee = (
      arg0: number,
      arg1: number,
    ) => new Function(getStringFromWasm(arg0, arg1));

    placeholder.__wbg_now_69d776cd24f5215b = () => Date.now();

    placeholder.__wbg_queueMicrotask_9b549dfce8865860 = (arg0: {
      queueMicrotask: unknown;
    }) => arg0.queueMicrotask;

    placeholder.__wbg_queueMicrotask_fca69f5bfad613a5 = (arg0: () => void) => {
      queueMicrotask(arg0);
    };

    placeholder.__wbg_resolve_fd5bfbaa4ce36e1e = (arg0: unknown) =>
      Promise.resolve(arg0);

    placeholder.__wbg_stack_0ed75d68575b0f3c = (arg0: number, arg1: Error) => {
      const ret = arg1.stack;
      const ptr1 = passStringToWasm(
        ret ?? "",
        wasm.__wbindgen_malloc as (a: number, b: number) => number,
        wasm.__wbindgen_realloc as (
          a: number,
          b: number,
          c: number,
          d: number,
        ) => number,
      );
      const len1 = WASM_VECTOR_LEN;
      getDataViewMemory().setInt32(arg0 + 4, len1, true);
      getDataViewMemory().setInt32(arg0, ptr1, true);
    };

    placeholder.__wbg_static_accessor_GLOBAL_769e6b65d6557335 = () => {
      const ret = typeof global === "undefined" ? null : global;
      return isLikeNone(ret) ? 0 : addToExternrefTable(ret);
    };

    placeholder.__wbg_static_accessor_GLOBAL_THIS_60cf02db4de8e1c1 = () => {
      const ret = typeof globalThis === "undefined" ? null : globalThis;
      return isLikeNone(ret) ? 0 : addToExternrefTable(ret);
    };

    placeholder.__wbg_static_accessor_SELF_08f5a74c69739274 = () => {
      const ret = typeof self === "undefined" ? null : self;
      return isLikeNone(ret) ? 0 : addToExternrefTable(ret);
    };

    placeholder.__wbg_static_accessor_WINDOW_a8924b26aa92d024 = () => {
      const ret = typeof window === "undefined" ? null : window;
      return isLikeNone(ret) ? 0 : addToExternrefTable(ret);
    };

    placeholder.__wbg_then_429f7caf1026411d = (
      arg0: Promise<unknown>,
      arg1: (v: unknown) => unknown,
      arg2: (v: unknown) => unknown,
    ) => arg0.then(arg1, arg2);

    placeholder.__wbg_then_4f95312d68691235 = (
      arg0: Promise<unknown>,
      arg1: (v: unknown) => unknown,
    ) => arg0.then(arg1);

    placeholder.__wbindgen_cast_2241b6af4c4b2941 = (
      arg0: number,
      arg1: number,
    ) => getStringFromWasm(arg0, arg1);

    placeholder.__wbindgen_cast_3f4d5247b4ce7d6e = (
      arg0: number,
      arg1: number,
    ) =>
      makeMutClosure(
        arg0,
        arg1,
        wasm.wasm_bindgen__closure__destroy__h8c2572569b7537f4 as (
          a: number,
          b: number,
        ) => void,
        (a, b, c) =>
          (
            wasm.wasm_bindgen__convert__closures_____invoke__h7fe492829fe9dd04 as (
              a: number,
              b: number,
              c: unknown,
            ) => void
          )(a, b, c),
      );

    placeholder.__wbindgen_init_externref_table = () => {
      externrefTable = wasm.__wbindgen_externrefs as WebAssembly.Table;
      const offset = externrefTable.grow(4);
      externrefTable.set(0, undefined);
      externrefTable.set(offset + 0, undefined);
      externrefTable.set(offset + 1, null);
      externrefTable.set(offset + 2, true);
      externrefTable.set(offset + 3, false);
    };

    // Compile and instantiate the WASM module
    const wasmModuleCompiled = await WebAssembly.compile(wasmBuffer);
    const instance = await WebAssembly.instantiate(wasmModuleCompiled, imports);
    wasm = instance.exports;

    // Set up memory
    wasmMemory = wasm.memory as WebAssembly.Memory;

    // Call the start function to initialize
    (wasm.__wbindgen_start as () => void)();

    console.log("[elizaOS] Rust WASM module loaded successfully");

    // Create the JS wrapper API
    const api: WasmExports = {
      WasmAgentRuntime: {
        create(characterJson: string): WasmAgentRuntime {
          const ptr0 = passStringToWasm(
            characterJson,
            wasm.__wbindgen_malloc as (a: number, b: number) => number,
            wasm.__wbindgen_realloc as (
              a: number,
              b: number,
              c: number,
              d: number,
            ) => number,
          );
          const len0 = WASM_VECTOR_LEN;
          const ret = (
            wasm.wasmagentruntime_create as (
              ptr: number,
              len: number,
            ) => [number, number, number]
          )(ptr0, len0);
          if (ret[2]) {
            throw takeFromExternrefTable(ret[1]);
          }
          return createRuntimeWrapper(ret[0] >>> 0);
        },
      },
      stringToUuid(input: string): string {
        const ptr0 = passStringToWasm(
          input,
          wasm.__wbindgen_malloc as (a: number, b: number) => number,
          wasm.__wbindgen_realloc as (
            a: number,
            b: number,
            c: number,
            d: number,
          ) => number,
        );
        const len0 = WASM_VECTOR_LEN;
        const ret = (
          wasm.stringToUuid as (ptr: number, len: number) => [number, number]
        )(ptr0, len0);
        try {
          return getStringFromWasm(ret[0], ret[1]);
        } finally {
          (
            wasm.__wbindgen_free as (
              ptr: number,
              len: number,
              align: number,
            ) => void
          )(ret[0], ret[1], 1);
        }
      },
      generateUUID(): string {
        const ret = (wasm.generateUUID as () => [number, number])();
        try {
          return getStringFromWasm(ret[0], ret[1]);
        } finally {
          (
            wasm.__wbindgen_free as (
              ptr: number,
              len: number,
              align: number,
            ) => void
          )(ret[0], ret[1], 1);
        }
      },
      getVersion(): string {
        const ret = (wasm.getVersion as () => [number, number])();
        try {
          return getStringFromWasm(ret[0], ret[1]);
        } finally {
          (
            wasm.__wbindgen_free as (
              ptr: number,
              len: number,
              align: number,
            ) => void
          )(ret[0], ret[1], 1);
        }
      },
      init_wasm(): void {
        (wasm.init_wasm as () => void)();
      },
    };

    function createRuntimeWrapper(ptr: number): WasmAgentRuntime {
      return {
        initialize() {
          const ret = (
            wasm.wasmagentruntime_initialize as (
              ptr: number,
            ) => [number, number]
          )(ptr);
          if (ret[1]) {
            throw takeFromExternrefTable(ret[0]);
          }
        },
        registerModelHandler(
          modelType: string,
          handler: (paramsJson: string) => Promise<string>,
        ) {
          const ptr0 = passStringToWasm(
            modelType,
            wasm.__wbindgen_malloc as (a: number, b: number) => number,
            wasm.__wbindgen_realloc as (
              a: number,
              b: number,
              c: number,
              d: number,
            ) => number,
          );
          const len0 = WASM_VECTOR_LEN;
          (
            wasm.wasmagentruntime_registerModelHandler as (
              ptr: number,
              mptr: number,
              mlen: number,
              handler: unknown,
            ) => void
          )(ptr, ptr0, len0, handler);
        },
        handleMessage(messageJson: string): Promise<string> {
          const ptr0 = passStringToWasm(
            messageJson,
            wasm.__wbindgen_malloc as (a: number, b: number) => number,
            wasm.__wbindgen_realloc as (
              a: number,
              b: number,
              c: number,
              d: number,
            ) => number,
          );
          const len0 = WASM_VECTOR_LEN;
          return (
            wasm.wasmagentruntime_handleMessage as (
              ptr: number,
              mptr: number,
              mlen: number,
            ) => Promise<string>
          )(ptr, ptr0, len0);
        },
        stop() {
          (wasm.wasmagentruntime_stop as (ptr: number) => void)(ptr);
        },
        get agentId(): string {
          const ret = (
            wasm.wasmagentruntime_agentId as (ptr: number) => [number, number]
          )(ptr);
          try {
            return getStringFromWasm(ret[0], ret[1]);
          } finally {
            (
              wasm.__wbindgen_free as (
                ptr: number,
                len: number,
                align: number,
              ) => void
            )(ret[0], ret[1], 1);
          }
        },
        get characterName(): string {
          const ret = (
            wasm.wasmagentruntime_characterName as (
              ptr: number,
            ) => [number, number]
          )(ptr);
          try {
            return getStringFromWasm(ret[0], ret[1]);
          } finally {
            (
              wasm.__wbindgen_free as (
                ptr: number,
                len: number,
                align: number,
              ) => void
            )(ret[0], ret[1], 1);
          }
        },
        get character(): string {
          const ret = (
            wasm.wasmagentruntime_character as (
              ptr: number,
            ) => [number, number, number, number]
          )(ptr);
          if (ret[3]) {
            throw takeFromExternrefTable(ret[2]);
          }
          try {
            return getStringFromWasm(ret[0], ret[1]);
          } finally {
            (
              wasm.__wbindgen_free as (
                ptr: number,
                len: number,
                align: number,
              ) => void
            )(ret[0], ret[1], 1);
          }
        },
        free() {
          (
            wasm.__wbg_wasmagentruntime_free as (ptr: number, v: number) => void
          )(ptr, 0);
        },
      };
    }

    wasmModule = api;
    return api;
  })();

  return wasmInitPromise;
}

// ============================================================================
// ELIZA Character Configuration
// ============================================================================

const elizaCharacter = {
  name: "ELIZA",
  bio: "A Rogerian psychotherapist simulation based on Joseph Weizenbaum's 1966 program. I use pattern matching to engage in therapeutic conversations.",
  system: `You are ELIZA, a Rogerian psychotherapist simulation. Your role is to:
- Listen empathetically to the user
- Reflect their statements back to them
- Ask open-ended questions to encourage self-exploration
- Never give direct advice or diagnoses
- Focus on feelings and emotions`,
};

// ============================================================================
// Runtime Singleton
// ============================================================================

let runtimeInstance: WasmAgentRuntime | null = null;
let initializationPromise: Promise<WasmAgentRuntime> | null = null;

// Storage for conversation persistence
let dbAdapter: IDatabaseAdapter | null = null;

// Session identifiers
const userId = uuidv4();
const roomId = "eliza-chat-room";

/**
 * Get or create the Rust WASM AgentRuntime instance.
 * This is a singleton that is shared across the application.
 */
export async function getRuntime(): Promise<WasmAgentRuntime> {
  // Return existing instance if available
  if (runtimeInstance) {
    return runtimeInstance;
  }

  // Return existing initialization promise if in progress
  if (initializationPromise) {
    return initializationPromise;
  }

  // Start initialization
  initializationPromise = initializeRuntime();
  runtimeInstance = await initializationPromise;
  initializationPromise = null;
  return runtimeInstance;
}

/**
 * Initialize a new Rust WASM AgentRuntime with ELIZA classic pattern matching.
 */
async function initializeRuntime(): Promise<WasmAgentRuntime> {
  console.log("[elizaOS] Initializing Rust WASM AgentRuntime...");

  // Load the WASM module
  const wasm = await loadWasmModule();

  console.log(`[elizaOS] Rust WASM Core v${wasm.getVersion()}`);

  // Initialize LocalDB storage
  // In browser, createDatabaseAdapter expects { prefix?: string }
  // TypeScript resolves to node types expecting { dataDir?: string }
  const agentId = wasm.stringToUuid(
    elizaCharacter.name,
  ) as `${string}-${string}-${string}-${string}-${string}`;
  dbAdapter = createDatabaseAdapter(
    { prefix: "elizaos-wasm" } as { dataDir?: string },
    agentId,
  ) as unknown as IDatabaseAdapter;
  await dbAdapter?.init();

  console.log("[elizaOS] LocalDB storage initialized");

  // Create the runtime with the ELIZA character
  const runtime = wasm.WasmAgentRuntime.create(JSON.stringify(elizaCharacter));

  // Register the ELIZA classic pattern matching as the TEXT_LARGE model handler
  runtime.registerModelHandler(
    "TEXT_LARGE",
    async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson) as { prompt: string };
      // Extract user input from the prompt
      const userMatch = params.prompt.match(/User:\s*(.+?)(?:\n|$)/i);
      const userInput = userMatch ? userMatch[1].trim() : params.prompt;

      // Use the classic ELIZA pattern matching
      return generateElizaResponse(userInput);
    },
  );

  // Initialize the runtime
  runtime.initialize();

  console.log("[elizaOS] Rust WASM AgentRuntime initialized successfully");
  console.log(`[elizaOS] Agent ID: ${runtime.agentId}`);
  console.log(`[elizaOS] Character: ${runtime.characterName}`);

  return runtime;
}

/**
 * Send a message to ELIZA and get a response.
 *
 * This sends the message to the Rust WASM runtime, which processes it
 * and calls our JavaScript ELIZA pattern matching handler.
 *
 * @param text - The user's message
 * @returns The complete ELIZA response
 */
export async function sendMessage(text: string): Promise<string> {
  const runtime = await getRuntime();
  const wasm = await loadWasmModule();

  // Create the message in the format expected by the Rust runtime
  const messageId = wasm.generateUUID();
  const message = {
    id: messageId,
    entityId: userId,
    roomId: roomId,
    content: { text },
    createdAt: Date.now(),
  };

  // Store the user message in LocalDB
  if (dbAdapter) {
    await dbAdapter.createMemory(
      {
        id: messageId as `${string}-${string}-${string}-${string}-${string}`,
        entityId: userId as `${string}-${string}-${string}-${string}-${string}`,
        roomId: roomId as `${string}-${string}-${string}-${string}-${string}`,
        agentId:
          runtime.agentId as `${string}-${string}-${string}-${string}-${string}`,
        content: { text },
        createdAt: Date.now(),
      },
      "messages",
    );
  }

  // Send to the Rust runtime
  const responseJson = await runtime.handleMessage(JSON.stringify(message));
  const response = JSON.parse(responseJson) as {
    didRespond: boolean;
    responseContent?: { text?: string };
  };

  const responseText =
    response.responseContent?.text ?? "I'm not sure how to respond to that.";

  // Store the ELIZA response in LocalDB
  if (dbAdapter) {
    const responseId = wasm.generateUUID();
    await dbAdapter.createMemory(
      {
        id: responseId as `${string}-${string}-${string}-${string}-${string}`,
        entityId:
          runtime.agentId as `${string}-${string}-${string}-${string}-${string}`,
        roomId: roomId as `${string}-${string}-${string}-${string}-${string}`,
        agentId:
          runtime.agentId as `${string}-${string}-${string}-${string}-${string}`,
        content: { text: responseText },
        createdAt: Date.now(),
      },
      "messages",
    );
  }

  return responseText;
}

/**
 * Get the initial ELIZA greeting message.
 */
export function getGreeting(): string {
  return getElizaGreeting();
}

/**
 * Check if the runtime is initialized.
 */
export function isRuntimeInitialized(): boolean {
  return runtimeInstance !== null;
}

/**
 * Stop and cleanup the runtime.
 */
export async function stopRuntime(): Promise<void> {
  if (runtimeInstance) {
    runtimeInstance.stop();
    runtimeInstance.free();
    runtimeInstance = null;
  }
  if (dbAdapter) {
    await dbAdapter.close();
    dbAdapter = null;
  }
}
