/**
 * Out-of-process llama-server backend for DFlash speculative decoding.
 *
 * DFlash needs llama-server flags (`-md`, `--spec-type dflash`) that the
 * in-process node-llama-cpp API does not expose. This backend is deliberately
 * small: spawn a compatible llama-server, wait for health, and use the
 * OpenAI-compatible chat endpoint so llama-server applies the model chat
 * template and reasoning controls consistently with LlamaChatSession.
 */
export interface DflashServerPlan {
  targetModelPath: string;
  drafterModelPath: string;
  contextSize: number;
  draftContextSize: number;
  draftMin: number;
  draftMax: number;
  gpuLayers: number | "auto";
  draftGpuLayers: number | "auto";
  disableThinking: boolean;
}
export interface DflashGenerateArgs {
  prompt: string;
  stopSequences?: string[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}
export interface DflashRuntimeStatus {
  enabled: boolean;
  required: boolean;
  binaryPath: string | null;
  reason: string;
  /**
   * Kernels actually compiled into the installed binary, parsed from
   * CAPABILITIES.json next to the managed binary. Null for older/manual
   * binaries that do not ship the probe file.
   */
  capabilities: DflashBinaryCapabilities | null;
}
export interface DflashBinaryCapabilities {
  target: string;
  platform: string;
  arch: string;
  backend: string;
  builtAt: string;
  fork: string;
  forkCommit: string;
  kernels: {
    dflash: boolean;
    turbo3: boolean;
    turbo4: boolean;
    turbo3_tcq: boolean;
    qjl_full: boolean;
    polarquant: boolean;
    lookahead: boolean;
    ngramDraft: boolean;
  };
  binaries: string[];
}
export declare function readDflashBinaryCapabilities(): DflashBinaryCapabilities | null;
export declare function dflashEnabled(): boolean;
export declare function dflashRequired(): boolean;
export declare function resolveDflashBinary(): string | null;
export declare function getDflashRuntimeStatus(): DflashRuntimeStatus;
/** Cumulative speculative-decoding counters scraped from llama-server `/metrics`. */
export interface DflashMetricsSnapshot {
  drafted: number;
  accepted: number;
  decoded: number;
  acceptanceRate: number;
}
/**
 * Parse the cumulative speculative-decoding counters from llama-server's
 * Prometheus-format `/metrics` endpoint. Returns null when none of the
 * expected counters are present (older builds, server started without
 * `--metrics`, drafter not yet engaged).
 */
export declare function parseDflashMetrics(
  text: string,
): DflashMetricsSnapshot | null;
export declare class DflashLlamaServer {
  private child;
  private baseUrl;
  private stderrTail;
  private loadedPlan;
  hasLoadedModel(): boolean;
  currentModelPath(): string | null;
  start(plan: DflashServerPlan): Promise<void>;
  stop(): Promise<void>;
  generate(args: DflashGenerateArgs): Promise<string>;
  /**
   * Scrape llama-server's `/metrics` endpoint and return the current
   * cumulative speculative-decoding counters. Returns null when the
   * server isn't running, the endpoint isn't reachable, or the response
   * doesn't contain the expected counters.
   */
  getMetrics(): Promise<DflashMetricsSnapshot | null>;
  private captureLog;
  private waitUntilReady;
}
export declare const dflashLlamaServer: DflashLlamaServer;
//# sourceMappingURL=dflash-server.d.ts.map
