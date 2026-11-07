import { createHash, timingSafeEqual } from "node:crypto";
import {
  DISCORD_DEFAULT_LEADER,
  isDiscordCoordinationKey,
} from "@elizaos/cloud-services-common/discord-coordination";

type Entry = {
  key: string;
  kind: "string" | "set";
  value: string | string[];
  expiresAt: number | null;
};
type Row = { kind: "string" | "set"; value: string; expires_at: number | null };
class CommandError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const operations = [
  "get",
  "set",
  "delete",
  "expire",
  "members",
  "addMembers",
  "removeMembers",
  "compareDelete",
  "compareExpire",
];

/** One transaction owner per environment for Discord's existing strings and sets. */
export class DiscordCoordinationState {
  private readonly leaderKey: string;
  constructor(
    private readonly state: DurableObjectState,
    env: { GATEWAY_RUNTIME_CONFIG?: string },
  ) {
    const config = JSON.parse(env.GATEWAY_RUNTIME_CONFIG ?? "{}");
    this.leaderKey = config.ELIZA_APP_LEADER_KEY || DISCORD_DEFAULT_LEADER;
    if (typeof this.leaderKey !== "string")
      throw new Error("Invalid Discord leader key");
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS coordination (key TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER)",
    );
    state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS coordination_expiry ON coordination(expires_at)",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS coordination_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  private key(key: unknown): asserts key is string {
    if (!isDiscordCoordinationKey(key, this.leaderKey))
      throw new CommandError(400, "Invalid coordination key");
  }
  private cleanup(): void {
    this.state.storage.sql.exec(
      "DELETE FROM coordination WHERE expires_at IS NOT NULL AND expires_at <= ?",
      Date.now(),
    );
  }
  private read(key: string): Row | undefined {
    return this.state.storage.sql
      .exec<Row>(
        "SELECT kind, value, expires_at FROM coordination WHERE key = ?",
        key,
      )
      .toArray()[0];
  }
  private remove(key: string): number {
    return this.state.storage.sql
      .exec("DELETE FROM coordination WHERE key = ? RETURNING key", key)
      .toArray().length;
  }
  private write(entry: Entry): void {
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO coordination(key, kind, value, expires_at) VALUES (?, ?, ?, ?)",
      entry.key,
      entry.kind,
      entry.kind === "set"
        ? JSON.stringify(entry.value)
        : (entry.value as string),
      entry.expiresAt,
    );
  }
  private async schedule(): Promise<void> {
    const row = this.state.storage.sql
      .exec<{ at: number }>(
        "SELECT expires_at AS at FROM coordination WHERE expires_at IS NOT NULL ORDER BY expires_at LIMIT 1",
      )
      .toArray()[0];
    if (row)
      await this.state.storage.setAlarm(Math.max(Date.now() + 1, row.at));
    else await this.state.storage.deleteAlarm();
  }
  async alarm(): Promise<void> {
    this.state.storage.transactionSync(() => this.cleanup());
    await this.schedule();
  }
  private importState(input: Record<string, unknown>): string {
    if (input.sourceQuiesced !== true || !Array.isArray(input.entries))
      throw new CommandError(
        400,
        "Import requires a complete quiesced snapshot",
      );
    const seen = new Set<string>();
    const entries: Entry[] = input.entries.map((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new CommandError(400, "Invalid snapshot entry");
      const row = item as Record<string, unknown>;
      this.key(row.key);
      if (seen.has(row.key))
        throw new CommandError(400, "Duplicate snapshot key");
      seen.add(row.key);
      if (
        row.expiresAt !== null &&
        (typeof row.expiresAt !== "number" ||
          !Number.isSafeInteger(row.expiresAt) ||
          row.expiresAt <= 0)
      )
        throw new CommandError(400, "Original absolute expiry is required");
      if (row.kind === "string" && typeof row.value === "string")
        return {
          key: row.key,
          kind: row.kind,
          value: row.value,
          expiresAt: row.expiresAt,
        };
      if (
        row.kind === "set" &&
        Array.isArray(row.value) &&
        row.value.length > 0 &&
        row.value.every((v) => typeof v === "string") &&
        new Set(row.value).size === row.value.length
      )
        return {
          key: row.key,
          kind: row.kind,
          value: [...row.value].sort(),
          expiresAt: row.expiresAt,
        };
      throw new CommandError(400, "Invalid snapshot value");
    });
    entries.sort((a, b) => a.key.localeCompare(b.key));
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(entries))
      .digest("hex");
    return this.state.storage.transactionSync(() => {
      const meta = new Map(
        this.state.storage.sql
          .exec<{ key: string; value: string }>(
            "SELECT key, value FROM coordination_meta",
          )
          .toArray()
          .map((row) => [row.key, row.value]),
      );
      if (meta.has("serving"))
        throw new CommandError(409, "Serving has permanently closed imports");
      if (meta.has("import")) {
        if (meta.get("import") !== fingerprint)
          throw new CommandError(409, "Conflicting snapshot");
        return "identical";
      }
      for (const entry of entries)
        if (entry.expiresAt === null || entry.expiresAt > Date.now())
          this.write(entry);
      this.state.storage.sql.exec(
        "INSERT INTO coordination_meta(key, value) VALUES ('import', ?)",
        fingerprint,
      );
      return "imported";
    });
  }
  private command(input: Record<string, unknown>): unknown {
    const op = input.operation;
    if (typeof op !== "string" || !operations.includes(op))
      throw new CommandError(400, "Invalid operation");
    if (op === "delete") {
      if (!Array.isArray(input.keys))
        throw new CommandError(400, "Invalid key list");
      const keys = input.keys;
      for (const key of keys) this.key(key);
      return keys.reduce(
        (count: number, key: string) => count + this.remove(key),
        0,
      );
    }
    this.key(input.key);
    const key = input.key;
    const row = this.read(key);
    if (op === "get") {
      if (row && row.kind !== "string")
        throw new CommandError(409, "Wrong value type");
      return row?.value ?? null;
    }
    if (op === "set") {
      if (
        typeof input.value !== "string" ||
        (input.nx !== undefined && typeof input.nx !== "boolean") ||
        (input.ex !== undefined && input.px !== undefined)
      )
        throw new CommandError(400, "Invalid string write");
      let ttl: number | null = null;
      if (input.ex !== undefined || input.px !== undefined) {
        const n = input.ex ?? input.px;
        if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0)
          throw new CommandError(400, "Invalid expiry");
        ttl = input.ex !== undefined ? n * 1000 : n;
        if (!Number.isSafeInteger(Date.now() + ttl))
          throw new CommandError(400, "Invalid expiry");
      }
      if (input.nx === true && row) return null;
      this.write({
        key,
        kind: "string",
        value: input.value,
        expiresAt: ttl === null ? null : Date.now() + ttl,
      });
      return "OK";
    }
    if (op === "compareDelete" || op === "compareExpire") {
      if (typeof input.expected !== "string")
        throw new CommandError(400, "Invalid lease owner");
      if (row && row.kind !== "string")
        throw new CommandError(409, "Wrong value type");
      if (op === "compareDelete")
        return row?.value === input.expected ? this.remove(key) : 0;
    }
    if (op === "expire" || op === "compareExpire") {
      if (
        typeof input.seconds !== "number" ||
        !Number.isSafeInteger(input.seconds) ||
        !Number.isSafeInteger(Date.now() + input.seconds * 1000)
      )
        throw new CommandError(400, "Invalid expiry");
      if (!row || (op === "compareExpire" && row.value !== input.expected))
        return 0;
      if (input.seconds <= 0) return this.remove(key);
      this.state.storage.sql.exec(
        "UPDATE coordination SET expires_at = ? WHERE key = ?",
        Date.now() + input.seconds * 1000,
        key,
      );
      return 1;
    }
    if (row && row.kind !== "set")
      throw new CommandError(409, "Wrong value type");
    const members = new Set<string>(row ? JSON.parse(row.value) : []);
    if (op === "members") return [...members];
    if (
      !Array.isArray(input.members) ||
      input.members.some((member) => typeof member !== "string")
    )
      throw new CommandError(400, "Invalid members");
    let changed = 0;
    for (const member of input.members) {
      if (op === "addMembers" && !members.has(member)) {
        members.add(member);
        changed++;
      }
      if (op === "removeMembers" && members.delete(member)) changed++;
    }
    if (members.size)
      this.write({
        key,
        kind: "set",
        value: [...members],
        expiresAt: row?.expires_at ?? null,
      });
    else this.remove(key);
    return changed;
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return new Response("Invalid request", { status: 400 });
    const input = body as Record<string, unknown>;
    try {
      const result =
        input.operation === "import"
          ? this.importState(input)
          : this.state.storage.transactionSync(() => {
              this.cleanup();
              const result = this.command(input);
              this.state.storage.sql.exec(
                "INSERT OR IGNORE INTO coordination_meta(key,value) VALUES ('serving','1')",
              );
              return result;
            });
      await this.schedule();
      return Response.json(result);
    } catch (error) {
      if (error instanceof CommandError)
        return new Response(error.message, { status: error.status });
      throw error;
    }
  }
}

