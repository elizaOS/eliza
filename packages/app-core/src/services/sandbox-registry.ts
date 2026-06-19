/**
 * SandboxRegistry — self-registers the sandbox container in the shared Redis
 * so the multi-tenant gateways (`gateway-discord`, `gateway-webhook`) can
 * resolve `agent_id -> server URL` and forward inbound platform messages here.
 *
 * This is a deliberate duplicate of `packages/agent/src/runtime/sandbox-registry.ts`:
 * the published cloud image runs the agent runtime entrypoint, which cannot
 * import `@elizaos/app-core` without an `agent -> app-core -> agent` cycle, so
 * the agent copy is the one that executes in a provisioned container. Keep the
 * two copies in lock-step.
 *
 * Two Redis keys are written with a short TTL; a periodic heartbeat refreshes
 * the TTL while the sandbox is alive, and `unregister()` deletes them on
 * graceful shutdown if they still point at this sandbox. If the container
 * crashes, the keys expire naturally and the gateways stop routing to a dead
 * address.
 *
 *   server:<serverName>:url = <serverUrl>   (resolver address)
 *   agent:<agentId>:server  = <serverName>  (agent -> server pointer)
 *
 * Two transports are supported, selected by the URL scheme so the same
 * registry works before and after the managed Redis is migrated off Upstash:
 *   - `http(s)://` — Upstash REST API via `fetch` (the pipeline endpoint
 *     applies both SET-with-EX commands atomically server-side).
 *   - `redis(s)://` — native RESP over a TCP socket (e.g. a Railway Redis
 *     public proxy). Auth is carried inline in the URL, so no separate token
 *     is required.
 */

import net from "node:net";

import { logger } from "@elizaos/core";

/** Hard cap on a single TCP register/refresh round-trip. */
const REGISTRY_TCP_TIMEOUT_MS = 10_000;

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTcpRedisUrl(url: string): boolean {
  return /^rediss?:\/\//i.test(url);
}

export interface SandboxRegistryConfig {
  redisUrl: string;
  /**
   * Bearer token for the Upstash REST transport. Not required (and ignored)
   * for a `redis://` / `rediss://` URL, which carries auth inline.
   */
  redisToken?: string;
  agentId: string;
  serverName: string;
  serverUrl: string;
  /** TTL for both Redis keys in seconds. Keep this at least 3x the heartbeat interval so one missed tick does not expire a healthy sandbox. */
  ttlSeconds: number;
}

export class SandboxRegistry {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly tcp: boolean;

  constructor(private readonly config: SandboxRegistryConfig) {
    this.tcp = isTcpRedisUrl(config.redisUrl);
  }

  async register(): Promise<void> {
    await this.writeKeys();
    logger.info(
      `[sandbox-registry] Registered ${this.config.serverName} -> ${this.config.serverUrl} (agent ${this.config.agentId}, ttl ${this.config.ttlSeconds}s, transport ${this.tcp ? "tcp" : "rest"})`,
    );
  }

  async refresh(): Promise<void> {
    await this.writeKeys();
  }

  async unregister(): Promise<void> {
    const { serverName, serverUrl, agentId } = this.config;
    const serverUrlKey = `server:${serverName}:url`;
    const agentServerKey = `agent:${agentId}:server`;
    const [registeredUrl, registeredServer] = await Promise.all([
      this.get(serverUrlKey),
      this.get(agentServerKey),
    ]);
    const keysToDelete: string[] = [];
    if (registeredUrl === serverUrl) keysToDelete.push(serverUrlKey);
    if (registeredServer === serverName) keysToDelete.push(agentServerKey);
    if (keysToDelete.length > 0) {
      await this.command(["DEL", ...keysToDelete]);
    }
    logger.info(
      `[sandbox-registry] Unregistered ${serverName} (agent ${agentId})`,
    );
  }

  startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      void this.refresh().catch((err) => {
        logger.warn(
          `[sandbox-registry] Heartbeat refresh failed: ${formatErr(err)}`,
        );
      });
    }, intervalMs);

    if (
      typeof this.heartbeatTimer === "object" &&
      "unref" in this.heartbeatTimer
    ) {
      this.heartbeatTimer.unref();
    }
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Atomic two-key write. Both keys must succeed together — partial state
   * would let gateways resolve `agent:X:server` to a stale `server:Y:url`
   * value or miss a routing entry whose other half was just renewed. REST uses
   * the Upstash pipeline endpoint; TCP pipelines both commands on one socket.
   */
  private async writeKeys(): Promise<void> {
    const { serverName, serverUrl, agentId, ttlSeconds } = this.config;
    const ttl = String(ttlSeconds);
    await this.pipeline([
      ["SET", `server:${serverName}:url`, serverUrl, "EX", ttl],
      ["SET", `agent:${agentId}:server`, serverName, "EX", ttl],
    ]);
  }

  private async get(key: string): Promise<string | null> {
    const result = await this.command(["GET", key]);
    return typeof result === "string" ? result : null;
  }

  private async command(args: string[]): Promise<unknown> {
    if (this.tcp) {
      const [reply] = await this.tcpExec([args]);
      return reply;
    }
    const res = await fetch(this.config.redisUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.redisToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      throw new Error(
        `Upstash command failed: ${res.status} ${await res.text()}`,
      );
    }
    const json = (await res.json()) as { result?: unknown; error?: string };
    if (json.error) throw new Error(`Upstash error: ${json.error}`);
    return json.result;
  }

  private async pipeline(commands: string[][]): Promise<void> {
    if (this.tcp) {
      await this.tcpExec(commands);
      return;
    }
    const res = await fetch(`${this.config.redisUrl}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.redisToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    });
    if (!res.ok) {
      throw new Error(
        `Upstash pipeline failed: ${res.status} ${await res.text()}`,
      );
    }
    const json = (await res.json()) as Array<{ error?: string }>;
    if (Array.isArray(json)) {
      for (const entry of json) {
        if (entry?.error) throw new Error(`Upstash error: ${entry.error}`);
      }
    }
  }

  /**
   * Execute one or more commands over a native RESP/TCP connection and return
   * the per-command replies (AUTH/SELECT preamble replies are stripped). One
   * short-lived connection per call keeps the lifecycle trivial — the registry
   * only writes twice per heartbeat, so connection churn is negligible.
   */
  private async tcpExec(commands: string[][]): Promise<unknown[]> {
    const url = new URL(this.config.redisUrl);
    const secure = url.protocol === "rediss:";
    const host = url.hostname;
    const port = url.port ? Number(url.port) : 6379;
    const username = decodeURIComponent(url.username || "");
    const password = decodeURIComponent(url.password || "");
    const db = url.pathname.length > 1 ? url.pathname.slice(1) : "";

    const preamble: string[][] = [];
    if (password) {
      preamble.push(
        username ? ["AUTH", username, password] : ["AUTH", password],
      );
    }
    if (db) preamble.push(["SELECT", db]);
    const all = [...preamble, ...commands];

    // `node:tls` is imported lazily (only for `rediss://`) so the mobile
    // bundle — which never reaches the TCP path — stays free of it.
    const socket: net.Socket = secure
      ? (await import("node:tls")).connect({ host, port, servername: host })
      : net.connect({ host, port });

    return new Promise<unknown[]>((resolve, reject) => {
      let settled = false;
      let buffer = Buffer.alloc(0);

      const finish = (err: Error | null, replies?: unknown[]): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve(replies ?? []);
      };

      socket.setTimeout(REGISTRY_TCP_TIMEOUT_MS, () =>
        finish(new Error("Redis TCP timeout")),
      );
      socket.on("error", (err) => finish(err));
      const onConnect = (): void => {
        socket.write(encodeRespCommands(all));
      };
      socket.once(secure ? "secureConnect" : "connect", onConnect);

      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const parsed = parseRespReplies(buffer, all.length);
        if (!parsed) return; // need more bytes
        const firstErr = parsed.replies.find((r) => r instanceof RespError) as
          | RespError
          | undefined;
        if (firstErr) {
          finish(new Error(`Redis error: ${firstErr.message}`));
          return;
        }
        // Strip the AUTH/SELECT preamble replies; return only command results.
        finish(null, parsed.replies.slice(preamble.length));
      });
    });
  }
}

