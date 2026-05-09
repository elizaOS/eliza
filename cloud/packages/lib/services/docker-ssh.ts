/**
 * DockerSSHClient — Reusable SSH client wrapper for Docker node operations.
 *
 * Provides connection pooling, command execution with timeouts, and proper
 * cleanup.  Designed for orchestrating Docker containers on remote Hetzner
 * VPS nodes via SSH.
 *
 * ## SSH Key Loading (cloud-deployable)
 *
 * The client supports two mechanisms for loading SSH private keys, checked
 * in order of precedence:
 *
 * 1. **Environment variable (recommended for serverless/Workers):**
 *    `AGENT_SSH_KEY` — base64-encoded private key material.
 *    Set via `wrangler secret put` or your secrets manager.
 *    Generate with: `base64 -w0 < ~/.ssh/id_ed25519`
 *
 * 2. **Filesystem path (traditional servers):**
 *    `AGENT_SSH_KEY_PATH` — path to the PEM file on disk.
 *    Defaults to `~/.ssh/id_ed25519` if neither env var is set.
 *
 * Reference: eliza-cloud/backend/services/container-orchestrator.ts (executeSSH)
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { type ClientChannel, Client as SSHClient } from "ssh2";
import { containersEnv } from "@/lib/config/containers-env";
import { logger } from "@/lib/utils/logger";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_SSH_PORT = 22;
const DEFAULT_SSH_USERNAME = containersEnv.sshUser();

/**
 * Default path to the SSH private key for authenticating to Docker nodes.
 * Used when no base64 key is provided via env. Defaults to ~/.ssh/id_ed25519
 * if neither CONTAINERS_SSH_KEY_PATH nor the legacy AGENT_SSH_KEY_PATH is set.
 *
 * The base64-encoded key is read at call-time inside resolvePrivateKey() so
 * that tests can manipulate process.env between calls.
 */
const DEFAULT_SSH_KEY_PATH =
  containersEnv.sshKeyPath() ?? path.join(os.homedir(), ".ssh", "id_ed25519");

/** TCP / handshake timeout for new connections (ms). */
const CONNECTION_TIMEOUT_MS = 10_000;

/** Default timeout for a single command execution (ms). */
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DockerSSHConfig {
  hostname: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  /** Raw private key buffer — takes precedence over privateKeyPath when provided. */
  privateKey?: Buffer;
  /** Expected host key fingerprint (SHA256 base64). If set, connections to hosts with mismatched keys are rejected. */
  hostKeyFingerprint?: string;
}

// ---------------------------------------------------------------------------
// DockerSSHClient
// ---------------------------------------------------------------------------

export class DockerSSHClient {
  private readonly hostname: string;
  private readonly port: number;
  private readonly username: string;
  private readonly privateKeyPath: string;
  private readonly hostKeyFingerprint: string | undefined;

  private client: SSHClient | null = null;
  private connected = false;

  // ---- Static connection pool ------------------------------------------

  private static pool = new Map<string, DockerSSHClient>();
  private lastActivityMs = 0;

  /** Idle timeout — pooled connections unused for this long are auto-closed. */
  private static readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  /** Max number of concurrent SSH connections in pool to prevent unbounded growth. */
  private static readonly MAX_POOL_SIZE = 50;

