/**
 * SandboxRegistry — self-registers a cloud-provisioned container in the shared
 * Redis so the multi-tenant gateways (`gateway-discord`, `gateway-webhook`) can
 * resolve `agent_id -> server URL` and forward inbound platform messages to
 * THIS container.
 *
 * It writes two Redis keys with a short TTL; a periodic heartbeat refreshes the
 * TTL while the container is alive, and `unregister()` deletes them on graceful
 * shutdown if they still point at this container. If the container crashes, the
 * keys expire naturally and the gateways stop routing to a dead address.
 *
 *   server:<serverName>:url = <serverUrl>   (resolver address)
 *   agent:<agentId>:server  = <serverName>  (agent -> server pointer)
 *
 * Two transports are supported, selected by the URL scheme so the same registry
 * works before and after the managed Redis is migrated off Upstash:
 *   - `http(s)://` — Upstash REST API via `fetch` (the pipeline endpoint applies
 *     both SET-with-EX commands atomically server-side).
 *   - `redis(s)://` — native RESP over a TCP socket (e.g. a Railway Redis public
 *     proxy). Auth is carried inline in the URL, so no separate token is
 *     required. This mirrors what the gateways already do (`gateway-discord` /
 *     `gateway-webhook` both speak native TCP Redis).
 * Neither path adds a runtime dependency (this module is also bundled for
 * mobile via the agent): REST uses `fetch`, TCP uses the `node:net` builtin.
 * TCP replies are byte-capped: a declared bulk string above 1 MiB fails closed
 * instead of concatenating until the 10s socket timeout.
 */

import net from "node:net";

import { ElizaError, logger } from "@elizaos/core";

/** Hard cap on a single TCP register/refresh round-trip. */
const REGISTRY_TCP_TIMEOUT_MS = 10_000;
const MAX_REGISTRY_TCP_BYTES = 1_048_576;

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTcpRedisUrl(url: string): boolean {
  return /^rediss?:\/\//i.test(url);
}

export class SandboxRegistryRedisUrlError extends ElizaError {
  constructor(cause: unknown) {
    super("Sandbox registry Redis URL has malformed userinfo encoding", {
      code: "SANDBOX_REGISTRY_REDIS_USERINFO_INVALID",
      cause,
    });
  }
}

