/**
 * Python Plugin Bridge for elizaOS
 *
 * Loads Python plugins via subprocess IPC and adapts them
 * to the TypeScript Plugin interface.
 */

import { EventEmitter } from "node:events";
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
  ActionResultResponse,
  ErrorResponse,
  IPCRequest,
  IPCResponse,
  PluginManifest,
  ProviderResultResponse,
  ValidationResponse,
} from "./types";

/**
 * Options for loading a Python plugin
 */
export interface PythonBridgeOptions {
  /** Python module name to import */
  moduleName: string;
  /** Path to Python executable (defaults to 'python3') */
  pythonPath?: string;
  /** Working directory for the subprocess */
  cwd?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /**
   * Whether to inherit the parent process environment variables.
   *
   * Defaults to true for compatibility. For tighter isolation, set to false and pass only
   * explicit `env` entries.
   */
  inheritEnv?: boolean;
  /** Environment variable names to remove when inheriting. */
  envDenylist?: string[];
  /** Path to the bridge script */
  bridgeScriptPath?: string;
  /** Connection timeout in milliseconds */
  timeout?: number;
  /** Maximum number of in-flight IPC requests (prevents unbounded memory growth). */
  maxPendingRequests?: number;
  /** Maximum size (bytes) of a single newline-delimited IPC message. */
  maxMessageBytes?: number;
  /** Maximum size (bytes) of the internal stdout buffer. */
  maxBufferBytes?: number;
}

/**
 * Pending request tracker
 */
interface PendingRequest {
  resolve: (value: IPCResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Python plugin bridge that communicates via subprocess
 */
export class PythonPluginBridge extends EventEmitter {
  private process: ReturnType<typeof import("child_process").spawn> | null =
    null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private messageBuffer: string = "";
  private manifest: PluginManifest | null = null;
  private initialized: boolean = false;
  private requestCounter: number = 0;

  constructor(private options: PythonBridgeOptions) {
    super();
  }

  private buildChildEnv(): Record<string, string> {
    const inherit = this.options.inheritEnv !== false;
    const base: Record<string, string> = {};

    if (inherit) {
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string") {
          base[k] = v;
        }
      }
    }

    const deny = new Set(this.options.envDenylist ?? []);
    for (const key of deny) {
      delete base[key];
    }

    if (this.options.env) {
      for (const [k, v] of Object.entries(this.options.env)) {
        base[k] = v;
      }
    }

    return base;
  }

  /**
   * Start the Python subprocess
   */
  async start(): Promise<void> {
    const { spawn } = await import("node:child_process");

    const pythonPath = this.options.pythonPath ?? "python3";
    const bridgeScript =
      this.options.bridgeScriptPath ??
      new URL("../python/bridge_server.py", import.meta.url).pathname;

    this.process = spawn(
      pythonPath,
      ["-u", bridgeScript, "--module", this.options.moduleName],
      {
        cwd: this.options.cwd,
        env: this.buildChildEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    // Handle stdout (JSON-RPC messages)
    if (this.process.stdout) {
      this.process.stdout.on("data", (data: Buffer) => {
        this.handleData(data.toString());
      });
    }

    // Handle stderr (logging)
    if (this.process.stderr) {
      this.process.stderr.on("data", (data: Buffer) => {
        logger.error(
          {
            src: "interop:python-bridge",
            event: "interop.ipc.stderr",
            moduleName: this.options.moduleName,
            stream: "stderr",
          },
          data.toString(),
        );
      });
    }

    // Handle process exit
    this.process.on("exit", (code, signal) => {
      this.emit("exit", { code, signal });
      this.cleanup();
    });

    this.process.on("error", (error) => {
      this.emit("error", error);
    });

    // Wait for the ready message with manifest
    await this.waitForReady();
    this.initialized = true;
  }

  /**
   * Wait for the Python process to send ready message
   */
  private async waitForReady(): Promise<void> {
    const timeout = this.options.timeout ?? 30000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Python plugin startup timeout after ${timeout}ms`));
      }, timeout);

      const handler = (
        msg: IPCResponse | { type: "ready"; manifest: PluginManifest },
      ) => {
        if (msg.type === "ready" && "manifest" in msg) {
          clearTimeout(timer);
          this.manifest = (msg as { manifest: PluginManifest }).manifest;
          resolve();
        }
      };

      this.once("message", handler);
    });
  }

  /**
   * Handle incoming data from subprocess
   */
  private handleData(data: string): void {
    const maxBufferBytes = this.options.maxBufferBytes ?? 2_000_000;
    const maxMessageBytes = this.options.maxMessageBytes ?? 1_000_000;

    this.messageBuffer += data;
    if (Buffer.byteLength(this.messageBuffer, "utf8") > maxBufferBytes) {
      logger.error(
        {
          src: "interop:python-bridge",
          event: "interop.ipc.stdout_buffer_exceeded",
          moduleName: this.options.moduleName,
        },
        `IPC stdout buffer exceeded limit (${maxBufferBytes} bytes); terminating bridge`,
      );
      this.process?.kill("SIGKILL");
      this.cleanup();
      return;
    }

    // Process complete JSON messages (newline-delimited)
    const lines = this.messageBuffer.split("\n");
    this.messageBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim()) {
        if (Buffer.byteLength(line, "utf8") > maxMessageBytes) {
          logger.error(
            {
              src: "interop:python-bridge",
              event: "interop.ipc.message_exceeded",
              moduleName: this.options.moduleName,
            },
            `IPC message exceeded limit (${maxMessageBytes} bytes); terminating bridge`,
          );
          this.process?.kill("SIGKILL");
          this.cleanup();
          return;
        }
        try {
          const message: IPCResponse = JSON.parse(line);
          this.handleMessage(message);
        } catch (_error) {
          logger.error(
            {
              src: "interop:python-bridge",
              event: "interop.ipc.parse_failed",
              moduleName: this.options.moduleName,
            },
            `Failed to parse IPC message: ${line}`,
          );
        }
      }
    }
  }

  /**
   * Handle a parsed IPC message
   */
  private handleMessage(message: IPCResponse): void {
    this.emit("message", message);

    // Check if this is a response to a pending request
    if (message.id && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timeout);

      if (message.type === "error") {
        pending.reject(new Error((message as ErrorResponse).error));
      } else {
        pending.resolve(message);
      }
    }
  }

  /**
   * Send a request and wait for response
   */
  async sendRequest<T extends IPCResponse>(request: IPCRequest): Promise<T> {
    if (!this.process || !this.initialized) {
      throw new Error("Python bridge not started");
    }

    const maxPendingRequests = this.options.maxPendingRequests ?? 1000;
    if (this.pendingRequests.size >= maxPendingRequests) {
      throw new Error(
        `Too many pending IPC requests (max=${maxPendingRequests})`,
      );
    }

    const id = `req_${++this.requestCounter}`;
    const requestWithId = { ...request, id };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout for ${request.type}`));
      }, this.options.timeout ?? 30000);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: IPCResponse) => void,
        reject,
        timeout,
      });

      const json = `${JSON.stringify(requestWithId)}\n`;
      if (this.process?.stdin) {
        this.process.stdin.write(json);
      }
    });
  }

  /**
   * Get the plugin manifest
   */
  getManifest(): PluginManifest | null {
    return this.manifest;
  }

  /**
   * Stop the Python subprocess
   */
  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill("SIGTERM");

      // Wait for graceful shutdown
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            this.process.kill("SIGKILL");
          }
          resolve();
        }, 5000);

        if (this.process) {
          this.process.on("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          resolve();
        }
      });
    }
    this.cleanup();
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    this.process = null;
    this.initialized = false;

    // Reject all pending requests
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Bridge closed"));
    }
    this.pendingRequests.clear();
  }
}

