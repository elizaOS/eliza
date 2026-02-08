/**
 * WASM Plugin Loader for elizaOS
 *
 * Loads Rust (or other) plugins compiled to WebAssembly and adapts them
 * to the TypeScript Plugin interface.
 */

import type {
  Action,
  ActionResult,
  EvaluationExample,
  Evaluator,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  ProviderResult,
  ProviderValue,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";

import type {
  ActionResultPayload,
  PluginManifest,
  ProviderResultPayload,
  WasmPluginExports,
  WasmPluginInstance,
} from "./types";

/**
 * Options for loading a WASM plugin
 */
export interface WasmLoaderOptions {
  /** Path or URL to the WASM file */
  wasmPath: string;
  /** Optional path to plugin.json manifest (auto-detected if not provided) */
  manifestPath?: string;
  /** Import object for WASM instantiation */
  imports?: WebAssembly.Imports;
  /** Maximum allowed WASM binary size in bytes. */
  maxWasmBytes?: number;
  /** Maximum allowed initial memory size in bytes (post-instantiation). */
  maxMemoryBytes?: number;
}

/**
 * Text encoder/decoder for string passing
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Load a WASM plugin and return an elizaOS Plugin interface
 */
export async function loadWasmPlugin(
  options: WasmLoaderOptions,
): Promise<Plugin> {
  const { wasmPath, manifestPath } = options;

  // Load the WASM module
  const wasmInstance = await loadWasmModule(wasmPath, options);

  // Get the manifest from the WASM module or external file
  let manifest: PluginManifest;
  if (manifestPath) {
    manifest = await loadManifest(manifestPath);
  } else {
    // Try to get manifest from WASM exports
    const manifestJson = wasmInstance.exports.get_manifest();
    manifest = JSON.parse(manifestJson);
  }

  // Create the plugin adapter
  return createPluginFromWasm(manifest, wasmInstance);
}

/**
 * Load a WASM module and instantiate it
 */
async function loadWasmModule(
  wasmPath: string,
  options: Pick<
    WasmLoaderOptions,
    "imports" | "maxWasmBytes" | "maxMemoryBytes"
  >,
): Promise<WasmPluginInstance> {
  // Default imports for WASM
  const defaultImports: WebAssembly.Imports = {
    env: {
      // Console logging
      console_log: (_ptr: number, _len: number) => {
        // Will be resolved once we have memory
      },
      console_error: (_ptr: number, _len: number) => {
        // Will be resolved once we have memory
      },
      // Abort handler
      abort: (_msg: number, file: number, line: number, column: number) => {
        throw new Error(`WASM abort at ${file}:${line}:${column}`);
      },
    },
    wasi_snapshot_preview1: {
      // Minimal WASI stubs for compatibility
      proc_exit: (code: number) => {
        throw new Error(`WASM exit with code ${code}`);
      },
      fd_write: () => 0,
      fd_read: () => 0,
      fd_close: () => 0,
      fd_seek: () => 0,
      environ_get: () => 0,
      environ_sizes_get: () => 0,
      clock_time_get: () => 0,
      random_get: (_buf: number, _len: number) => {
        // Fill with random bytes
        return 0;
      },
    },
  };

  const imports = { ...defaultImports, ...options.imports };

  // Determine if we're in Node.js or browser
  const isNode =
    typeof globalThis.process !== "undefined" &&
    globalThis.process.versions &&
    globalThis.process.versions.node;

  let wasmModule: WebAssembly.Module;
  if (isNode) {
    // Node.js: read file
    const fs = await import("node:fs/promises");
    if (typeof options.maxWasmBytes === "number") {
      const st = await fs.stat(wasmPath);
      if (st.size > options.maxWasmBytes) {
        throw new Error(
          `WASM binary too large (${st.size} bytes > ${options.maxWasmBytes} bytes)`,
        );
      }
    }
    const wasmBuffer = await fs.readFile(wasmPath);
    if (
      typeof options.maxWasmBytes === "number" &&
      wasmBuffer.byteLength > options.maxWasmBytes
    ) {
      throw new Error(
        `WASM binary too large (${wasmBuffer.byteLength} bytes > ${options.maxWasmBytes} bytes)`,
      );
    }
    wasmModule = await WebAssembly.compile(wasmBuffer);
  } else {
    // Browser: fetch
    const response = await fetch(wasmPath);
    const wasmBuffer = await response.arrayBuffer();
    if (
      typeof options.maxWasmBytes === "number" &&
      wasmBuffer.byteLength > options.maxWasmBytes
    ) {
      throw new Error(
        `WASM binary too large (${wasmBuffer.byteLength} bytes > ${options.maxWasmBytes} bytes)`,
      );
    }
    wasmModule = await WebAssembly.compile(wasmBuffer);
  }

  const instance = await WebAssembly.instantiate(wasmModule, imports);

  // Set up console logging now that we have memory
  const memory = instance.exports.memory as WebAssembly.Memory;
  if (
    typeof options.maxMemoryBytes === "number" &&
    memory.buffer.byteLength > options.maxMemoryBytes
  ) {
    throw new Error(
      `WASM memory too large (${memory.buffer.byteLength} bytes > ${options.maxMemoryBytes} bytes)`,
    );
  }

  if (imports.env) {
    const env = imports.env as Record<string, unknown>;
    env.console_log = (ptr: number, len: number) => {
      const bytes = new Uint8Array(memory.buffer, ptr, len);
      logger.info(
        { src: "interop:wasm", event: "interop.wasm.stdout", stream: "stdout" },
        decoder.decode(bytes),
      );
    };
    env.console_error = (ptr: number, len: number) => {
      const bytes = new Uint8Array(memory.buffer, ptr, len);
      logger.error(
        { src: "interop:wasm", event: "interop.wasm.stderr", stream: "stderr" },
        decoder.decode(bytes),
      );
    };
  }

  // Provide secure randomness for WASI random_get if present
  if (imports.wasi_snapshot_preview1) {
    const wasi = imports.wasi_snapshot_preview1 as Record<string, unknown>;
    wasi.random_get = (buf: number, len: number) => {
      const view = new Uint8Array(memory.buffer, buf, len);
      const cryptoObj = globalThis.crypto;
      if (!cryptoObj || typeof cryptoObj.getRandomValues !== "function") {
        throw new Error(
          "No secure random source available for WASI random_get",
        );
      }
      cryptoObj.getRandomValues(view);
      return 0;
    };
  }

  // Type guard to validate exports match WasmPluginExports interface
  const exports = instance.exports as WebAssembly.Exports;
  const typedExports: WasmPluginExports = {
    get_manifest: exports.get_manifest as () => string,
    init: exports.init as (config_json: string) => void,
    validate_action: exports.validate_action as (
      action: string,
      memory_json: string,
      state_json: string,
    ) => boolean,
    invoke_action: exports.invoke_action as (
      action: string,
      memory_json: string,
      state_json: string,
      options_json: string,
    ) => string,
    get_provider: exports.get_provider as (
      provider: string,
      memory_json: string,
      state_json: string,
    ) => string,
    validate_evaluator: exports.validate_evaluator as (
      evaluator: string,
      memory_json: string,
      state_json: string,
    ) => boolean,
    invoke_evaluator: exports.invoke_evaluator as (
      evaluator: string,
      memory_json: string,
      state_json: string,
    ) => string,
    handle_route: exports.handle_route as (
      path: string,
      method: string,
      request_json: string,
    ) => string,
    alloc: exports.alloc as (size: number) => number,
    dealloc: exports.dealloc as (ptr: number, size: number) => void,
  };

  return {
    exports: typedExports,
    memory: { buffer: memory.buffer },
  };
}

/**
 * Load manifest from external JSON file
 */
async function loadManifest(manifestPath: string): Promise<PluginManifest> {
  const isNode =
    typeof globalThis.process !== "undefined" &&
    globalThis.process.versions &&
    globalThis.process.versions.node;

  if (isNode) {
    const fs = await import("node:fs/promises");
    const content = await fs.readFile(manifestPath, "utf-8");
    return JSON.parse(content);
  } else {
    const response = await fetch(manifestPath);
    return response.json();
  }
}

/**
 * Helper to pass a string to WASM and get result
 */
function _callWasmWithString(
  instance: WasmPluginInstance,
  fn: (...args: number[]) => number,
  ...strings: string[]
): string {
  const { exports, memory } = instance;
  const ptrs: number[] = [];
  const lens: number[] = [];

  // Allocate and write strings
  for (const str of strings) {
    const bytes = encoder.encode(str);
    const ptr = exports.alloc(bytes.length);
    const view = new Uint8Array(memory.buffer, ptr, bytes.length);
    view.set(bytes);
    ptrs.push(ptr);
    lens.push(bytes.length);
  }

  // Call the function
  const args: number[] = [];
  for (let i = 0; i < strings.length; i++) {
    args.push(ptrs[i], lens[i]);
  }
  const resultPtr = fn(...args);

  // Read result (assuming null-terminated or length-prefixed)
  // For now, assume it returns a pointer to a null-terminated string
  let resultLen = 0;
  const view = new Uint8Array(memory.buffer);
  while (
    view[resultPtr + resultLen] !== 0 &&
    resultPtr + resultLen < view.length
  ) {
    resultLen++;
  }
  const result = decoder.decode(
    new Uint8Array(memory.buffer, resultPtr, resultLen),
  );

  // Deallocate input strings
  for (let i = 0; i < strings.length; i++) {
    exports.dealloc(ptrs[i], lens[i]);
  }

  return result;
}

/**
 * Create a Plugin from a WASM instance
 */
function createPluginFromWasm(
  manifest: PluginManifest,
  instance: WasmPluginInstance,
): Plugin {
  const { exports } = instance;

  // Create action wrappers
  const actions: Action[] = (manifest.actions ?? []).map((actionDef) => ({
    name: actionDef.name,
    description: actionDef.description,
    similes: actionDef.similes,
    examples: actionDef.examples,

    validate: async (
      _runtime: IAgentRuntime,
      message: Memory,
      state: State | undefined,
    ): Promise<boolean> => {
      const result = exports.validate_action(
        actionDef.name,
        JSON.stringify(message),
        JSON.stringify(state ?? null),
      );
      return typeof result === "boolean" ? result : result !== 0;
    },

    handler: async (
      _runtime: IAgentRuntime,
      message: Memory,
      state: State | undefined,
      options?: HandlerOptions,
      _callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      const resultJson = exports.invoke_action(
        actionDef.name,
        JSON.stringify(message),
        JSON.stringify(state ?? null),
        JSON.stringify(options ?? {}),
      );
      const result: ActionResultPayload = JSON.parse(resultJson);
      return {
        success: result.success,
        text: result.text,
        error: result.error ? new Error(result.error) : undefined,
        data: result.data as Record<string, ProviderValue> | undefined,
        values: result.values as Record<string, ProviderValue> | undefined,
      };
    },
  }));

  // Create provider wrappers
  const providers: Provider[] = (manifest.providers ?? []).map(
    (providerDef) => ({
      name: providerDef.name,
      description: providerDef.description,
      dynamic: providerDef.dynamic,
      position: providerDef.position,
      private: providerDef.private,

      get: async (
        _runtime: IAgentRuntime,
        message: Memory,
        state: State,
      ): Promise<ProviderResult> => {
        const resultJson = exports.get_provider(
          providerDef.name,
          JSON.stringify(message),
          JSON.stringify(state),
        );
        const result: ProviderResultPayload = JSON.parse(resultJson);
        return {
          text: result.text,
          values: result.values as Record<string, ProviderValue> | undefined,
          data: result.data as Record<string, ProviderValue> | undefined,
        };
      },
    }),
  );

  // Create evaluator wrappers
  const evaluators: Evaluator[] = (manifest.evaluators ?? []).map(
    (evalDef) => ({
      name: evalDef.name,
      description: evalDef.description,
      alwaysRun: evalDef.alwaysRun,
      similes: evalDef.similes,
      examples: [] as EvaluationExample[],

      validate: async (
        _runtime: IAgentRuntime,
        message: Memory,
        state: State | undefined,
      ): Promise<boolean> => {
        const result = exports.validate_evaluator(
          evalDef.name,
          JSON.stringify(message),
          JSON.stringify(state ?? null),
        );
        return typeof result === "boolean" ? result : result !== 0;
      },

      handler: async (
        _runtime: IAgentRuntime,
        message: Memory,
        state: State | undefined,
      ): Promise<ActionResult | undefined> => {
        const resultJson = exports.invoke_evaluator(
          evalDef.name,
          JSON.stringify(message),
          JSON.stringify(state ?? null),
        );
        if (!resultJson || resultJson === "null") {
          return undefined;
        }
        const result: ActionResultPayload = JSON.parse(resultJson);
        return {
          success: result.success,
          text: result.text,
          error: result.error ? new Error(result.error) : undefined,
          data: result.data as Record<string, ProviderValue> | undefined,
          values: result.values as Record<string, ProviderValue> | undefined,
        };
      },
    }),
  );

  // Return the plugin
  return {
    name: manifest.name,
    description: manifest.description,
    config: manifest.config ?? {},
    dependencies: manifest.dependencies,
    actions,
    providers,
    evaluators,
    // Routes would need special handling for WASM
    routes: [],
    // Services need special handling
    services: [],

    async init(config: Record<string, string>) {
      exports.init(JSON.stringify(config));
    },
  };
}

/**
 * Preload and validate a WASM plugin without fully loading it
 */
export async function validateWasmPlugin(wasmPath: string): Promise<{
  valid: boolean;
  manifest?: PluginManifest;
  error?: string;
}> {
  try {
    const instance = await loadWasmModule(wasmPath, {});
    const manifestJson = instance.exports.get_manifest();
    const manifest: PluginManifest = JSON.parse(manifestJson);

    // Basic validation
    if (!manifest.name || !manifest.description) {
      return { valid: false, error: "Missing required manifest fields" };
    }

    return { valid: true, manifest };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
