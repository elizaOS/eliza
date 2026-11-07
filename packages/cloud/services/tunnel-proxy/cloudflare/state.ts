import { DurableObject } from "cloudflare:workers";

interface Env {
  TUNNEL_ENABLED: string;
}
const invalid = () =>
  Response.json({ code: "STATE_REQUEST_INVALID" }, { status: 400 });
function encoded(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
}

/** One environment's tsnet identity. Imported before its sole runtime starts. */
export class TunnelState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return invalid();
    }
    if (!input || typeof input !== "object" || !("operation" in input))
      return invalid();
    if (input.operation === "import") {
      if (this.env.TUNNEL_ENABLED === "true")
        return Response.json({ code: "STATE_RUNTIME_ACTIVE" }, { status: 409 });
      if (
        !("sourceQuiesced" in input) ||
        input.sourceQuiesced !== true ||
        !("entries" in input) ||
        !input.entries ||
        typeof input.entries !== "object" ||
        Array.isArray(input.entries)
      )
        return invalid();
      const entries = Object.entries(input.entries).map(
        ([key, value]) => [key, value === null ? "" : value] as const,
      );
      if (
        !entries.length ||
        !entries.every(([key, value]) => key.length > 0 && encoded(value)) ||
        !entries.some(([key, value]) => key === "_machinekey" && value !== "")
      )
        return invalid();
      return this.ctx.storage.transactionSync(() => {
        const existing = this.ctx.storage.sql
          .exec<{ key: string; value: string }>("SELECT key,value FROM state")
          .toArray();
        const requested = new Map(entries);
        if (
          existing.length &&
          (existing.length !== entries.length ||
            existing.some((row) => requested.get(row.key) !== row.value))
        )
          return Response.json(
            { code: "STATE_IMPORT_CONFLICT" },
            { status: 409 },
          );
        for (const [key, value] of entries)
          this.ctx.storage.sql.exec(
            "INSERT INTO state(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING",
            key,
            value as string,
          );
        return Response.json({ imported: entries.length });
      });
    }
    if (!("key" in input) || typeof input.key !== "string" || !input.key)
      return invalid();
    const initialized =
      this.ctx.storage.sql
        .exec("SELECT key FROM state WHERE key='_machinekey'")
        .toArray().length > 0;
    if (!initialized)
      return Response.json({ code: "STATE_NOT_INITIALIZED" }, { status: 503 });
    if (input.operation === "read") {
      const row = this.ctx.storage.sql
        .exec<{ value: string }>(
          "SELECT value FROM state WHERE key=?",
          input.key,
        )
        .toArray()[0];
      return row
        ? Response.json(row)
        : Response.json({ code: "STATE_NOT_FOUND" }, { status: 404 });
    }
    if (
      input.operation !== "write" ||
      !("value" in input) ||
      !encoded(input.value)
    )
      return invalid();
    if (this.env.TUNNEL_ENABLED !== "true")
      return Response.json({ code: "STATE_RUNTIME_INACTIVE" }, { status: 409 });
    this.ctx.storage.sql.exec(
      "INSERT INTO state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      input.key,
      input.value,
    );
    return new Response(null, { status: 204 });
  }
}