/**
 * Load a Python plugin and return an elizaOS Plugin interface
 */
export async function loadPythonPlugin(
  options: PythonBridgeOptions,
): Promise<Plugin> {
  const bridge = new PythonPluginBridge(options);
  await bridge.start();

  const manifest = bridge.getManifest();
  if (!manifest) {
    throw new Error("Failed to get plugin manifest");
  }

  return createPluginFromBridge(manifest, bridge);
}

/**
 * Create a Plugin from a Python bridge
 */
function createPluginFromBridge(
  manifest: PluginManifest,
  bridge: PythonPluginBridge,
): Plugin {
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
      const response = await bridge.sendRequest<ValidationResponse>({
        type: "action.validate",
        id: "",
        action: actionDef.name,
        memory: message,
        state: state ?? null,
      });
      return response.valid;
    },

    handler: async (
      _runtime: IAgentRuntime,
      message: Memory,
      state: State | undefined,
      options?: HandlerOptions,
      _callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      const response = await bridge.sendRequest<ActionResultResponse>({
        type: "action.invoke",
        id: "",
        action: actionDef.name,
        memory: message,
        state: state ?? null,
        options: (options as Record<string, unknown>) ?? null,
      });
      const result = response.result;
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
        const response = await bridge.sendRequest<ProviderResultResponse>({
          type: "provider.get",
          id: "",
          provider: providerDef.name,
          memory: message,
          state: state,
        });
        return {
          text: response.result.text,
          values: response.result.values as
            | Record<string, ProviderValue>
            | undefined,
          data: response.result.data as
            | Record<string, ProviderValue>
            | undefined,
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
        const response = await bridge.sendRequest<ValidationResponse>({
          type: "action.validate",
          id: "",
          action: evalDef.name,
          memory: message,
          state: state ?? null,
        });
        return response.valid;
      },

      handler: async (
        _runtime: IAgentRuntime,
        message: Memory,
        state: State | undefined,
      ): Promise<ActionResult | undefined> => {
        const response = await bridge.sendRequest<ActionResultResponse>({
          type: "evaluator.invoke",
          id: "",
          evaluator: evalDef.name,
          memory: message,
          state: state ?? null,
        });
        if (!response.result) {
          return undefined;
        }
        return {
          success: response.result.success,
          text: response.result.text,
          error: response.result.error
            ? new Error(response.result.error)
            : undefined,
          data: response.result.data as
            | Record<string, ProviderValue>
            | undefined,
          values: response.result.values as
            | Record<string, ProviderValue>
            | undefined,
        };
      },
    }),
  );

  // Store bridge reference for cleanup
  const bridgeRef = { current: bridge };

  return {
    name: manifest.name,
    description: manifest.description,
    config: manifest.config ?? {},
    dependencies: manifest.dependencies,
    actions,
    providers,
    evaluators,
    routes: [],
    services: [],

    async init(config: Record<string, string>) {
      await bridge.sendRequest({
        type: "plugin.init",
        id: "",
        config,
      });
    },

    // Extension for cleanup
    _bridge: bridgeRef,
  } as Plugin & { _bridge: { current: PythonPluginBridge } };
}

/**
 * Stop a Python plugin bridge
 */
export async function stopPythonPlugin(plugin: Plugin): Promise<void> {
  const extended = plugin as Plugin & {
    _bridge?: { current: PythonPluginBridge };
  };
  if (extended._bridge?.current) {
    await extended._bridge.current.stop();
  }
}
