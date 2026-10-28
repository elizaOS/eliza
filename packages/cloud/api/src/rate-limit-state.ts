/** Private atomic owner for the existing fixed and sliding rate-limit algorithms. */
export class RateLimitState {
  constructor(private readonly state: DurableObjectState) {
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS rate_windows (
      key TEXT PRIMARY KEY, mode TEXT NOT NULL, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
    )`);
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS rate_serving (id INTEGER PRIMARY KEY CHECK(id = 1))",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS rate_imports (key TEXT PRIMARY KEY, receipt TEXT NOT NULL)",
    );
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS rate_events (
      key TEXT NOT NULL, at INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(key, at)
    )`);
    state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS rate_expiry ON rate_windows(expires_at)",
    );
  }

  private cleanup(now: number): void {
    this.state.storage.sql.exec(
      "DELETE FROM rate_events WHERE key IN (SELECT key FROM rate_windows WHERE expires_at > 0 AND expires_at <= ?)",
      now,
    );
    this.state.storage.sql.exec(
      "DELETE FROM rate_windows WHERE expires_at > 0 AND expires_at <= ?",
      now,
    );
  }

  private async schedule(): Promise<void> {
    const [row] = this.state.storage.sql
      .exec<{ expires_at: number }>(
        "SELECT expires_at FROM rate_windows WHERE expires_at > 0 ORDER BY expires_at LIMIT 1",
      )
      .toArray();
    if (row)
      await this.state.storage.setAlarm(
        Math.max(Date.now() + 1, row.expires_at),
      );
    else await this.state.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    this.state.storage.transactionSync(() => this.cleanup(Date.now()));
    await this.schedule();
  }

  private async importState(input: Record<string, unknown>): Promise<Response> {
    const { key, mode, expiresAt, sourceQuiesced } = input;
    // Zero in storage represents a source key with no expiry, never an expired key.
    if (
      typeof key !== "string" ||
      !key ||
      sourceQuiesced !== true ||
      (mode !== "fixed" && mode !== "sliding") ||
      (expiresAt !== null &&
        (typeof expiresAt !== "number" ||
          !Number.isSafeInteger(expiresAt) ||
          expiresAt <= 0))
    ) {
      return new Response(
        "Import requires quiesced source and original expiry",
        { status: 400 },
      );
    }
    let count: number;
    const events: Array<{ at: number; count: number }> = [];
    if (mode === "fixed") {
      if (
        typeof input.count !== "number" ||
        !Number.isSafeInteger(input.count) ||
        input.count < 0
      )
        return new Response("Invalid source count", { status: 400 });
      count = input.count;
    } else {
      if (!Array.isArray(input.events))
        return new Response("Invalid source events", { status: 400 });
      const grouped = new Map<number, number>();
      for (const item of input.events) {
        if (
          !item ||
          typeof item !== "object" ||
          typeof item.at !== "number" ||
          !Number.isSafeInteger(item.at) ||
          item.at < 0 ||
          typeof item.count !== "number" ||
          !Number.isSafeInteger(item.count) ||
          item.count <= 0
        )
          return new Response("Invalid source event", { status: 400 });
        const total = (grouped.get(item.at) ?? 0) + item.count;
        if (!Number.isSafeInteger(total))
          return new Response("Source count overflow", { status: 400 });
        grouped.set(item.at, total);
      }
      for (const [at, n] of grouped) events.push({ at, count: n });
      events.sort((a, b) => a.at - b.at);
      count = events.reduce((sum, event) => sum + event.count, 0);
      if (!Number.isSafeInteger(count))
        return new Response("Source count overflow", { status: 400 });
    }
    const receipt = JSON.stringify({ mode, expiresAt, count, events });
    const status = this.state.storage.transactionSync(() => {
      if (
        this.state.storage.sql.exec("SELECT id FROM rate_serving").toArray()
          .length
      )
        return "serving";
      const [prior] = this.state.storage.sql
        .exec<{ receipt: string }>(
          "SELECT receipt FROM rate_imports WHERE key = ?",
          key,
        )
        .toArray();
      if (prior) return prior.receipt === receipt ? "identical" : "conflict";
      this.state.storage.sql.exec(
        "INSERT INTO rate_imports(key, receipt) VALUES (?, ?)",
        key,
        receipt,
      );
      if (expiresAt !== null && expiresAt <= Date.now()) return "expired";
      this.state.storage.sql.exec(
        "INSERT INTO rate_windows(key, mode, count, expires_at) VALUES (?, ?, ?, ?)",
        key,
        mode,
        count,
        expiresAt ?? 0,
      );
      for (const event of events)
        this.state.storage.sql.exec(
          "INSERT INTO rate_events(key, at, count) VALUES (?, ?, ?)",
          key,
          event.at,
          event.count,
        );
      return "imported";
    });
    if (status === "serving" || status === "conflict")
      return Response.json({ status }, { status: 409 });
    await this.schedule();
    return Response.json({ status });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    const body: unknown = await request.json();
    if (!body || typeof body !== "object")
      return new Response("Invalid request", { status: 400 });
    const input = body as Record<string, unknown>;
    const { key, mode, operation, windowMs, maxRequests } = input;
    if (operation === "import") return this.importState(input);
    const carriedCount = input.carriedCount ?? 0;
    if (
      typeof key !== "string" ||
      !key ||
      (mode !== "fixed" && mode !== "sliding") ||
      (operation !== "check" &&
        operation !== "status" &&
        operation !== "clear") ||
      typeof windowMs !== "number" ||
      !Number.isSafeInteger(windowMs) ||
      windowMs <= 0 ||
      typeof maxRequests !== "number" ||
      !Number.isSafeInteger(maxRequests) ||
      maxRequests < 1 ||
      typeof carriedCount !== "number" ||
      !Number.isSafeInteger(carriedCount) ||
      carriedCount < 0 ||
      !Number.isSafeInteger(Date.now() + windowMs + 11000) ||
      !Number.isSafeInteger(carriedCount + 1)
    ) {
      return new Response("Invalid rate operation", { status: 400 });
    }
    const now = Date.now();
    const result = this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        "INSERT OR IGNORE INTO rate_serving(id) VALUES (1)",
      );
      this.cleanup(now);
      const [existing] = this.state.storage.sql
        .exec<{ mode: string; count: number; expires_at: number }>(
          "SELECT mode, count, expires_at FROM rate_windows WHERE key = ?",
          key,
        )
        .toArray();
      if (existing && existing.mode !== mode) return null;
      if (operation === "clear") {
        this.state.storage.sql.exec(
          "DELETE FROM rate_events WHERE key = ?",
          key,
        );
        this.state.storage.sql.exec(
          "DELETE FROM rate_windows WHERE key = ?",
          key,
        );
        return {
          allowed: true,
          count: 0,
          remaining: maxRequests,
          resetAt: now + windowMs,
        };
      }
      let count = existing?.count ?? 0;
      const resetAt =
        mode === "fixed"
          ? existing?.expires_at || now + windowMs
          : now + windowMs;
      if (mode === "sliding") {
        this.state.storage.sql.exec(
          "DELETE FROM rate_events WHERE key = ? AND at <= ?",
          key,
          now - windowMs,
        );
        const [row] = this.state.storage.sql
          .exec<{ count: number }>(
            "SELECT COALESCE(SUM(count), 0) AS count FROM rate_events WHERE key = ?",
            key,
          )
          .toArray();
        count = row.count;
      }
      if (operation === "check") {
        const increment = carriedCount + 1;
        if (!Number.isSafeInteger(count + increment))
          throw new Error("Rate count exceeds safe integer range");
        count += increment;
        if (mode === "sliding") {
          this.state.storage.sql.exec(
            "INSERT INTO rate_events(key, at, count) VALUES (?, ?, ?) ON CONFLICT(key, at) DO UPDATE SET count = count + excluded.count",
            key,
            now,
            increment,
          );
        }
        const expiry =
          mode === "fixed"
            ? resetAt
            : now + (Math.ceil(windowMs / 1000) + 10) * 1000;
        this.state.storage.sql.exec(
          "INSERT INTO rate_windows(key, mode, count, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, expires_at = excluded.expires_at",
          key,
          mode,
          count,
          expiry,
        );
      }
      const allowed = count <= maxRequests;
      return {
        allowed,
        count,
        remaining: Math.max(0, maxRequests - count),
        resetAt,
        retryAfter: allowed ? undefined : Math.ceil((resetAt - now) / 1000),
      };
    });
    if (!result)
      return new Response("Rate algorithm conflict", { status: 409 });
    await this.schedule();
    return Response.json(result);
  }
}
