import { createHash, timingSafeEqual } from "node:crypto";

export const receiptOwner = (key: string): string =>
  `receipt-v1:${createHash("sha256").update(key).digest("hex")}`;
const validKey = (key: unknown): key is string =>
  typeof key === "string" &&
  (/^internal-delivery:(telegram|blooio|twilio):[a-z0-9][a-z0-9_-]{0,63}:[a-zA-Z0-9:._-]{1,200}$/i.test(
    key,
  ) ||
    /^reply:twilio:[a-z0-9][a-z0-9_-]{0,63}:[a-zA-Z0-9:._-]{1,200}$/i.test(
      key,
    ) ||
    /^internal-delivery:discord:[0-9]{1,32}:[a-zA-Z0-9:._-]{1,200}$/.test(key));
/** One replay fence per original receipt key. Import expiry is never extended. */
export class DeliveryReceiptState {
  constructor(private readonly state: DurableObjectState) {
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1),key TEXT NOT NULL)",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS receipt(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL,expires_at INTEGER NOT NULL)",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS serving(id INTEGER PRIMARY KEY CHECK(id=1))",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS imported(id INTEGER PRIMARY KEY CHECK(id=1),fingerprint TEXT NOT NULL)",
    );
  }
  private async scheduleExpiry(): Promise<void> {
    const row = this.state.storage.sql
      .exec<{ expires_at: number }>("SELECT expires_at FROM receipt")
      .toArray()[0];
    if (row)
      await this.state.storage.setAlarm(
        Math.max(Date.now() + 1, row.expires_at),
      );
  }
  async alarm(): Promise<void> {
    this.state.storage.sql.exec(
      "DELETE FROM receipt WHERE expires_at<=?",
      Date.now(),
    );
    await this.scheduleExpiry();
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
    const { operation, key, value, expected, seconds, expiresAt } = input;
    if (
      !validKey(key) ||
      typeof operation !== "string" ||
      !["get", "set", "replace", "delete", "import"].includes(operation)
    )
      return new Response("Invalid operation", { status: 400 });
    if (expected !== undefined && typeof expected !== "string")
      return new Response("Invalid comparison", { status: 400 });
    if (operation === "replace" && typeof expected !== "string")
      return new Response("Comparison required", { status: 400 });
    if (operation === "set" || operation === "replace") {
      if (
        typeof value !== "string" ||
        typeof seconds !== "number" ||
        !Number.isSafeInteger(seconds) ||
        seconds <= 0 ||
        !Number.isSafeInteger(Date.now() + seconds * 1000) ||
        (input.nx !== undefined && typeof input.nx !== "boolean")
      )
        return new Response("Invalid receipt write", { status: 400 });
    }
    if (
      operation === "import" &&
      (input.sourceQuiesced !== true ||
        typeof value !== "string" ||
        typeof expiresAt !== "number" ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= 0)
    )
      return new Response("Quiesced expiring receipt required", {
        status: 400,
      });
    const result = this.state.storage.transactionSync(() => {
      const owner = this.state.storage.sql
        .exec<{ key: string }>("SELECT key FROM owner")
        .toArray()[0];
      if (owner && owner.key !== key) return { status: 403, value: null };
      this.state.storage.sql.exec(
        "INSERT OR IGNORE INTO owner VALUES(1,?)",
        key,
      );
      if (operation === "import") {
        if (
          this.state.storage.sql.exec("SELECT id FROM serving").toArray().length
        )
          return { status: 409, value: null };
        const fingerprint = createHash("sha256")
          .update(JSON.stringify([value, expiresAt]))
          .digest("hex");
        const prior = this.state.storage.sql
          .exec<{ fingerprint: string }>("SELECT fingerprint FROM imported")
          .toArray()[0];
        if (prior && prior.fingerprint !== fingerprint)
          return { status: 409, value: null };
        if (!prior) {
          this.state.storage.sql.exec(
            "INSERT INTO imported VALUES(1,?)",
            fingerprint,
          );
          if ((expiresAt as number) > Date.now())
            this.state.storage.sql.exec(
              "INSERT INTO receipt VALUES(1,?,?)",
              value as string,
              expiresAt as number,
            );
        }
        return { status: 200, value: { imported: true } };
      }
      this.state.storage.sql.exec("INSERT OR IGNORE INTO serving VALUES(1)");
      this.state.storage.sql.exec(
        "DELETE FROM receipt WHERE expires_at<=?",
        Date.now(),
      );
      const row = this.state.storage.sql
        .exec<{ value: string }>("SELECT value FROM receipt")
        .toArray()[0];
      if (operation === "get")
        return { status: 200, value: row?.value ?? null };
      if (operation === "delete") {
        if (!row || (expected !== undefined && expected !== row.value))
          return { status: 200, value: false };
        this.state.storage.sql.exec("DELETE FROM receipt");
        return { status: 200, value: true };
      }
      if (operation === "replace" && (!row || row.value !== expected))
        return { status: 200, value: false };
      if (operation === "set" && input.nx === true && row)
        return { status: 200, value: null };
      this.state.storage.sql.exec(
        "INSERT INTO receipt VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at",
        value as string,
        Date.now() + (seconds as number) * 1000,
      );
      return { status: 200, value: operation === "replace" ? true : "OK" };
    });
    await this.scheduleExpiry();
    return Response.json(result.value, { status: result.status });
  }
}

export async function handleDeliveryReceipts(
  request: Request,
  env: {
    GATEWAY_KIND: string;
    GATEWAY_RUNTIME_CONFIG?: string;
    DELIVERY_RECEIPT_STATE?: DurableObjectNamespace;
  },
): Promise<Response> {
  if (!["webhook", "discord"].includes(env.GATEWAY_KIND))
    return new Response("Not found", { status: 404 });
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(env.GATEWAY_RUNTIME_CONFIG ?? "null");
  } catch {
    return new Response("Receipt state unavailable", { status: 503 });
  }
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    config.CLOUD_GATEWAY_RECEIPTS_BACKEND !== "cloudflare" ||
    typeof config.GATEWAY_RECEIPTS_TOKEN !== "string" ||
    !config.GATEWAY_RECEIPTS_TOKEN.trim() ||
    !env.DELIVERY_RECEIPT_STATE
  )
    return new Response("Receipt state unavailable", { status: 503 });
  const expected = Buffer.from(`Bearer ${config.GATEWAY_RECEIPTS_TOKEN}`),
    actual = Buffer.from(request.headers.get("Authorization") ?? "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return new Response("Unauthorized", { status: 401 });
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return new Response("Invalid operation", { status: 400 });
  const input = body as Record<string, unknown>;
  if (
    !validKey(input.key) ||
    typeof input.operation !== "string" ||
    !["get", "set", "replace", "delete"].includes(input.operation)
  )
    return new Response("Invalid operation", { status: 400 });
  if (
    input.key.startsWith("internal-delivery:discord:") !==
    (env.GATEWAY_KIND === "discord")
  )
    return new Response("Foreign gateway receipt", { status: 403 });
  return env.DELIVERY_RECEIPT_STATE.getByName(receiptOwner(input.key)).fetch(
    "https://receipts.internal/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}
