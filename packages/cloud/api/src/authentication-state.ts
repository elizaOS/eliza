/** Private binding only. Each shard owns atomic nonce consumption and expiry. */
export class AuthenticationState {
  constructor(private readonly state: DurableObjectState) {
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS auth_state (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`);
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS auth_state_serving (id INTEGER PRIMARY KEY CHECK(id = 1))",
    );
    state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS auth_state_expiry ON auth_state(expires_at)",
    );
  }

  private async scheduleCleanup(): Promise<void> {
    const [next] = this.state.storage.sql
      .exec<{ expires_at: number }>(
        "SELECT expires_at FROM auth_state ORDER BY expires_at LIMIT 1",
      )
      .toArray();
    if (next)
      await this.state.storage.setAlarm(
        Math.max(Date.now() + 1, next.expires_at),
      );
    else await this.state.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    this.state.storage.sql.exec(
      "DELETE FROM auth_state WHERE expires_at <= ?",
      Date.now(),
    );
    await this.scheduleCleanup();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    const body: unknown = await request.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("key" in body) ||
      typeof body.key !== "string" ||
      !body.key ||
      !("operation" in body)
    ) {
      return new Response("Invalid authentication state request", {
        status: 400,
      });
    }
    const key = body.key;
    if (body.operation === "import") {
      if (
        !("sourceQuiesced" in body) ||
        body.sourceQuiesced !== true ||
        !("value" in body) ||
        typeof body.value !== "string" ||
        !("expiresAt" in body) ||
        typeof body.expiresAt !== "number" ||
        !Number.isSafeInteger(body.expiresAt) ||
        body.expiresAt <= 0
      ) {
        return new Response(
          "Import requires quiesced source and original expiry",
          { status: 400 },
        );
      }
      const value = body.value;
      const expiresAt = body.expiresAt;
      const status = this.state.storage.transactionSync(() => {
        if (
          this.state.storage.sql
            .exec("SELECT id FROM auth_state_serving")
            .toArray().length
        )
          return "serving";
        const [existing] = this.state.storage.sql
          .exec<{ value: string; expires_at: number }>(
            "SELECT value, expires_at FROM auth_state WHERE key = ?",
            key,
          )
          .toArray();
        if (existing)
          return existing.value === value && existing.expires_at === expiresAt
            ? "identical"
            : "conflict";
        if (expiresAt <= Date.now()) return "expired";
        this.state.storage.sql.exec(
          "INSERT INTO auth_state(key, value, expires_at) VALUES (?, ?, ?)",
          key,
          value,
          expiresAt,
        );
        return "imported";
      });
      if (status === "serving" || status === "conflict")
        return Response.json({ status }, { status: 409 });
      await this.scheduleCleanup();
      return Response.json({ status });
    }
    if (body.operation === "set") {
      if (
        !("value" in body) ||
        typeof body.value !== "string" ||
        !("seconds" in body) ||
        typeof body.seconds !== "number" ||
        !Number.isSafeInteger(body.seconds) ||
        body.seconds <= 0
      ) {
        return new Response("Invalid authentication state value or expiry", {
          status: 400,
        });
      }
      const expiresAt = Date.now() + body.seconds * 1000;
      if (!Number.isSafeInteger(expiresAt))
        return new Response("Invalid expiry", { status: 400 });
      if (
        "nx" in body &&
        body.nx !== undefined &&
        typeof body.nx !== "boolean"
      ) {
        return new Response("Invalid conditional write", { status: 400 });
      }
      const value = this.state.storage.transactionSync(() => {
        this.state.storage.sql.exec(
          "INSERT OR IGNORE INTO auth_state_serving(id) VALUES (1)",
        );
        this.state.storage.sql.exec(
          "DELETE FROM auth_state WHERE key = ? AND expires_at <= ?",
          key,
          Date.now(),
        );
        const rows = this.state.storage.sql
          .exec(
            "nx" in body && body.nx
              ? "INSERT INTO auth_state(key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING RETURNING key"
              : "INSERT INTO auth_state(key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at RETURNING key",
            key,
            body.value as string,
            expiresAt,
          )
          .toArray();
        return rows.length === 1 ? "OK" : null;
      });
      await this.scheduleCleanup();
      return Response.json({ value });
    }
    if (body.operation !== "get" && body.operation !== "getdel") {
      return new Response("Invalid authentication state operation", {
        status: 400,
      });
    }
    const value = this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        "INSERT OR IGNORE INTO auth_state_serving(id) VALUES (1)",
      );
      const [row] = this.state.storage.sql
        .exec<{ value: string; expires_at: number }>(
          "SELECT value, expires_at FROM auth_state WHERE key = ?",
          key,
        )
        .toArray();
      if (
        body.operation === "getdel" ||
        (row && row.expires_at <= Date.now())
      ) {
        this.state.storage.sql.exec(
          "DELETE FROM auth_state WHERE key = ?",
          key,
        );
      }
      return row && row.expires_at > Date.now() ? row.value : null;
    });
    return Response.json({ value });
  }
}
