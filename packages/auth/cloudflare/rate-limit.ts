/** Atomic sliding-window admission persisted in Cloudflare Durable Object SQL. */
import { DurableObject } from "cloudflare:workers";

export class LoginRateLimits extends DurableObject<Record<string, unknown>> {
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, key TEXT NOT NULL,
      occurred_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS events_key_time ON events(key, occurred_at)",
    );
    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS events_expiry ON events(expires_at)",
    );
  }

  async fetch(request: Request): Promise<Response> {
    const operation = new URL(request.url).pathname.split("/").pop();
    if (
      request.method !== "POST" ||
      (operation !== "check" && operation !== "status")
    ) {
      return new Response("Not found", { status: 404 });
    }
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return Response.json(
        { code: "RATE_LIMIT_REQUEST_INVALID" },
        { status: 400 },
      );
    }
    if (
      !input ||
      typeof input !== "object" ||
      !("key" in input) ||
      typeof input.key !== "string" ||
      input.key.length === 0 ||
      input.key.length > 512 ||
      !("windowMs" in input) ||
      !Number.isSafeInteger(input.windowMs) ||
      Number(input.windowMs) <= 0 ||
      !("maxRequests" in input) ||
      !Number.isSafeInteger(input.maxRequests) ||
      Number(input.maxRequests) <= 0
    ) {
      return Response.json(
        { code: "RATE_LIMIT_REQUEST_INVALID" },
        { status: 400 },
      );
    }
    const key = input.key;
    const windowMs = Number(input.windowMs);
    const maximum = Number(input.maxRequests);
    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM events WHERE expires_at <= ?", now);
      sql.exec(
        "DELETE FROM events WHERE key = ? AND occurred_at <= ?",
        key,
        now - windowMs,
      );
      const row = sql
        .exec<{ count: number; oldest: number | null }>(
          "SELECT count(*) AS count, min(occurred_at) AS oldest FROM events WHERE key = ?",
          key,
        )
        .one();
      const allowed = row.count < maximum;
      if (operation === "check" && allowed) {
        sql.exec(
          "INSERT INTO events(key, occurred_at, expires_at) VALUES (?, ?, ?)",
          key,
          now,
          now + windowMs + 1_000,
        );
      }
      const count = row.count + (operation === "check" && allowed ? 1 : 0);
      return {
        allowed,
        remaining: Math.max(0, maximum - count),
        resetMs: Math.max(0, (row.oldest ?? now) + windowMs - now),
      };
    });
    return Response.json(result);
  }
}
