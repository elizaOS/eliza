/** Operational replay counters, independent of the authoritative replay receipts. */
const COUNTERS = new Set([
  "observed",
  "reserved",
  "completed",
  "replayed",
  "conflicts",
  "inFlightConflicts",
  "suppressedAuthResponses",
  "invalidKeys",
  "storeErrors",
  "skippedUnsafeContext",
  "releasedOnError",
]);
const FIELD_NAMES = new Set([...COUNTERS, "windowStartedAt", "lastSeenAt"]);
type Fields = Record<string, string>;
type Stored = { fields: string; expires_at: number };

function validFields(value: unknown): value is Fields {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "windowStartedAt" in value &&
    "lastSeenAt" in value &&
    Object.entries(value).every(
      ([key, field]) =>
        FIELD_NAMES.has(key) &&
        typeof field === "string" &&
        /^\d+$/.test(field) &&
        Number.isSafeInteger(Number(field)),
    )
  );
}
function canonical(fields: Fields): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}
const invalid = () =>
  Response.json({ code: "REPLAY_METRICS_REQUEST_INVALID" }, { status: 400 });

export function initializeReplayMetrics(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS replay_metrics (tenant TEXT PRIMARY KEY, fields TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS replay_metrics_expiry ON replay_metrics(expires_at)",
  );
}

export async function handleReplayMetrics(
  request: Request,
  storage: DurableObjectStorage,
): Promise<Response> {
  if (request.method !== "POST")
    return new Response("Not found", { status: 404 });
  const operation = new URL(request.url).pathname.split("/").pop();
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return invalid();
  }
  if (!input || typeof input !== "object") return invalid();
  const now = Date.now();
  if (operation === "replay-import") {
    if (
      !("sourceQuiesced" in input) ||
      input.sourceQuiesced !== true ||
      !("entries" in input) ||
      !Array.isArray(input.entries)
    )
      return invalid();
    const entries: Array<{
      tenantId: string;
      fields: Fields;
      expiresAtMs: number;
    }> = [];
    for (const value of input.entries) {
      if (
        !value ||
        typeof value !== "object" ||
        typeof value.tenantId !== "string" ||
        !value.tenantId ||
        !validFields(value.fields) ||
        !Number.isSafeInteger(value.expiresAtMs) ||
        value.expiresAtMs <= 0
      )
        return invalid();
      entries.push(value);
    }
    if (new Set(entries.map((e) => e.tenantId)).size !== entries.length)
      return invalid();
    if ((await storage.getAlarm()) === null)
      await storage.setAlarm(now + 86_400_000);
    const result = storage.transactionSync(() => {
      const live = entries.filter((e) => e.expiresAtMs > now);
      for (const entry of live) {
        const row = storage.sql
          .exec<Stored>(
            "SELECT fields, expires_at FROM replay_metrics WHERE tenant = ? AND expires_at > ?",
            entry.tenantId,
            now,
          )
          .toArray()[0];
        if (
          row &&
          canonical(JSON.parse(row.fields)) !== canonical(entry.fields)
        )
          return { conflict: true };
      }
      for (const entry of live)
        storage.sql.exec(
          "INSERT INTO replay_metrics(tenant,fields,expires_at) VALUES (?,?,?) ON CONFLICT(tenant) DO UPDATE SET fields=excluded.fields, expires_at=CASE WHEN replay_metrics.expires_at > ? THEN min(replay_metrics.expires_at,excluded.expires_at) ELSE excluded.expires_at END",
          entry.tenantId,
          canonical(entry.fields),
          entry.expiresAtMs,
          now,
        );
      return { imported: live.length };
    });
    return Response.json(result, { status: "conflict" in result ? 409 : 200 });
  }
  if (
    !("tenantId" in input) ||
    typeof input.tenantId !== "string" ||
    !input.tenantId
  )
    return invalid();
  const tenantId = input.tenantId;
  if (operation === "replay-read") {
    const row = storage.sql
      .exec<Stored>(
        "SELECT fields, expires_at FROM replay_metrics WHERE tenant = ? AND expires_at > ?",
        tenantId,
        now,
      )
      .toArray()[0];
    return Response.json({ fields: row ? JSON.parse(row.fields) : null });
  }
  if (operation !== "replay-record")
    return new Response("Not found", { status: 404 });
  if (
    !("counter" in input) ||
    typeof input.counter !== "string" ||
    !COUNTERS.has(input.counter) ||
    !("now" in input) ||
    typeof input.now !== "number" ||
    !Number.isSafeInteger(input.now) ||
    input.now <= 0 ||
    !("ttlSeconds" in input) ||
    typeof input.ttlSeconds !== "number" ||
    !Number.isSafeInteger(input.ttlSeconds) ||
    input.ttlSeconds <= 0 ||
    !Number.isSafeInteger(now + input.ttlSeconds * 1000)
  )
    return invalid();
  const { counter, now: observedAt, ttlSeconds } = input;
  if ((await storage.getAlarm()) === null)
    await storage.setAlarm(now + 86_400_000);
  return storage.transactionSync(() => {
    const row = storage.sql
      .exec<Stored>(
        "SELECT fields, expires_at FROM replay_metrics WHERE tenant = ? AND expires_at > ?",
        tenantId,
        now,
      )
      .toArray()[0];
    const fields: Fields = row
      ? JSON.parse(row.fields)
      : { windowStartedAt: String(observedAt), lastSeenAt: String(observedAt) };
    const count = Number(fields[counter] ?? "0") + 1;
    if (!Number.isSafeInteger(count))
      return Response.json(
        { code: "REPLAY_METRICS_OVERFLOW" },
        { status: 409 },
      );
    fields[counter] = String(count);
    fields.lastSeenAt = String(Math.max(Number(fields.lastSeenAt), observedAt));
    storage.sql.exec(
      "INSERT INTO replay_metrics(tenant,fields,expires_at) VALUES (?,?,?) ON CONFLICT(tenant) DO UPDATE SET fields=excluded.fields, expires_at=excluded.expires_at",
      tenantId,
      canonical(fields),
      now + ttlSeconds * 1000,
    );
    return Response.json({ recorded: true });
  });
}
