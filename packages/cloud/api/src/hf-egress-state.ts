/** Private, atomic monthly egress accounting for one organization/month. */
export class HfEgressState {
  constructor(private readonly state: DurableObjectState) {
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS quota (id INTEGER PRIMARY KEY CHECK(id=1), used INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS serving (id INTEGER PRIMARY KEY CHECK(id=1))",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS imported (id INTEGER PRIMARY KEY CHECK(id=1), used INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    );
  }
  async alarm(): Promise<void> {
    this.state.storage.sql.exec(
      "DELETE FROM quota WHERE expires_at <= ?",
      Date.now(),
    );
    await this.schedule();
  }
  private async schedule(): Promise<void> {
    const row = this.state.storage.sql
      .exec<{ expires_at: number }>("SELECT expires_at FROM quota")
      .toArray()[0];
    if (row)
      await this.state.storage.setAlarm(
        Math.max(Date.now() + 1, row.expires_at),
      );
    else await this.state.storage.deleteAlarm();
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    const body: unknown = await request.json();
    if (!body || typeof body !== "object")
      return new Response("Invalid request", { status: 400 });
    const input = body as Record<string, unknown>;
    if (input.operation === "import") {
      const { usedBytes, expiresAt } = input;
      if (
        input.sourceQuiesced !== true ||
        typeof usedBytes !== "number" ||
        !Number.isSafeInteger(usedBytes) ||
        usedBytes < 0 ||
        typeof expiresAt !== "number" ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= 0
      )
        return new Response("Invalid quiesced snapshot", { status: 400 });
      const status = this.state.storage.transactionSync(() => {
        if (
          this.state.storage.sql.exec("SELECT id FROM serving").toArray().length
        )
          return 409;
        const prior = this.state.storage.sql
          .exec<{ used: number; expires_at: number }>(
            "SELECT used, expires_at FROM imported",
          )
          .toArray()[0];
        if (
          prior &&
          (prior.used !== usedBytes || prior.expires_at !== expiresAt)
        )
          return 409;
        this.state.storage.sql.exec(
          "INSERT OR IGNORE INTO imported VALUES(1,?,?)",
          usedBytes,
          expiresAt,
        );
        if (expiresAt > Date.now())
          this.state.storage.sql.exec(
            "INSERT OR IGNORE INTO quota VALUES(1,?,?)",
            usedBytes,
            expiresAt,
          );
        return 200;
      });
      await this.schedule();
      return Response.json({ imported: status === 200 }, { status });
    }
    const { operation, bytes, limitBytes } = input;
    if (
      (operation !== "reserve" && operation !== "release") ||
      typeof bytes !== "number" ||
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      (operation === "reserve" &&
        (typeof limitBytes !== "number" ||
          !Number.isSafeInteger(limitBytes) ||
          limitBytes <= 0))
    )
      return new Response("Invalid quota operation", { status: 400 });
    const result = this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec("INSERT OR IGNORE INTO serving VALUES(1)");
      this.state.storage.sql.exec(
        "DELETE FROM quota WHERE expires_at <= ?",
        Date.now(),
      );
      const current =
        this.state.storage.sql
          .exec<{ used: number }>("SELECT used FROM quota")
          .toArray()[0]?.used ?? 0;
      if (operation === "reserve" && bytes > (limitBytes as number) - current)
        return { allowed: false, usedBytes: current };
      const used =
        operation === "release"
          ? Math.max(0, current - bytes)
          : current + bytes;
      this.state.storage.sql.exec(
        "INSERT INTO quota VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET used=excluded.used,expires_at=excluded.expires_at",
        used,
        Date.now() + 35 * 24 * 60 * 60 * 1000,
      );
      return { allowed: true, usedBytes: used };
    });
    await this.schedule();
    return Response.json(result);
  }
}