  /**
   * Get (or create) a pooled client for the given hostname.
   * Uses default SSH port / user / key unless the pool entry was created
   * with different settings earlier.
   *
   * Pool key includes hostname + port + username to avoid collisions when
   * two nodes share a hostname but use different SSH ports or users.
   *
   * When hostKeyFingerprint is provided, the pooled client will reject
   * connections if the remote key doesn't match. When omitted, TOFU
   * (trust-on-first-use) applies: the fingerprint is logged on first connect.
   */
  static getClient(
    hostname: string,
    port?: number,
    hostKeyFingerprint?: string,
    username?: string,
  ): DockerSSHClient {
    const effectivePort = port ?? DEFAULT_SSH_PORT;
    const effectiveUser = username ?? DEFAULT_SSH_USERNAME;
    const poolKey = `${hostname}:${effectivePort}:${effectiveUser}`;
    let client = DockerSSHClient.pool.get(poolKey);
    if (client) {
      // Evict stale connections (handles serverless cold-start reconnections)
      if (
        client.connected &&
        Date.now() - client.lastActivityMs > DockerSSHClient.IDLE_TIMEOUT_MS
      ) {
        logger.info(`[docker-ssh] Evicting idle connection for ${poolKey}`);
        client.disconnect().catch(() => {});
        DockerSSHClient.pool.delete(poolKey);
        client = undefined;
      }
      // Evict if fingerprint requirements changed
      if (client && hostKeyFingerprint && client.pinnedFingerprint !== hostKeyFingerprint) {
        logger.info(`[docker-ssh] Evicting pooled connection for ${poolKey} — fingerprint changed`);
        client.disconnect().catch(() => {});
        DockerSSHClient.pool.delete(poolKey);
        client = undefined;
      }
    }
    if (!client) {
      if (DockerSSHClient.pool.size >= DockerSSHClient.MAX_POOL_SIZE) {
        let oldestKey = "";
        let oldestTime = Infinity;
        for (const [k, v] of DockerSSHClient.pool.entries()) {
          if (v.lastActivityMs < oldestTime) {
            oldestTime = v.lastActivityMs;
            oldestKey = k;
          }
        }
        if (oldestKey) {
          logger.warn(
            `[docker-ssh] Pool max size (${DockerSSHClient.MAX_POOL_SIZE}) reached, evicting oldest connection: ${oldestKey}`,
          );
          DockerSSHClient.pool
            .get(oldestKey)
            ?.disconnect()
            .catch(() => {});
          DockerSSHClient.pool.delete(oldestKey);
        }
      }

      client = new DockerSSHClient({
        hostname,
        port: effectivePort,
        username: effectiveUser,
        hostKeyFingerprint,
      });
      client.lastActivityMs = Date.now();
      DockerSSHClient.pool.set(poolKey, client);
    }
    return client;
  }

