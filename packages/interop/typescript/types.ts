/**
 * Cross-language interop types for elizaOS
 *
 * These types define the wire format for communication between
 * different language runtimes (Rust, TypeScript, Python).
 *
 * Standalone definitions matching proto schemas in /schemas/eliza/v1/ipc.proto.
 * For full proto-generated types, import from @elizaos/core.
 */

import type { Content, Memory, State } from "@elizaos/core";

/**
 * Supported interop protocols
 */
export type InteropProtocol = "wasm" | "ffi" | "ipc" | "native";

/**
 * Supported plugin languages
 */
export type PluginLanguage = "typescript" | "rust" | "python";

/**
 * Plugin interop configuration
 */
export interface PluginInteropConfig {
  /** Communication protocol */
  protocol: InteropProtocol;
  /** Path to WASM module (for wasm protocol) */
  wasmPath?: string;
  /** Path to shared library (for ffi protocol) */
  sharedLibPath?: string;
  /** IPC command to spawn subprocess */
  ipcCommand?: string;
  /** IPC port for TCP communication */
  ipcPort?: number;
  /** Working directory for subprocess */
  cwd?: string;
}

/**
 * Cross-language plugin manifest
 */
export interface PluginManifest {
  name: string;
  description: string;
  version: string;
  language: PluginLanguage;
  interop?: PluginInteropConfig;
  config?: Record<string, string | number | boolean | null>;
  dependencies?: string[];
  actions?: ActionManifest[];
  providers?: ProviderManifest[];
  evaluators?: EvaluatorManifest[];
  services?: ServiceManifest[];
  routes?: RouteManifest[];
  events?: Record<string, string[]>;
}

/**
 * Action manifest (metadata only, no handlers)
 */
export interface ActionManifest {
  name: string;
  description: string;
  similes?: string[];
  examples?: ActionExample[][];
}

/**
 * Action example for documentation
 */
export interface ActionExample {
  name: string;
  content: Content;
}

/**
 * Provider manifest
 */
export interface ProviderManifest {
  name: string;
  description?: string;
  dynamic?: boolean;
  position?: number;
  private?: boolean;
}

/**
 * Evaluator manifest
 */
export interface EvaluatorManifest {
  name: string;
  description: string;
  alwaysRun?: boolean;
  similes?: string[];
}

/**
 * Service manifest
 */
export interface ServiceManifest {
  type: string;
  description?: string;
}

/**
 * Route manifest
 */
export interface RouteManifest {
  path: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "STATIC";
  name?: string;
  public?: boolean;
  isMultipart?: boolean;
}

// ============================================================================
// IPC Message Types
// ============================================================================

/**
 * Base IPC message
 */
export interface IPCMessage {
  type: string;
  id: string;
}

/**
 * Action invocation request
 */
export interface ActionInvokeRequest extends IPCMessage {
  type: "action.invoke";
  action: string;
  memory: Memory;
  state: State | null;
  options: Record<string, unknown> | null;
}

/**
 * Action result response
 */
export interface ActionResultResponse extends IPCMessage {
  type: "action.result";
  result: ActionResultPayload;
}

/**
 * Action result payload
 */
export interface ActionResultPayload {
  success: boolean;
  text?: string;
  error?: string;
  data?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

/**
 * Action validation request
 */
export interface ActionValidateRequest extends IPCMessage {
  type: "action.validate";
  action: string;
  memory: Memory;
  state: State | null;
}

/**
 * Validation result response
 */
export interface ValidationResponse extends IPCMessage {
  type: "validate.result";
  valid: boolean;
}

/**
 * Provider get request
 */
export interface ProviderGetRequest extends IPCMessage {
  type: "provider.get";
  provider: string;
  memory: Memory;
  state: State;
}

/**
 * Provider result response
 */
export interface ProviderResultResponse extends IPCMessage {
  type: "provider.result";
  result: ProviderResultPayload;
}

/**
 * Provider result payload
 */
export interface ProviderResultPayload {
  text?: string;
  values?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

/**
 * Evaluator invocation request
 */
export interface EvaluatorInvokeRequest extends IPCMessage {
  type: "evaluator.invoke";
  evaluator: string;
  memory: Memory;
  state: State | null;
}

/**
 * Service start request
 */
export interface ServiceStartRequest extends IPCMessage {
  type: "service.start";
  service: string;
}

/**
 * Service stop request
 */
export interface ServiceStopRequest extends IPCMessage {
  type: "service.stop";
  service: string;
}

/**
 * Service response
 */
export interface ServiceResponse extends IPCMessage {
  type: "service.response";
  success: boolean;
  error?: string;
}

/**
 * Route handler request
 */
export interface RouteHandlerRequest extends IPCMessage {
  type: "route.handle";
  path: string;
  method: string;
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  headers?: Record<string, string | string[]>;
}

/**
 * Route handler response
 */
export interface RouteHandlerResponse extends IPCMessage {
  type: "route.response";
  status: number;
  headers?: Record<string, string | string[]>;
  body?: unknown;
}

/**
 * Plugin initialization request
 */
export interface PluginInitRequest extends IPCMessage {
  type: "plugin.init";
  config: Record<string, string>;
}

/**
 * Plugin initialization response
 */
export interface PluginInitResponse extends IPCMessage {
  type: "plugin.init.result";
  success: boolean;
  error?: string;
}

/**
 * Error response
 */
export interface ErrorResponse extends IPCMessage {
  type: "error";
  error: string;
  details?: unknown;
}

/**
 * All possible IPC request types
 */
export type IPCRequest =
  | ActionInvokeRequest
  | ActionValidateRequest
  | ProviderGetRequest
  | EvaluatorInvokeRequest
  | ServiceStartRequest
  | ServiceStopRequest
  | RouteHandlerRequest
  | PluginInitRequest;

/**
 * All possible IPC response types
 */
export type IPCResponse =
  | ActionResultResponse
  | ValidationResponse
  | ProviderResultResponse
  | ServiceResponse
  | RouteHandlerResponse
  | PluginInitResponse
  | ErrorResponse;

// ============================================================================
// WASM Interface Types
// ============================================================================

/**
 * WASM plugin exports interface
 */
export interface WasmPluginExports {
  /** Get plugin manifest as JSON string */
  get_manifest(): string;

  /** Initialize the plugin with config JSON */
  init(config_json: string): void;

  /** Validate an action (returns boolean) */
  validate_action(
    action: string,
    memory_json: string,
    state_json: string,
  ): boolean;

  /** Invoke an action (returns result JSON) */
  invoke_action(
    action: string,
    memory_json: string,
    state_json: string,
    options_json: string,
  ): string;

  /** Get provider data (returns result JSON) */
  get_provider(
    provider: string,
    memory_json: string,
    state_json: string,
  ): string;

  /** Validate an evaluator */
  validate_evaluator(
    evaluator: string,
    memory_json: string,
    state_json: string,
  ): boolean;

  /** Invoke an evaluator (returns result JSON) */
  invoke_evaluator(
    evaluator: string,
    memory_json: string,
    state_json: string,
  ): string;

  /** Handle a route (returns response JSON) */
  handle_route(path: string, method: string, request_json: string): string;

  /** Memory allocation for passing strings */
  alloc(size: number): number;

  /** Memory deallocation */
  dealloc(ptr: number, size: number): void;
}

/**
 * WASM memory interface
 */
export interface WasmMemory {
  buffer: ArrayBuffer;
}

/**
 * WASM instance with memory and exports
 */
export interface WasmPluginInstance {
  exports: WasmPluginExports;
  memory: WasmMemory;
}