export async function handleDiscordCoordination(
  request: Request,
  env: {
    GATEWAY_KIND: string;
    GATEWAY_RUNTIME_CONFIG?: string;
    DISCORD_COORDINATION_STATE?: DurableObjectNamespace;
  },
): Promise<Response> {
  if (env.GATEWAY_KIND !== "discord")
    return new Response("Not found", { status: 404 });
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(env.GATEWAY_RUNTIME_CONFIG ?? "null");
  } catch {
    return new Response("Coordination unavailable", { status: 503 });
  }
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    config.CLOUD_DISCORD_COORDINATION_BACKEND !== "cloudflare" ||
    typeof config.DISCORD_COORDINATION_TOKEN !== "string" ||
    !config.DISCORD_COORDINATION_TOKEN.trim() ||
    !env.DISCORD_COORDINATION_STATE
  )
    return new Response("Coordination unavailable", { status: 503 });
  const expected = Buffer.from(`Bearer ${config.DISCORD_COORDINATION_TOKEN}`),
    actual = Buffer.from(request.headers.get("Authorization") ?? "");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return new Response("Unauthorized", { status: 401 });
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !("operation" in input) ||
    typeof input.operation !== "string" ||
    !operations.includes(input.operation)
  )
    return new Response("Invalid operation", { status: 400 });
  return env.DISCORD_COORDINATION_STATE.getByName(
    "discord-coordination-v1",
  ).fetch("https://coordination.internal/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}
