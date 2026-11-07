import { createHash, timingSafeEqual } from "node:crypto";
import {
  DISCORD_WELCOME_DELIVERED,
  DISCORD_WELCOME_PENDING,
  DISCORD_WELCOME_PROCESSING,
} from "@elizaos/cloud-services-common/discord-welcome-state";

const listKey = (key: unknown): key is string =>
  key === DISCORD_WELCOME_PENDING || key === DISCORD_WELCOME_PROCESSING;
const markerKey = (key: unknown): key is string =>
  typeof key === "string" &&
  key.startsWith(DISCORD_WELCOME_DELIVERED) &&
  key.length > DISCORD_WELCOME_DELIVERED.length;
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);
const side = (value: unknown): value is "left" | "right" =>
  value === "left" || value === "right";
type Marker = { key: string; value: string; expiresAt: number | null };
/** Ordered durable pending/processing lists and expiring delivery markers. */
export class DiscordWelcomeState {
  constructor(private readonly state: DurableObjectState) {
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS queue(name TEXT NOT NULL,position INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(name,position))",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS delivered(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER)",
    );
    state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS marker_expiry ON delivered(expires_at) WHERE expires_at IS NOT NULL",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS serving(id INTEGER PRIMARY KEY CHECK(id=1))",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS imported(id INTEGER PRIMARY KEY CHECK(id=1),fingerprint TEXT NOT NULL)",
    );
  }
  private push(key: string, value: string, to: "left" | "right"): void {
    const edge = this.state.storage.sql
      .exec<{ position: number }>(
        `SELECT position FROM queue WHERE name=? ORDER BY position ${to === "left" ? "ASC" : "DESC"} LIMIT 1`,
        key,
      )
      .toArray()[0];
    const position = edge ? edge.position + (to === "left" ? -1 : 1) : 0;
    if (!Number.isSafeInteger(position))
      throw new Error("Discord welcome queue position overflow");
    this.state.storage.sql.exec(
      "INSERT INTO queue VALUES(?,?,?)",
      key,
      position,
      value,
    );
  }
  private async schedule(): Promise<void> {
    const row = this.state.storage.sql
      .exec<{ expires_at: number }>(
        "SELECT expires_at FROM delivered WHERE expires_at IS NOT NULL ORDER BY expires_at LIMIT 1",
      )
      .toArray()[0];
    if (row)
      await this.state.storage.setAlarm(
        Math.max(Date.now() + 1, row.expires_at),
      );
  }
  async alarm(): Promise<void> {
    this.state.storage.sql.exec(
      "DELETE FROM delivered WHERE expires_at<=?",
      Date.now(),
    );
    await this.schedule();
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
    const {
      operation,
      key,
      value,
      values,
      ex,
      px,
      nx,
      count,
      source,
      destination,
      whereFrom,
      whereTo,
    } = input;
    let snapshot:
      | { pending: string[]; processing: string[]; delivered: Marker[] }
      | undefined;
    if (operation === "import") {
      if (
        input.sourceQuiesced !== true ||
        !Array.isArray(input.pending) ||
        !Array.isArray(input.processing) ||
        !Array.isArray(input.delivered) ||
        input.pending.some((v) => typeof v !== "string") ||
        input.processing.some((v) => typeof v !== "string")
      )
        return new Response("Quiesced queue snapshot required", {
          status: 400,
        });
      const delivered = input.delivered as Marker[];
      if (
        delivered.some(
          (r) =>
            !r ||
            !markerKey(r.key) ||
            typeof r.value !== "string" ||
            (r.expiresAt !== null &&
              (!integer(r.expiresAt) || r.expiresAt <= 0)),
        ) ||
        new Set(delivered.map((r) => r.key)).size !== delivered.length
      )
        return new Response("Invalid delivery markers", { status: 400 });
      snapshot = {
        pending: input.pending as string[],
        processing: input.processing as string[],
        delivered,
      };
    } else if (operation === "get" || operation === "set") {
      if (!markerKey(key))
        return new Response("Invalid marker key", { status: 400 });
      if (
        operation === "set" &&
        (typeof value !== "string" ||
          (nx !== undefined && typeof nx !== "boolean") ||
          (ex !== undefined && px !== undefined) ||
          (ex !== undefined &&
            (!integer(ex) ||
              ex <= 0 ||
              !Number.isSafeInteger(Date.now() + ex * 1000))) ||
          (px !== undefined &&
            (!integer(px) ||
              px <= 0 ||
              !Number.isSafeInteger(Date.now() + px))))
      )
        return new Response("Invalid marker write", { status: 400 });
    } else if (operation === "push") {
      if (
        !listKey(key) ||
        !Array.isArray(values) ||
        values.length === 0 ||
        values.some((v) => typeof v !== "string")
      )
        return new Response("Invalid queue push", { status: 400 });
    } else if (operation === "move") {
      if (
        !listKey(source) ||
        !listKey(destination) ||
        !side(whereFrom) ||
        !side(whereTo)
      )
        return new Response("Invalid queue move", { status: 400 });
    } else if (operation === "remove") {
      if (!listKey(key) || !integer(count) || typeof value !== "string")
        return new Response("Invalid queue acknowledgement", { status: 400 });
    } else return new Response("Invalid operation", { status: 400 });
    const result = this.state.storage.transactionSync(() => {
      if (snapshot) {
        if (
          this.state.storage.sql.exec("SELECT id FROM serving").toArray().length
        )
          return { status: 409, value: null };
        const fingerprint = createHash("sha256")
          .update(JSON.stringify(snapshot))
          .digest("hex");
        const prior = this.state.storage.sql
          .exec<{ fingerprint: string }>("SELECT fingerprint FROM imported")
          .toArray()[0];
        if (prior && prior.fingerprint !== fingerprint)
          return { status: 409, value: null };
        if (!prior) {
          for (const [name, rows] of [
            [DISCORD_WELCOME_PENDING, snapshot.pending],
            [DISCORD_WELCOME_PROCESSING, snapshot.processing],
          ] as const)
            for (let i = 0; i < rows.length; i++)
              this.state.storage.sql.exec(
                "INSERT INTO queue VALUES(?,?,?)",
                name,
                i,
                rows[i] as string,
              );
          for (const row of snapshot.delivered)
            if (row.expiresAt === null || row.expiresAt > Date.now())
              this.state.storage.sql.exec(
                "INSERT INTO delivered VALUES(?,?,?)",
                row.key,
                row.value,
                row.expiresAt,
              );
          this.state.storage.sql.exec(
            "INSERT INTO imported VALUES(1,?)",
            fingerprint,
          );
        }
        return { status: 200, value: { imported: true } };
      }
      this.state.storage.sql.exec("INSERT OR IGNORE INTO serving VALUES(1)");
      this.state.storage.sql.exec(
        "DELETE FROM delivered WHERE expires_at<=?",
        Date.now(),
      );
      let result: unknown;
      switch (operation) {
        case "get":
          result =
            this.state.storage.sql
              .exec<{ value: string }>(
                "SELECT value FROM delivered WHERE key=?",
                key as string,
              )
              .toArray()[0]?.value ?? null;
          break;
        case "set":
          if (
            nx === true &&
            this.state.storage.sql
              .exec("SELECT key FROM delivered WHERE key=?", key as string)
              .toArray().length
          ) {
            result = null;
            break;
          }
          this.state.storage.sql.exec(
            "INSERT INTO delivered VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at",
            key as string,
            value as string,
            ex !== undefined
              ? Date.now() + (ex as number) * 1000
              : px !== undefined
                ? Date.now() + (px as number)
                : null,
          );
          result = "OK";
          break;
        case "push":
          for (const item of values as string[])
            this.push(key as string, item, "left");
          result =
            this.state.storage.sql
              .exec<{ count: number }>(
                "SELECT COUNT(*) AS count FROM queue WHERE name=?",
                key as string,
              )
              .toArray()[0]?.count ?? 0;
          break;
        case "move": {
          const row = this.state.storage.sql
            .exec<{ position: number; value: string }>(
              `SELECT position,value FROM queue WHERE name=? ORDER BY position ${whereFrom === "left" ? "ASC" : "DESC"} LIMIT 1`,
              source as string,
            )
            .toArray()[0];
          if (!row) {
            result = null;
            break;
          }
          this.state.storage.sql.exec(
            "DELETE FROM queue WHERE name=? AND position=?",
            source as string,
            row.position,
          );
          this.push(
            destination as string,
            row.value,
            whereTo as "left" | "right",
          );
          result = row.value;
          break;
        }
        case "remove": {
          const positions = this.state.storage.sql
            .exec<{ position: number }>(
              `SELECT position FROM queue WHERE name=? AND value=? ORDER BY position ${(count as number) < 0 ? "DESC" : "ASC"} LIMIT ?`,
              key as string,
              value as string,
              count === 0 ? -1 : Math.abs(count as number),
            )
            .toArray();
          for (const row of positions)
            this.state.storage.sql.exec(
              "DELETE FROM queue WHERE name=? AND position=?",
              key as string,
              row.position,
            );
          result = positions.length;
          break;
        }
      }
      return { status: 200, value: result };
    });
    await this.schedule();
    return Response.json(result.value, { status: result.status });
  }
}
export async function handleDiscordWelcome(
  request: Request,
  env: {
    GATEWAY_KIND: string;
    GATEWAY_RUNTIME_CONFIG?: string;
    DISCORD_WELCOME_STATE?: DurableObjectNamespace;
  },
): Promise<Response> {
  if (env.GATEWAY_KIND !== "discord")
    return new Response("Not found", { status: 404 });
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(env.GATEWAY_RUNTIME_CONFIG ?? "null");
  } catch {
    return new Response("Queue unavailable", { status: 503 });
  }
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    config.CLOUD_DISCORD_WELCOME_BACKEND !== "cloudflare" ||
    typeof config.DISCORD_WELCOME_TOKEN !== "string" ||
    !config.DISCORD_WELCOME_TOKEN.trim() ||
    !env.DISCORD_WELCOME_STATE
  )
    return new Response("Queue unavailable", { status: 503 });
  const expected = Buffer.from(`Bearer ${config.DISCORD_WELCOME_TOKEN}`),
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
    !["get", "set", "push", "move", "remove"].includes(input.operation)
  )
    return new Response("Invalid operation", { status: 400 });
  return env.DISCORD_WELCOME_STATE.getByName("discord-welcome-v1").fetch(
    "https://welcome.internal/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}