/** Percent-decode Redis URL userinfo or reject malformed credentials. */
export function decodeRedisUrlUserinfo(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch (cause) {
    // error-policy:J2 preserve the URIError while adding the registry boundary.
    throw new SandboxRegistryRedisUrlError(cause);
  }
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
  /**
   * TTL for both Redis keys in seconds. Keep this at least 3x the heartbeat
   * interval so one missed tick does not expire a healthy container.
   */
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
    const json: unknown = await res.json();
    if (!Array.isArray(json) || json.length !== commands.length) {
      throw new Error("Upstash pipeline returned an invalid response");
    }
    for (const entry of json) {
      if (typeof entry !== "object" || entry === null) {
        throw new Error("Upstash pipeline returned an invalid response");
      }
      const result = Reflect.get(entry, "result");
      const error = Reflect.get(entry, "error");
      if (typeof error === "string" && error.length > 0) {
        throw new Error(`Upstash error: ${error}`);
      }
      if (result !== "OK") {
        throw new Error("Upstash pipeline returned an invalid response");
      }
    }
  }

  /**
   * Execute one or more commands over a native RESP/TCP connection and return
   * the per-command replies (AUTH/SELECT preamble replies are stripped). One
   * short-lived connection per call keeps the lifecycle trivial — the registry
   * only writes twice per heartbeat (every 30s), so connection churn is
   * negligible and there is no socket to leak if the container is killed.
   */
  private async tcpExec(commands: string[][]): Promise<unknown[]> {
    const url = new URL(this.config.redisUrl);
    const secure = url.protocol === "rediss:";
    const host = url.hostname;
    const port = url.port ? Number(url.port) : 6379;
    const username = decodeRedisUrlUserinfo(url.username || "");
    const password = decodeRedisUrlUserinfo(url.password || "");
    const db = url.pathname.length > 1 ? url.pathname.slice(1) : "";

    const preamble: string[][] = [];
    if (password) {
      // Redis 6+ ACL AUTH takes an optional username; the default user accepts
      // the single-arg form too. Send the username only when it is explicit.
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
      const buffer = Buffer.allocUnsafe(MAX_REGISTRY_TCP_BYTES);
      let receivedBytes = 0;
      const parser = new RespReplyParser(buffer, all.length);

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
        if (receivedBytes + chunk.length > MAX_REGISTRY_TCP_BYTES) {
          finish(
            new ElizaError(
              `Sandbox registry TCP reply exceeded ${MAX_REGISTRY_TCP_BYTES} bytes`,
              { code: "SANDBOX_REGISTRY_TCP_REPLY_TOO_LARGE" },
            ),
          );
          return;
        }
        chunk.copy(buffer, receivedBytes);
        receivedBytes += chunk.length;
        const parsed = parser.parse(receivedBytes);
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
 * `null` when more bytes are still needed. Supports the reply types Redis
 * returns for SET/GET/DEL/AUTH/SELECT: simple string, error, integer, bulk
 * string (and null bulk), plus RESP3 null.
 */
class RespReplyParser {
  private readonly replies: unknown[] = [];
  private offset = 0;
  private lineSearchOffset = 0;
  private pendingBulk: { start: number; end: number } | null = null;

  constructor(
    private readonly buffer: Buffer,
    private readonly expected: number,
  ) {}

  parse(receivedBytes: number): { replies: unknown[] } | null {
    while (this.replies.length < this.expected) {
      if (this.pendingBulk) {
        if (receivedBytes < this.pendingBulk.end + 2) return null;
        if (
          this.buffer[this.pendingBulk.end] !== 0x0d ||
          this.buffer[this.pendingBulk.end + 1] !== 0x0a
        ) {
          this.replies.push(
            new RespError("bulk string has invalid terminator"),
          );
        } else {
          this.replies.push(
            this.buffer.toString(
              "utf8",
              this.pendingBulk.start,
              this.pendingBulk.end,
            ),
          );
        }
        this.offset = this.pendingBulk.end + 2;
        this.lineSearchOffset = this.offset;
        this.pendingBulk = null;
        if (this.replies.at(-1) instanceof RespError) {
          return { replies: this.replies };
        }
        continue;
      }

      if (this.offset >= receivedBytes) return null;
      const lineEnd = this.buffer.indexOf(
        "\r\n",
        this.lineSearchOffset,
        "utf8",
      );
      if (lineEnd === -1 || lineEnd >= receivedBytes) {
        this.lineSearchOffset = Math.max(this.offset, receivedBytes - 1);
        return null;
      }

      const type = this.buffer[this.offset];
      const line = this.buffer.toString("utf8", this.offset + 1, lineEnd);
      const afterLine = lineEnd + 2;
      this.offset = afterLine;
      this.lineSearchOffset = afterLine;

      if (type === 0x2b) this.replies.push(line);
      else if (type === 0x2d) this.replies.push(new RespError(line));
      else if (type === 0x5f) this.replies.push(null);
      else if (type === 0x3a) {
        const value = /^-?(?:0|[1-9]\d*)$/.test(line)
          ? Number(line)
          : Number.NaN;
        this.replies.push(
          Number.isSafeInteger(value)
            ? value
            : new RespError(`invalid integer ${line}`),
        );
      } else if (type === 0x24) {
        if (line === "-1") {
          this.replies.push(null);
          continue;
        }
        const length = /^(?:0|[1-9]\d*)$/.test(line)
          ? Number(line)
          : Number.NaN;
        if (!Number.isSafeInteger(length) || length > MAX_REGISTRY_TCP_BYTES) {
          this.replies.push(
            new RespError(`bulk string length ${line} exceeds TCP budget`),
          );
          return { replies: this.replies };
        }
        this.pendingBulk = { start: afterLine, end: afterLine + length };
      } else {
        this.replies.push(
          new RespError(`unsupported RESP type ${String.fromCharCode(type)}`),
        );
      }
      if (this.replies.at(-1) instanceof RespError) {
        return { replies: this.replies };
      }
    }
    return { replies: this.replies };
  }
}

/**
 * Reads the SANDBOX_REGISTRY_* and SANDBOX_* env vars and returns a fully
 * wired `SandboxRegistry`, or `null` if the sandbox context is not configured
 * (e.g. local dev, non-Hetzner deployment). Caller must call `register()` and
 * `startHeartbeat(...)` after a successful boot.
 *
 * This is the FEATURE FLAG for container self-registration: when the required
 * env vars are absent (every non-provisioned runtime), this returns null and
 * the runtime behaves exactly as before. Only a cloud-provisioned container
 * carrying the full SANDBOX_REGISTRY_* set will register. A `redis://` URL
 * needs no token (auth is inline); a `http(s)://` Upstash URL requires one.
 */
export function buildSandboxRegistryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  ttlSeconds = 90,
): SandboxRegistry | null {
  const redisUrl = env.SANDBOX_REGISTRY_REDIS_URL?.trim();
  const redisToken = env.SANDBOX_REGISTRY_REDIS_TOKEN?.trim();
  // The routing key MUST be the platform character_id (SANDBOX_ROUTE_AGENT_ID)
  // so it matches what the gateways resolve. Fall back to the sandbox id only
  // when the route id is not injected (older provisioner).
  const agentId =
    env.SANDBOX_ROUTE_AGENT_ID?.trim() || env.SANDBOX_AGENT_ID?.trim();
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
