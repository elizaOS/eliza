/** One private Durable Object per organization/day owns both quota counters. */
export class VoiceUsageState {
  constructor(private readonly state: DurableObjectState) {
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS voice_counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    );
    state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS voice_counter_expiry ON voice_counters(expires_at)",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS voice_serving (id INTEGER PRIMARY KEY CHECK(id=1))",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS voice_imports (key TEXT PRIMARY KEY, value INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    );
  }

  private async schedule(): Promise<void> {
    const [row] = this.state.storage.sql
      .exec<{ expires_at: number }>(
        "SELECT expires_at FROM voice_counters ORDER BY expires_at LIMIT 1",
      )
      .toArray();
    if (row)
      await this.state.storage.setAlarm(
        Math.max(Date.now() + 1, row.expires_at),
      );
    else await this.state.storage.deleteAlarm();
  }
  async alarm(): Promise<void> {
    this.state.storage.sql.exec(
      "DELETE FROM voice_counters WHERE expires_at <= ?",
      Date.now(),
    );
    await this.schedule();
  }
  private userPrefix(orgKey: unknown): string | null {
    if (typeof orgKey !== "string") return null;
    const match = /^voice-usage:(\d{4}-\d{2}-\d{2}):org:(.+)$/.exec(orgKey);
    return match ? `voice-usage:${match[1]}:user:${match[2]}:` : null;
  }
  private async importState(input: Record<string, unknown>): Promise<Response> {
    const prefix = this.userPrefix(input.orgKey);
    if (
      !prefix ||
      input.sourceQuiesced !== true ||
      !Array.isArray(input.entries)
    )
      return new Response("Import requires a quiesced organization snapshot", {
        status: 400,
      });
    const entries: Array<{ key: string; value: number; expiresAt: number }> =
      [];
    const seen = new Set<string>();
    for (const row of input.entries) {
      if (
        !row ||
        typeof row !== "object" ||
        typeof row.key !== "string" ||
        (row.key !== input.orgKey &&
          (!row.key.startsWith(prefix) || row.key.length === prefix.length)) ||
        typeof row.value !== "number" ||
        !Number.isSafeInteger(row.value) ||
        row.value < 0 ||
        typeof row.expiresAt !== "number" ||
        !Number.isSafeInteger(row.expiresAt) ||
        row.expiresAt <= 0 ||
        seen.has(row.key)
      )
        return new Response("Invalid voice usage snapshot", { status: 400 });
      seen.add(row.key);
      entries.push(row);
    }
    const result = this.state.storage.transactionSync(() => {
      if (
        this.state.storage.sql.exec("SELECT id FROM voice_serving").toArray()
          .length
      )
        return "serving";
      // Validate the entire batch before writing any counter.
      for (const row of entries) {
        const [prior] = this.state.storage.sql
          .exec<{ value: number; expires_at: number }>(
            "SELECT value, expires_at FROM voice_imports WHERE key = ?",
            row.key,
          )
          .toArray();
        if (
          prior &&
          (prior.value !== row.value || prior.expires_at !== row.expiresAt)
        )
          return "conflict";
      }
      for (const row of entries) {
        this.state.storage.sql.exec(
          "INSERT OR IGNORE INTO voice_imports(key,value,expires_at) VALUES(?,?,?)",
          row.key,
          row.value,
          row.expiresAt,
        );
        if (row.expiresAt > Date.now())
          this.state.storage.sql.exec(
            "INSERT OR IGNORE INTO voice_counters(key,value,expires_at) VALUES(?,?,?)",
            row.key,
            row.value,
            row.expiresAt,
          );
      }
      return "imported";
    });
    if (result !== "imported")
      return Response.json({ error: result }, { status: 409 });
    await this.schedule();
    return Response.json({ imported: entries.length });
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    const body: unknown = await request.json();
    if (!body || typeof body !== "object")
      return new Response("Invalid request", { status: 400 });
    const input = body as Record<string, unknown>;
    if (input.operation === "import") return this.importState(input);
    const { keys, args, operation } = input;
    const prefix = Array.isArray(keys) ? this.userPrefix(keys[0]) : null;
    if (
      (operation !== "reserve" && operation !== "release") ||
      !Array.isArray(keys) ||
      keys.length !== 2 ||
      !prefix ||
      typeof keys[1] !== "string" ||
      !keys[1].startsWith(prefix) ||
      keys[1].length === prefix.length ||
      !Array.isArray(args) ||
      args.length !== (operation === "reserve" ? 4 : 2) ||
      !args.every(
        (value) =>
          typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0,
      ) ||
      args[0] < 1
    ) {
      return new Response("Invalid voice usage operation", { status: 400 });
    }
    const ttl = args[operation === "reserve" ? 3 : 1] as number;
    const expiresAt = Date.now() + ttl * 1000;
    if (ttl < 1 || !Number.isSafeInteger(expiresAt))
      return new Response("Invalid expiry", { status: 400 });
    const result = this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        "INSERT OR IGNORE INTO voice_serving(id) VALUES(1)",
      );
      this.state.storage.sql.exec(
        "DELETE FROM voice_counters WHERE expires_at <= ?",
        Date.now(),
      );
      const counts = keys.map(
        (key) =>
          this.state.storage.sql
            .exec<{ value: number }>(
              "SELECT value FROM voice_counters WHERE key = ?",
              key,
            )
            .toArray()[0]?.value ?? 0,
      );
      if (operation === "reserve") {
        if (counts[0] + args[0] > args[1]) return [0, 1, ...counts];
        if (counts[1] + args[0] > args[2]) return [0, 2, ...counts];
      }
      const updated = counts.map((n) =>
        operation === "release" ? Math.max(0, n - args[0]) : n + args[0],
      );
      for (let i = 0; i < 2; i++)
        this.state.storage.sql.exec(
          "INSERT INTO voice_counters(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at",
          keys[i],
          updated[i],
          expiresAt,
        );
      return operation === "release" ? 1 : [1, 0, ...updated];
    });
    await this.schedule();
    return Response.json(result);
  }
}