/** A RESP `-ERR ...` reply, kept distinct so callers can detect failures. */
class RespError {
  constructor(public readonly message: string) {}
}

/** Encode commands as a single RESP2 buffer (inline pipelining). */
function encodeRespCommands(commands: string[][]): Buffer {
  const parts: Buffer[] = [];
  for (const args of commands) {
    parts.push(Buffer.from(`*${args.length}\r\n`));
    for (const arg of args) {
      const bytes = Buffer.from(arg);
      parts.push(Buffer.from(`$${bytes.length}\r\n`));
      parts.push(bytes);
      parts.push(Buffer.from("\r\n"));
    }
  }
  return Buffer.concat(parts);
}

/**
 * Parse exactly `expected` top-level RESP replies from `buffer`. Returns the
 * replies (with `-ERR` mapped to {@link RespError}) once all are present, or
 * `null` when more bytes are still needed.
 */
function parseRespReplies(
  buffer: Buffer,
  expected: number,
): { replies: unknown[] } | null {
  const replies: unknown[] = [];
  let offset = 0;

  const parseOne = (): { value: unknown; next: number } | null => {
    if (offset >= buffer.length) return null;
    const type = buffer[offset];
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd === -1) return null;
    const line = buffer.toString("utf8", offset + 1, lineEnd);
    const afterLine = lineEnd + 2;
    switch (type) {
      case 0x2b: // '+' simple string
        return { value: line, next: afterLine };
      case 0x2d: // '-' error
        return { value: new RespError(line), next: afterLine };
      case 0x3a: // ':' integer
        return { value: Number(line), next: afterLine };
      case 0x5f: // '_' RESP3 null
        return { value: null, next: afterLine };
      case 0x24: {
        // '$' bulk string
        const len = Number(line);
        if (len === -1) return { value: null, next: afterLine };
        const end = afterLine + len;
        if (buffer.length < end + 2) return null; // bulk + trailing CRLF
        return {
          value: buffer.toString("utf8", afterLine, end),
          next: end + 2,
        };
      }
      default:
        return {
          value: new RespError(
            `unsupported RESP type ${String.fromCharCode(type)}`,
          ),
          next: afterLine,
        };
    }
  };

  while (replies.length < expected) {
    const savedOffset = offset;
    const one = parseOne();
    if (!one) {
      offset = savedOffset;
      return null;
    }
    replies.push(one.value);
    offset = one.next;
  }
  return { replies };
}

/**
 * Reads the SANDBOX_REGISTRY_* and SANDBOX_* env vars and returns a fully
 * wired `SandboxRegistry`, or `null` if the sandbox context is not
 * configured (e.g. local dev, non-Hetzner deployment). Caller must call
 * `register()` and `startHeartbeat(...)` after a successful boot. A `redis://`
 * URL needs no token (auth is inline); a `http(s)://` Upstash URL requires one.
 */
export function buildSandboxRegistryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  ttlSeconds = 90,
): SandboxRegistry | null {
  const redisUrl = env.SANDBOX_REGISTRY_REDIS_URL?.trim();
  const redisToken = env.SANDBOX_REGISTRY_REDIS_TOKEN?.trim();
  const agentId = env.SANDBOX_AGENT_ID?.trim();
  const serverName = env.SANDBOX_SERVER_NAME?.trim();
  const serverUrl = env.SANDBOX_PUBLIC_URL?.trim();

  const tcp = !!redisUrl && isTcpRedisUrl(redisUrl);
  if (
    !redisUrl ||
    (!tcp && !redisToken) ||
    !agentId ||
    !serverName ||
    !serverUrl
  ) {
    return null;
  }

  return new SandboxRegistry({
    redisUrl,
    redisToken,
    agentId,
    serverName,
    serverUrl,
    ttlSeconds,
  });
}
