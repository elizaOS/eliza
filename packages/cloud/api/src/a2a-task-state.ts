import { createHash } from "node:crypto";
import type { TaskStoreEntry } from "@elizaos/cloud-shared/lib/services/a2a-task-store";
import type { A2ATaskSnapshot } from "@elizaos/cloud-shared/lib/services/cloudflare-a2a-task-store";

/** One private object owns an organization's tasks and listing index. */
export class A2ATaskState {
  constructor(private readonly state: DurableObjectState) {
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, entry TEXT NOT NULL, version TEXT NOT NULL, score REAL NOT NULL, expires_at INTEGER NOT NULL)",
    );
    state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS task_expiry ON tasks(expires_at)",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), organization TEXT NOT NULL)",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS serving (id INTEGER PRIMARY KEY CHECK(id=1))",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)",
    );
  }
  private validEntry(
    value: unknown,
    taskId: unknown,
    organization: string,
  ): value is TaskStoreEntry {
    if (!value || typeof value !== "object") return false;
    const row = value as Partial<TaskStoreEntry>;
    return (
      row.organizationId === organization &&
      typeof row.userId === "string" &&
      row.userId.length > 0 &&
      typeof row.createdAt === "string" &&
      typeof row.updatedAt === "string" &&
      !!row.task &&
      row.task.id === taskId &&
      !!row.task.status &&
      typeof row.task.status.state === "string"
    );
  }
  private async schedule(): Promise<void> {
    const row = this.state.storage.sql
      .exec<{ expires_at: number }>(
        "SELECT expires_at FROM tasks ORDER BY expires_at LIMIT 1",
      )
      .toArray()[0];
    if (row)
      await this.state.storage.setAlarm(
        Math.max(Date.now() + 1, row.expires_at),
      );
    else await this.state.storage.deleteAlarm();
  }
  async alarm(): Promise<void> {
    this.state.storage.sql.exec(
      "DELETE FROM tasks WHERE expires_at <= ?",
      Date.now(),
    );
    await this.schedule();
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    const body: unknown = await request.json();
    if (!body || typeof body !== "object")
      return new Response("Invalid request", { status: 400 });
    const input = body as Record<string, unknown>;
    const { operation, organizationId, taskId, entry, version } = input;
    if (typeof organizationId !== "string" || !organizationId)
      return new Response("Missing organization", { status: 400 });
    if (!["get", "set", "delete", "list", "import"].includes(String(operation)))
      return new Response("Invalid operation", { status: 400 });
    if (
      operation !== "list" &&
      operation !== "import" &&
      (typeof taskId !== "string" || !taskId)
    )
      return new Response("Missing task", { status: 400 });
    if (
      operation === "set" &&
      (!this.validEntry(entry, taskId, organizationId) ||
        (version !== undefined && typeof version !== "string"))
    )
      return new Response("Invalid task entry", { status: 400 });
    if (
      operation === "list" &&
      (typeof input.limit !== "number" ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 0)
    )
      return new Response("Invalid listing limit", { status: 400 });
    let snapshots: A2ATaskSnapshot[] = [];
    if (operation === "import") {
      if (input.sourceQuiesced !== true || !Array.isArray(input.entries))
        return new Response("Quiesced snapshot required", { status: 400 });
      const seen = new Set<string>();
      for (const row of input.entries) {
        if (
          !row ||
          typeof row !== "object" ||
          typeof row.taskId !== "string" ||
          !row.taskId ||
          seen.has(row.taskId) ||
          !this.validEntry(row.entry, row.taskId, organizationId) ||
          !Number.isFinite(row.score) ||
          !Number.isSafeInteger(row.expiresAt) ||
          row.expiresAt <= 0
        )
          return new Response("Invalid snapshot", { status: 400 });
        seen.add(row.taskId);
      }
      snapshots = input.entries;
    }
    const fingerprint = (row: A2ATaskSnapshot) =>
      createHash("sha256")
        .update(JSON.stringify([row.entry, row.score, row.expiresAt]))
        .digest("hex");
    const result = this.state.storage.transactionSync(() => {
      const owner = this.state.storage.sql
        .exec<{ organization: string }>("SELECT organization FROM owner")
        .toArray()[0];
      if (owner && owner.organization !== organizationId)
        return { status: 403, value: null };
      this.state.storage.sql.exec(
        "INSERT OR IGNORE INTO owner VALUES(1,?)",
        organizationId,
      );
      this.state.storage.sql.exec(
        "DELETE FROM tasks WHERE expires_at <= ?",
        Date.now(),
      );
      if (operation === "import") {
        if (
          this.state.storage.sql.exec("SELECT id FROM serving").toArray().length
        )
          return { status: 409, value: null };
        for (const row of snapshots) {
          const prior = this.state.storage.sql
            .exec<{ fingerprint: string }>(
              "SELECT fingerprint FROM imports WHERE id=?",
              row.taskId,
            )
            .toArray()[0];
          if (prior && prior.fingerprint !== fingerprint(row))
            return { status: 409, value: null };
        }
        for (const row of snapshots) {
          const data = JSON.stringify(row.entry);
          this.state.storage.sql.exec(
            "INSERT OR IGNORE INTO imports VALUES(?,?)",
            row.taskId,
            fingerprint(row),
          );
          if (row.expiresAt > Date.now())
            this.state.storage.sql.exec(
              "INSERT OR IGNORE INTO tasks VALUES(?,?,?,?,?)",
              row.taskId,
              data,
              crypto.randomUUID(),
              row.score,
              row.expiresAt,
            );
        }
        return { status: 200, value: snapshots.length };
      }
      this.state.storage.sql.exec("INSERT OR IGNORE INTO serving VALUES(1)");
      if (operation === "list") {
        const rows = this.state.storage.sql
          .exec<{ entry: string }>(
            "SELECT entry FROM tasks ORDER BY score DESC,id DESC LIMIT ?",
            input.limit === 0 ? -1 : (input.limit as number),
          )
          .toArray();
        return { status: 200, value: rows.map((row) => JSON.parse(row.entry)) };
      }
      const current = this.state.storage.sql
        .exec<{ entry: string; version: string }>(
          "SELECT entry,version FROM tasks WHERE id=?",
          taskId as string,
        )
        .toArray()[0];
      if (operation === "get")
        return {
          status: 200,
          value: current
            ? { entry: JSON.parse(current.entry), version: current.version }
            : null,
        };
      if (operation === "delete") {
        this.state.storage.sql.exec(
          "DELETE FROM tasks WHERE id=?",
          taskId as string,
        );
        return { status: 200, value: !!current };
      }
      if (version !== undefined && current?.version !== version)
        return { status: 200, value: false };
      this.state.storage.sql.exec(
        "INSERT INTO tasks VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET entry=excluded.entry,version=excluded.version,score=excluded.score,expires_at=excluded.expires_at",
        taskId as string,
        JSON.stringify(entry),
        crypto.randomUUID(),
        Date.now(),
        Date.now() + 3_600_000,
      );
      return { status: 200, value: true };
    });
    await this.schedule();
    return Response.json(result.value, { status: result.status });
  }
}
