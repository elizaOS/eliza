import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { RustPluginTestSuite } from "./__tests__/e2e/rust-plugin.e2e";

/**
 * Rust Plugin Starter - TypeScript Wrapper
 *
 * This TypeScript wrapper loads the Rust plugin compiled to WASM via wasm-bindgen
 * and exposes it as an elizaOS plugin.
 */

// Type definitions for wasm-bindgen generated module
interface WasmBindgenModule {
  get_manifest(): string;
  init(config_json: string): void;
  validate_action(
    name: string,
    memory_json: string,
    state_json: string,
  ): boolean;
  invoke_action(
    name: string,
    memory_json: string,
    state_json: string,
    options_json: string,
  ): string;
  get_provider(name: string, memory_json: string, state_json: string): string;
  validate_evaluator(
    name: string,
    memory_json: string,
    state_json: string,
  ): boolean;
  invoke_evaluator(
    name: string,
    memory_json: string,
    state_json: string,
  ): string;
}

let wasmModule: WasmBindgenModule | null = null;
let pluginManifest: {
  name: string;
  description: string;
  version: string;
  language: string;
  actions?: Array<{ name: string; description: string; similes?: string[] }>;
  providers?: Array<{ name: string; description: string }>;
} | null = null;

export const rustPluginStarter: Plugin = {
  name: "rust-plugin-starter",
  description:
    "A starter template for Rust plugins with cross-language support",
  config: {},

  async init(config: Record<string, string>) {
    // Load the wasm-bindgen generated module
    // The JS file should be built and available at dist/elizaos_plugin_starter.js
    // Use absolute path resolution
    const wasmModulePath = new URL(
      "../dist/elizaos_plugin_starter.js",
      import.meta.url,
    ).href;

    logger.info("Loading Rust WASM plugin from:", wasmModulePath);

    // Dynamic import of the wasm-bindgen generated module
    const wasmBindgenModule = await import(wasmModulePath);

    // Initialize the WASM module (wasm-bindgen does this automatically, but we may need to call init)
    // Type assertion needed because wasm-bindgen generates dynamic exports
    if (
      typeof wasmBindgenModule === "object" &&
      wasmBindgenModule !== null &&
      "get_manifest" in wasmBindgenModule &&
      typeof wasmBindgenModule.get_manifest === "function"
    ) {
      wasmModule = wasmBindgenModule as WasmBindgenModule;
    } else {
      throw new Error("Invalid WASM module: missing required exports");
    }

    // Get the manifest
    const manifestJson = wasmModule.get_manifest();
    pluginManifest = JSON.parse(manifestJson);

    // Initialize the Rust plugin with config
    wasmModule.init(JSON.stringify(config));

    logger.info("Rust WASM plugin loaded successfully");
  },

  get actions(): Action[] {
    if (!wasmModule || !pluginManifest) {
      return [];
    }

    return (pluginManifest.actions ?? []).map((actionDef) => ({
      name: actionDef.name,
      description: actionDef.description,
      similes: actionDef.similes,

      validate: async (
        _runtime: IAgentRuntime,
        message: Memory,
        state: State | undefined,
      ): Promise<boolean> => {
        if (!wasmModule) return false;
        return wasmModule.validate_action(
          actionDef.name,
          JSON.stringify(message),
          JSON.stringify(state ?? null),
        );
      },

      handler: async (
        _runtime: IAgentRuntime,
        message: Memory,
        state: State | undefined,
        options?: HandlerOptions,
        callback?: HandlerCallback,
      ): Promise<ActionResult> => {
        if (!wasmModule) {
          return {
            success: false,
            error: new Error("WASM module not initialized"),
          };
        }

        const resultJson = wasmModule.invoke_action(
          actionDef.name,
          JSON.stringify(message),
          JSON.stringify(state ?? null),
          JSON.stringify(options ?? {}),
        );

        const result = JSON.parse(resultJson);

        // Call callback if provided
        if (callback && result.success && result.text) {
          await callback({
            text: result.text,
            actions: [actionDef.name],
            source: message.content.source,
          });
        }

        return {
          success: result.success,
          text: result.text,
          error: result.error ? new Error(result.error) : undefined,
          data: result.data,
          values: result.values,
        };
      },

      examples: [],
    }));
  },

  get providers(): Provider[] {
    if (!wasmModule || !pluginManifest) {
      return [];
    }

    return (pluginManifest.providers ?? []).map((providerDef) => ({
      name: providerDef.name,
      description: providerDef.description,

      get: async (
        _runtime: IAgentRuntime,
        message: Memory,
        state: State,
      ): Promise<ProviderResult> => {
        if (!wasmModule) {
          return { text: undefined, values: undefined, data: undefined };
        }

        const resultJson = wasmModule.get_provider(
          providerDef.name,
          JSON.stringify(message),
          JSON.stringify(state),
        );

        const result = JSON.parse(resultJson);
        return {
          text: result.text,
          values: result.values,
          data: result.data,
        };
      },
    }));
  },

  get evaluators() {
    return [];
  },

  get routes() {
    return [];
  },

  get services() {
    return [];
  },

  get events() {
    return {};
  },

  get models() {
    return {};
  },

  get dependencies() {
    return [];
  },

  tests: [RustPluginTestSuite],
};

export default rustPluginStarter;