  /** Disconnect and remove every pooled client. */
  static async disconnectAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const client of DockerSSHClient.pool.values()) {
      promises.push(
        client.disconnect().catch((err) => {
          logger.warn(
            `[docker-ssh] error disconnecting pooled client ${client.hostname}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }),
      );
    }
    await Promise.all(promises);
    DockerSSHClient.pool.clear();
  }

  // ---- Constructor -----------------------------------------------------

  private readonly privateKey: Buffer;

  constructor(config: DockerSSHConfig) {
    this.hostname = config.hostname;
    this.port = config.port ?? DEFAULT_SSH_PORT;
    this.username = config.username ?? DEFAULT_SSH_USERNAME;
    this.privateKeyPath = config.privateKeyPath ?? DEFAULT_SSH_KEY_PATH;
    this.hostKeyFingerprint = config.hostKeyFingerprint;

    this.privateKey = config.privateKey ?? DockerSSHClient.resolvePrivateKey(this.privateKeyPath);
  }

  // ---- Private key resolution ------------------------------------------

  /**
   * Resolve the SSH private key from available sources.
   *
   * Priority:
   * 1. AGENT_SSH_KEY env var (base64-encoded) — works on serverless/Workers
   * 2. Filesystem path (AGENT_SSH_KEY_PATH or default ~/.ssh/id_ed25519)
   *
   * Never logs or includes the key material in error messages.
   */
  private static resolvePrivateKey(keyPath: string): Buffer {
    // 1. Try env var first (serverless-friendly).
    // Read at call-time (not module-level) so runtime env changes are respected.
    const sshKeyEnv = containersEnv.sshKey();
    if (sshKeyEnv) {
      try {
        const decoded = Buffer.from(sshKeyEnv, "base64");
        if (decoded.length === 0) {
          throw new Error("Decoded key is empty");
        }
        logger.info("[docker-ssh] SSH key loaded from CONTAINERS_SSH_KEY env var");
        return decoded;
      } catch (err) {
        throw new Error(
          `[docker-ssh] Failed to decode CONTAINERS_SSH_KEY env var (expected base64): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 2. Fall back to filesystem
    try {
      const key = fs.readFileSync(keyPath);
      logger.info("[docker-ssh] SSH key loaded from filesystem");
      return key;
    } catch (err) {
      // Redact the full path in production — only show the basename.
      // The inner error (e.g. ENOENT) may also contain the full path,
      // so we replace it with the redacted form.
      const safePath = keyPath.split("/").pop() ?? "unknown";
      const innerMsg = err instanceof Error ? err.message : String(err);
      const safeInnerMsg = keyPath ? innerMsg.replaceAll(keyPath, `.../${safePath}`) : innerMsg;
      throw new Error(
        `[docker-ssh] Failed to load SSH key (file: .../${safePath}). ` +
          `Set CONTAINERS_SSH_KEY env var (base64) for serverless deployments. ` +
          `(${safeInnerMsg})`,
      );
    }
  }

  // ---- Public API ------------------------------------------------------

  /**
   * Establish the SSH connection.  Resolves once the `ready` event fires.
   * If the client is already connected this is a no-op.
   */
  async connect(): Promise<void> {
    if (this.connected && this.client) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const conn = new SSHClient();

      const timeout = setTimeout(() => {
        conn.end();
        reject(
          new Error(
            `[docker-ssh] Connection to ${this.hostname}:${this.port} timed out after ${CONNECTION_TIMEOUT_MS}ms`,
          ),
        );
      }, CONNECTION_TIMEOUT_MS);

      conn.on("ready", () => {
        clearTimeout(timeout);
        this.client = conn;
        this.connected = true;
        logger.info(`[docker-ssh] Connected to ${this.hostname}:${this.port}`);
        resolve();
      });

      conn.on("error", (err) => {
        clearTimeout(timeout);
        this.connected = false;
        this.client = null;
        reject(new Error(`[docker-ssh] Connection error for ${this.hostname}: ${err.message}`));
      });

      conn.on("close", () => {
        this.connected = false;
        this.client = null;
      });

      conn.connect({
        host: this.hostname,
        port: this.port,
        username: this.username,
        privateKey: this.privateKey,
        readyTimeout: CONNECTION_TIMEOUT_MS,
        hostVerifier: (key: Buffer) => {
          const fingerprint = crypto.createHash("sha256").update(key).digest("base64");
          if (!this.hostKeyFingerprint) {
            // No fingerprint configured — TOFU: accept and log at warn for operator visibility
            logger.warn(
              `[docker-ssh] Host key for ${this.hostname}: SHA256:${fingerprint} (not verified — set hostKeyFingerprint to pin)`,
            );
            return true;
          }
          if (
            normalizeSshFingerprint(fingerprint) !==
            normalizeSshFingerprint(this.hostKeyFingerprint)
          ) {
            logger.error(
              `[docker-ssh] HOST KEY MISMATCH for ${this.hostname}! Expected SHA256:${this.hostKeyFingerprint}, got SHA256:${fingerprint}`,
            );
            return false;
          }
          return true;
        },
      });
    });
  }

  /**
   * Execute a shell command over the SSH connection.
   *
   * @param command  – Shell command string.
   * @param timeoutMs – Per-command timeout (defaults to 60 s).
   * @returns Combined stdout + stderr output.
   */
  async exec(command: string, timeoutMs?: number): Promise<string> {
    // Auto-connect if needed
    if (!this.connected || !this.client) {
      await this.connect();
    }
    this.lastActivityMs = Date.now();

    const effectiveTimeout = timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const client = this.client!;

    return new Promise<string>((resolve, reject) => {
      let output = "";
      let settled = false;
      // Stream ref captured by the timeout closure so it can signal the
      // remote process to terminate (prevents leaked server-side processes).
      let stream: ClientChannel | undefined;

      // Redact command in error messages to avoid leaking secrets
      // (e.g. env vars passed via `docker run -e`). Show only the first
      // token (the binary name) for operator diagnostics.
      const cmdFirstToken = command.split(/\s+/)[0] ?? "unknown";

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          // Close the SSH channel to signal the remote process (SIGHUP)
          // and prevent orphaned server-side processes after timeout.
          try {
            stream?.close();
          } catch {
            /* best-effort */
          }
          reject(
            new Error(
              `[docker-ssh] Command timed out after ${effectiveTimeout}ms on ${this.hostname}: ${cmdFirstToken} [redacted]`,
            ),
          );
        }
      }, effectiveTimeout);

      client.exec(command, (err, s) => {
        stream = s;

        if (err) {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(new Error(`[docker-ssh] exec error on ${this.hostname}: ${err.message}`));
          }
          return;
        }

        stream.on("data", (data: Buffer) => {
          output += data.toString();
        });

        stream.stderr.on("data", (data: Buffer) => {
          const text = data.toString();
          output += output && !output.endsWith("\n") ? `\n[stderr] ${text}` : `[stderr] ${text}`;
        });

        stream.on("close", (code: number) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;

          if (code !== 0) {
            reject(
              new Error(
                `[docker-ssh] Command exited with code ${code} on ${this.hostname}: ${output.trim()}`,
              ),
            );
          } else {
            resolve(output);
          }
        });

        stream.on("error", (streamErr: Error) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(
              new Error(`[docker-ssh] stream error on ${this.hostname}: ${streamErr.message}`),
            );
          }
        });
      });
    });
  }

  /**
   * Open a streaming exec channel — used for long-running commands like
   * `docker logs --follow` where the caller wants every chunk as it
   * arrives. The handlers run on each stdout / stderr write; resolve()
   * fires once the remote process exits (or the AbortSignal fires).
   *
   * The channel is forcibly closed when the AbortSignal aborts so the
   * remote process receives SIGHUP — important for `docker logs -f`
   * which otherwise lingers indefinitely.
   */
  async execStream(
    command: string,
    handlers: {
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<{ exitCode: number | null }> {
    if (!this.connected || !this.client) {
      await this.connect();
    }
    this.lastActivityMs = Date.now();
    const client = this.client!;

    return new Promise<{ exitCode: number | null }>((resolve, reject) => {
      let stream: ClientChannel | undefined;
      let settled = false;

      const cleanup = () => {
        try {
          stream?.close();
        } catch {
          /* best-effort */
        }
      };

      if (handlers.signal) {
        if (handlers.signal.aborted) {
          settled = true;
          cleanup();
          resolve({ exitCode: null });
          return;
        }
        handlers.signal.addEventListener(
          "abort",
          () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({ exitCode: null });
          },
          { once: true },
        );
      }

      client.exec(command, (err, s) => {
        if (err) {
          if (!settled) {
            settled = true;
            reject(new Error(`[docker-ssh] execStream error on ${this.hostname}: ${err.message}`));
          }
          return;
        }
        stream = s;

        s.on("data", (data: Buffer) => {
          this.lastActivityMs = Date.now();
          handlers.onStdout?.(data.toString());
        });
        s.stderr.on("data", (data: Buffer) => {
          this.lastActivityMs = Date.now();
          handlers.onStderr?.(data.toString());
        });
        s.on("close", (code: number) => {
          if (settled) return;
          settled = true;
          resolve({ exitCode: typeof code === "number" ? code : null });
        });
        s.on("error", (streamErr: Error) => {
          if (settled) return;
          settled = true;
          reject(
            new Error(
              `[docker-ssh] execStream channel error on ${this.hostname}: ${streamErr.message}`,
            ),
          );
        });
      });
    });
  }

  /**
   * Gracefully close the SSH connection.
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        this.client.end();
      } catch {
        // swallow – best-effort
      }
      this.client = null;
      this.connected = false;
      logger.info(`[docker-ssh] Disconnected from ${this.hostname}`);
    }
  }

  /** Whether the underlying SSH session is open. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** The pinned host key fingerprint (if configured). */
  get pinnedFingerprint(): string | undefined {
    return this.hostKeyFingerprint;
  }
}

function normalizeSshFingerprint(fingerprint: string): string {
  return fingerprint
    .trim()
    .replace(/^SHA256:/, "")
    .replace(/=+$/, "");
}
