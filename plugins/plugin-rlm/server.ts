/**
 * RLM IPC server using Node.js net.createServer.
 *
 * Provides a TCP-based IPC server that handles JSON-line requests,
 * matching the Python RLMServer (server.py) protocol.
 *
 * Protocol:
 * - Communication via TCP using newline-delimited JSON
 * - Request:  `{"id": number, "type": "status"|"infer"|"shutdown", "params"?: object}`
 * - Response: `{"id": number, "result"?: any, "error"?: string}`
 *
 * Usage:
 *   const server = createRLMServer(client, { host: "127.0.0.1" });
 *   await server.start(9100);
 *   // ... server is running ...
 *   await server.stop();
 */

import * as net from "node:net";
import * as readline from "node:readline";

import type { RLMClient } from "./client";
import type { RLMInferOptions, RLMMessage } from "./types";

// ============================================================================
// Types
// ============================================================================

/** Options for creating an RLM IPC server. */
export interface RLMServerOptions {
  /** Bind address (default: "127.0.0.1"). */
  host?: string;
  /** Called for each incoming request (for logging/monitoring). */
  onRequest?: (request: RLMServerRequest) => void;
  /** Called on server or connection errors. */
  onError?: (error: Error) => void;
}

/** Incoming IPC request. */
export interface RLMServerRequest {
  /** Unique request identifier for matching responses. */
  id: number;
  /** Request type: "status", "infer", or "shutdown". */
  type: "status" | "infer" | "shutdown";
  /** Request parameters (required for "infer"). */
  params?: Record<string, unknown>;
}

/** Outgoing IPC response. */
export interface RLMServerResponse {
  /** Request ID this response corresponds to. */
  id: number;
  /** Successful result (mutually exclusive with error). */
  result?: unknown;
  /** Error message if the request failed. */
  error?: string;
}

// ============================================================================
// RLMServer
// ============================================================================

/**
 * TCP-based IPC server for RLM.
 *
 * Wraps an RLMClient and exposes it over a TCP socket using
 * newline-delimited JSON. Supports concurrent connections.
 */
export class RLMServer {
  private client: RLMClient;
  private server: net.Server | null = null;
  private options: RLMServerOptions;
  private connections: Set<net.Socket> = new Set();
  private _running = false;
  private _port = 0;

  constructor(client: RLMClient, options?: RLMServerOptions) {
    this.client = client;
    this.options = options ?? {};
  }

  /** Whether the server is currently running. */
  get running(): boolean {
    return this._running;
  }

  /** The actual port the server is bound to (0 if not started). */
  get port(): number {
    return this._port;
  }

  /** Number of active client connections. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /**
   * Start the IPC server on the given port.
   *
   * @param port - TCP port to bind (use 0 for auto-assign)
   * @param host - Bind address (overrides options.host, default "127.0.0.1")
   * @returns Resolves when the server is listening
   */
  async start(port: number, host?: string): Promise<void> {
    if (this._running) return;

    const bindHost = host ?? this.options.host ?? "127.0.0.1";

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on("error", (err) => {
        this.options.onError?.(err);
        if (!this._running) {
          reject(err);
        }
      });

      this.server.listen(port, bindHost, () => {
        this._running = true;
        const addr = this.server?.address();
        if (addr && typeof addr === "object") {
          this._port = addr.port;
        }
        resolve();
      });
    });
  }

  /**
   * Stop the IPC server and close all connections.
   *
   * @returns Resolves when the server is fully stopped
   */
  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;

    // Close all active connections
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();

    return new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          this._port = 0;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // --------------------------------------------------------------------------
  // Connection handling
  // --------------------------------------------------------------------------

  private handleConnection(socket: net.Socket): void {
    this.connections.add(socket);

    const rl = readline.createInterface({ input: socket });

    rl.on("line", (line: string) => {
      void this.processLine(socket, line);
    });

    socket.on("close", () => {
      this.connections.delete(socket);
      rl.close();
    });

    socket.on("error", (err) => {
      this.options.onError?.(err);
      this.connections.delete(socket);
    });
  }

  private async processLine(socket: net.Socket, line: string): Promise<void> {
    try {
      const request = JSON.parse(line) as RLMServerRequest;
      this.options.onRequest?.(request);
      const response = await this.handleRequest(request);

      if (!socket.destroyed) {
        socket.write(`${JSON.stringify(response)}\n`);
      }
    } catch (e) {
      const errorResponse: RLMServerResponse = {
        id: 0,
        error: `Invalid request: ${e instanceof Error ? e.message : String(e)}`,
      };
      if (!socket.destroyed) {
        socket.write(`${JSON.stringify(errorResponse)}\n`);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Request handlers
  // --------------------------------------------------------------------------

  private async handleRequest(request: RLMServerRequest): Promise<RLMServerResponse> {
    const requestId = request.id ?? 0;

    try {
      switch (request.type) {
        case "status": {
          const status = await this.client.getStatus();
          return { id: requestId, result: status };
        }

        case "infer": {
          const params = request.params ?? {};
          const messages = (params.messages ?? params.prompt ?? "") as string | RLMMessage[];
          const opts = (params.opts ?? {}) as RLMInferOptions;
          const result = await this.client.infer(messages, opts);
          return { id: requestId, result };
        }

        case "shutdown": {
          // Schedule shutdown after response is sent
          setTimeout(() => {
            void this.stop();
          }, 100);
          return { id: requestId, result: { shutdown: true } };
        }

        default:
          return {
            id: requestId,
            error: `Unknown request type: ${(request as { type: string }).type}`,
          };
      }
    } catch (e) {
      return {
        id: requestId,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an RLM IPC server.
 *
 * @param client - RLM client instance to handle requests
 * @param options - Server configuration options
 * @returns RLMServer instance (call .start(port) to begin listening)
 */
export function createRLMServer(client: RLMClient, options?: RLMServerOptions): RLMServer {
  return new RLMServer(client, options);
}
