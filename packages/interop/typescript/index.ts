/**
 * elizaOS Cross-Language Interop - TypeScript
 *
 * This module provides utilities for loading plugins written in other languages
 * (Rust, Python) into the TypeScript runtime.
 */

export type { PythonBridgeOptions } from "./python-bridge";
// Python Bridge (for Python plugins via IPC)
export {
  loadPythonPlugin,
  PythonPluginBridge,
  stopPythonPlugin,
} from "./python-bridge";
// Types
export type {
  ActionInvokeRequest,
  ActionManifest,
  ActionResultPayload,
  ActionResultResponse,
  EvaluatorManifest,
  InteropProtocol,
  // IPC types
  IPCMessage,
  IPCRequest,
  IPCResponse,
  PluginInteropConfig,
  PluginLanguage,
  PluginManifest,
  ProviderGetRequest,
  ProviderManifest,
  ProviderResultPayload,
  ProviderResultResponse,
  RouteManifest,
  ServiceManifest,
  // WASM types
  WasmPluginExports,
  WasmPluginInstance,
} from "./types";
export type { WasmLoaderOptions } from "./wasm-loader";
// WASM Loader (for Rust plugins compiled to WASM)
export { loadWasmPlugin, validateWasmPlugin } from "./wasm-loader";

/**
 * Universal plugin loader that auto-detects the plugin type
 */
import type { Plugin } from "@elizaos/core";
import { loadPythonPlugin } from "./python-bridge";
import type { PluginInteropConfig, PluginManifest } from "./types";
import { loadWasmPlugin } from "./wasm-loader";

export interface UniversalLoaderOptions {
  /** Path to plugin manifest (plugin.json) */
  manifestPath?: string;
  /** Direct manifest object */
  manifest?: PluginManifest;
  /** Base path for resolving relative paths in manifest */
  basePath?: string;
  /** Python executable path */
  pythonPath?: string;
  /** Connection timeout */
  timeout?: number;
}

/**
 * Load any plugin based on its manifest
 */
export async function loadPlugin(
  options: UniversalLoaderOptions,
): Promise<Plugin> {
  let manifest: PluginManifest;

  if (options.manifest) {
    manifest = options.manifest;
  } else if (options.manifestPath) {
    manifest = await loadManifestFile(options.manifestPath);
  } else {
    throw new Error("Either manifest or manifestPath is required");
  }

  const basePath =
    options.basePath ?? (await getBasePath(options.manifestPath));
  const interop = manifest.interop ?? inferInterop(manifest);

  switch (interop.protocol) {
    case "wasm":
      if (!interop.wasmPath) {
        throw new Error("WASM plugin requires wasmPath in interop config");
      }
      return loadWasmPlugin({
        wasmPath: await resolvePath(basePath, interop.wasmPath),
      });

    case "ipc":
      if (manifest.language === "python") {
        return loadPythonPlugin({
          moduleName: manifest.name.replace(/-/g, "_"),
          pythonPath: options.pythonPath,
          cwd: basePath,
          timeout: options.timeout,
        });
      }
      throw new Error(`IPC not supported for language: ${manifest.language}`);

    case "native":
      throw new Error("Native plugins must be loaded directly via import");

    case "ffi":
      throw new Error("FFI loading not yet implemented for TypeScript runtime");

    default:
      throw new Error(`Unknown interop protocol: ${interop.protocol}`);
  }
}

/**
 * Load manifest from file
 */
async function loadManifestFile(path: string): Promise<PluginManifest> {
  const isNode =
    typeof globalThis.process !== "undefined" &&
    globalThis.process.versions &&
    globalThis.process.versions.node;

  if (isNode) {
    const fs = await import("node:fs/promises");
    const content = await fs.readFile(path, "utf-8");
    return JSON.parse(content);
  } else {
    const response = await fetch(path);
    return response.json();
  }
}

/**
 * Get base path from manifest path
 */
async function getBasePath(manifestPath?: string): Promise<string> {
  if (!manifestPath) return ".";

  const isNode =
    typeof globalThis.process !== "undefined" &&
    globalThis.process.versions &&
    globalThis.process.versions.node;
  if (isNode) {
    const path = await import("node:path");
    return path.dirname(manifestPath);
  } else {
    return manifestPath.substring(0, manifestPath.lastIndexOf("/")) || ".";
  }
}

/**
 * Resolve a path relative to base
 */
async function resolvePath(base: string, relative: string): Promise<string> {
  if (relative.startsWith("/") || relative.startsWith("http")) {
    return relative;
  }

  const isNode =
    typeof globalThis.process !== "undefined" &&
    globalThis.process.versions &&
    globalThis.process.versions.node;
  if (isNode) {
    const path = await import("node:path");
    return path.resolve(base, relative);
  } else {
    return `${base}/${relative}`;
  }
}

/**
 * Infer interop config from manifest if not provided
 */
function inferInterop(manifest: PluginManifest): PluginInteropConfig {
  switch (manifest.language) {
    case "rust":
      return { protocol: "wasm", wasmPath: `./dist/${manifest.name}.wasm` };
    case "python":
      return { protocol: "ipc" };
    case "typescript":
      return { protocol: "native" };
    default:
      return { protocol: "native" };
  }
}
