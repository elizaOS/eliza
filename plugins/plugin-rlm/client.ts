/** RLM Client - communicates with Python subprocess via JSON-RPC IPC. */

import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline";

import { assertRecordedLlmCall } from "@elizaos/core";
import type {
  IPCReadyMessage,
  IPCRequest,
  IPCResponse,
  MetricsCallback,
  RLMConfig,
  RLMInferOptions,
  RLMMessage,
  RLMMetrics,
  RLMResult,
  RLMStatusResponse,
} from "./types";
import { DEFAULT_CONFIG, ENV_VARS, validateConfig } from "./types";

export type { MetricsCallback, RLMMetrics };
export { DEFAULT_CONFIG };

interface Logger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
}

const defaultLogger: Logger = {
  info: (msg, ...args) => console.log(`[RLM] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[RLM] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[RLM] ${msg}`, ...args),
  debug: (msg, ...args) => console.debug(`[RLM] ${msg}`, ...args),
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RLMConfig {
  return {
    backend: (env[ENV_VARS.BACKEND] as RLMConfig["backend"]) ?? DEFAULT_CONFIG.backend,
    backendKwargs: {},
    environment:
      (env[ENV_VARS.ENVIRONMENT] as RLMConfig["environment"]) ?? DEFAULT_CONFIG.environment,
    maxIterations:
      Number.parseInt(env[ENV_VARS.MAX_ITERATIONS] ?? "", 10) || DEFAULT_CONFIG.maxIterations,
    maxDepth: Number.parseInt(env[ENV_VARS.MAX_DEPTH] ?? "", 10) || DEFAULT_CONFIG.maxDepth,
    verbose: ["1", "true", "yes"].includes((env[ENV_VARS.VERBOSE] ?? "").toLowerCase()),
    pythonPath: env[ENV_VARS.PYTHON_PATH] ?? DEFAULT_CONFIG.pythonPath,
    maxRetries: Number.parseInt(env[ENV_VARS.MAX_RETRIES] ?? "", 10) || DEFAULT_CONFIG.maxRetries,
    retryBaseDelay:
      Number.parseInt(env[ENV_VARS.RETRY_BASE_DELAY] ?? "", 10) || DEFAULT_CONFIG.retryBaseDelay,
    retryMaxDelay:
      Number.parseInt(env[ENV_VARS.RETRY_MAX_DELAY] ?? "", 10) || DEFAULT_CONFIG.retryMaxDelay,
  };
}

export class RLMClient {
  private config: RLMConfig;
  private process: ChildProcess | null = null;
  private reader: readline.Interface | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (value: IPCResponse) => void; reject: (error: Error) => void }
  >();
  private isReady = false;
  private isAvailable = false;
  private hasStartupError = false;
  private logger: Logger;
  private metrics: RLMMetrics = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    stubResponses: 0,
    totalRetries: 0,
    averageLatencyMs: 0,
    p95LatencyMs: 0,
    lastRequestTimestamp: 0,
  };
  private static readonly MAX_LATENCY_SAMPLES = 1000;
  private latencies: number[] = new Array(RLMClient.MAX_LATENCY_SAMPLES).fill(0);
  private latencyIndex = 0;
  private latencyCount = 0;
  private metricsCallback: MetricsCallback | null = null;

  constructor(config?: Partial<RLMConfig>, logger?: Logger, strictValidation = false) {
    this.config = { ...configFromEnv(), ...config };
    this.logger = logger ?? defaultLogger;

    const errors = validateConfig(this.config);
    if (errors.length > 0) {
      if (strictValidation) {
        throw new Error(`RLM configuration invalid: ${errors.join("; ")}`);
      }
      for (const error of errors) {
        this.logger.warn(`Configuration warning: ${error}`);
      }
    }
  }

  private async startServer(): Promise<void> {
    if (this.process) return;
    this.hasStartupError = false;

    this.logger.debug(
      `Starting RLM server: ${this.config.pythonPath} -m elizaos_plugin_rlm.server`,
    );

    try {
      this.process = spawn(this.config.pythonPath, ["-m", "elizaos_plugin_rlm.server"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          [ENV_VARS.BACKEND]: this.config.backend,
          [ENV_VARS.ENVIRONMENT]: this.config.environment,
          [ENV_VARS.MAX_ITERATIONS]: String(this.config.maxIterations),
          [ENV_VARS.MAX_DEPTH]: String(this.config.maxDepth),
          [ENV_VARS.VERBOSE]: this.config.verbose ? "true" : "false",
        },
        cwd: path.join(__dirname, "..", "python"),
      });
    } catch (error) {
      this.logger.warn(`Failed to start RLM server: ${error}`);
      this.isAvailable = false;
      return;
    }

    if (!this.process.stdout || !this.process.stdin) {
      this.logger.warn("RLM server process missing stdio streams");
      this.isAvailable = false;
      return;
    }

    // Set up line reader for responses
    this.reader = readline.createInterface({
      input: this.process.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    // Handle incoming messages
    this.reader.on("line", (line: string) => {
      this.handleMessage(line);
    });

    // Handle errors
    this.process.stderr?.on("data", (data: Buffer) => {
      this.logger.debug(`RLM server stderr: ${data.toString()}`);
    });

    this.process.on("error", (error: Error) => {
      this.logger.error(`RLM server error: ${error.message}`);
      this.isAvailable = false;
      this.hasStartupError = true;
    });

    this.process.on("exit", (code: number | null) => {
      this.logger.debug(`RLM server exited with code ${code}`);
      this.isReady = false;
      this.isAvailable = false;
      this.process = null;
    });

    await this.waitForReady();
  }

  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const TIMEOUT_MS = 10000;
      const POLL_INTERVAL_MS = 100;
      const deadline = Date.now() + TIMEOUT_MS;

      const checkReady = () => {
        if (this.isReady) {
          resolve();
        } else if (!this.process || this.hasStartupError) {
          reject(new Error("RLM server process failed before ready"));
        } else if (Date.now() > deadline) {
          reject(new Error("RLM server startup timeout"));
        } else {
          setTimeout(checkReady, POLL_INTERVAL_MS);
        }
      };
      checkReady();
    });
  }

  private handleMessage(line: string): void {
    try {
      const message = JSON.parse(line) as IPCResponse | IPCReadyMessage;

      // Check for ready message
      if ("ready" in message) {
        const readyMsg = message as IPCReadyMessage;
        this.isReady = true;
        this.isAvailable = readyMsg.available;
        this.logger.info(`RLM server ready, available: ${this.isAvailable}`);
        return;
      }

      // Handle response
      const response = message as IPCResponse;
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        pending.resolve(response);
      }
    } catch (_error) {
      this.logger.error(`Failed to parse RLM server message: ${line}`);
    }
  }

  private async sendRequest<T>(
    method: IPCRequest["method"],
    params: Record<string, unknown> = {},
  ): Promise<T> {
    await this.ensureServer();

    if (!this.process?.stdin) {
      throw new Error("RLM server not running");
    }

    const id = ++this.requestId;
    const request: IPCRequest = { id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RLM request timeout: ${method}`));
      }, 60000);

      this.pendingRequests.set(id, {
        resolve: (response: IPCResponse) => {
          clearTimeout(timeout);
          if (response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response.result as T);
          }
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.process?.stdin?.write(`${JSON.stringify(request)}\n`);
    });
  }

  private async ensureServer(): Promise<void> {
    if (!this.process || !this.isReady) {
      await this.startServer();
    }
  }

  get available(): boolean {
    return this.isAvailable;
  }

  getMetrics(): RLMMetrics {
    return { ...this.metrics };
  }

  onMetrics(callback: MetricsCallback): void {
    this.metricsCallback = callback;
  }

  private updateMetrics(
    latencyMs: number,
    success: boolean,
    isStub: boolean,
    error?: string,
  ): void {
    this.metrics.totalRequests++;
    this.metrics.lastRequestTimestamp = Date.now();

    if (isStub) {
      this.metrics.stubResponses++;
    } else if (success) {
      this.metrics.successfulRequests++;
    } else {
      this.metrics.failedRequests++;
      this.metrics.lastErrorTimestamp = Date.now();
      this.metrics.lastError = error;
    }

    // Track latency in circular buffer
    this.latencies[this.latencyIndex] = latencyMs;
    this.latencyIndex = (this.latencyIndex + 1) % RLMClient.MAX_LATENCY_SAMPLES;
    this.latencyCount = Math.min(this.latencyCount + 1, RLMClient.MAX_LATENCY_SAMPLES);

    // Calculate stats from valid samples
    if (this.latencyCount > 0) {
      const valid = this.latencies.slice(0, this.latencyCount);
      this.metrics.averageLatencyMs = valid.reduce((a, b) => a + b, 0) / this.latencyCount;
      this.metrics.p95LatencyMs =
        [...valid].sort((a, b) => a - b)[Math.floor(valid.length * 0.95)] ?? 0;
    }

    this.metricsCallback?.(this.getMetrics());
  }

  static normalizeMessages(messages: string | RLMMessage[]): RLMMessage[] {
    return typeof messages === "string" ? [{ role: "user", content: messages }] : messages;
  }

  async infer(messages: string | RLMMessage[], opts?: RLMInferOptions): Promise<RLMResult> {
    assertRecordedLlmCall({
      actionType: "rlm.client.infer",
      model: opts?.rootModel,
      purpose: "external_llm",
    });

    const startTime = Date.now();
    const { maxRetries = 3, retryBaseDelay = 1000, retryMaxDelay = 30000 } = this.config;
    const RETRYABLE_PATTERNS = ["timeout", "rate limit", "connection", "503", "429", "econnreset"];

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this.ensureServer();

        if (!this.isReady) {
          this.updateMetrics(Date.now() - startTime, true, true);
          return stubResult();
        }

        const result = await this.sendRequest<RLMResult>("infer", {
          messages: RLMClient.normalizeMessages(messages),
          opts: opts ?? {},
        });

        this.updateMetrics(Date.now() - startTime, true, false);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const isRetryable = RETRYABLE_PATTERNS.some((p) =>
          lastError?.message.toLowerCase().includes(p),
        );

        if (!isRetryable || attempt === maxRetries - 1) {
          this.logger.error(`RLM inference failed after ${attempt + 1} attempts: ${error}`);
          this.updateMetrics(Date.now() - startTime, true, true, lastError.message);
          return stubResult(lastError.message);
        }

        const delay =
          Math.min(retryBaseDelay * 2 ** attempt, retryMaxDelay) * (0.75 + Math.random() * 0.5);
        this.metrics.totalRetries++;
        this.logger.warn(
          `RLM attempt ${attempt + 1}/${maxRetries} failed. Retrying in ${Math.round(delay)}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    this.updateMetrics(Date.now() - startTime, false, false, lastError?.message);
    return stubResult(lastError?.message);
  }

  async getStatus(): Promise<RLMStatusResponse> {
    try {
      await this.ensureServer();
      return await this.sendRequest<RLMStatusResponse>("status");
    } catch {
      return {
        available: false,
        backend: this.config.backend,
        environment: this.config.environment,
        maxIterations: this.config.maxIterations,
        maxDepth: this.config.maxDepth,
      };
    }
  }

  async shutdown(): Promise<void> {
    if (!this.process) return;
    try {
      await this.sendRequest("shutdown");
    } catch {
      /* ignore */
    }
    this.reader?.close();
    this.process?.kill();
    this.process = null;
    this.isReady = false;
    this.isAvailable = false;
  }
}

export function stubResult(error?: string): RLMResult {
  return {
    text: "[RLM STUB] RLM backend not available",
    metadata: { stub: true, error },
  };
}
