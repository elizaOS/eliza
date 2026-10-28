/** Authoritative rolling policy events persisted independently of login requests. */
import { DurableObject } from "cloudflare:workers";

const RETENTION_MS = 2_592_000_000;
const keyIsValid = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("agg:") && value.length > 4;
const timeIsValid = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export class LoginAggregations extends DurableObject<Record<string, unknown>> {
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS policy_events (
      key TEXT NOT NULL, member TEXT NOT NULL, occurred_at INTEGER NOT NULL,
      PRIMARY KEY (key, member)
    )`);
    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS policy_events_retention ON policy_events(occurred_at)",
    );
    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS policy_events_time ON policy_events(key, occurred_at)",
    );
  }

  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec(
      "DELETE FROM policy_events WHERE occurred_at <= ?",
      Date.now() - RETENTION_MS,
    );
    const { count } = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT count(*) AS count FROM policy_events")
      .one();
    if (count > 0) await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
  }

  async fetch(request: Request): Promise<Response> {
    const operation = new URL(request.url).pathname.split("/").pop();
    if (
      request.method !== "POST" ||
      !["record", "read"].includes(operation ?? "")
    ) {
      return new Response("Not found", { status: 404 });
    }
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return Response.json(
        { code: "AGGREGATION_REQUEST_INVALID" },
        { status: 400 },
      );
    }
    if (
      !input ||
      typeof input !== "object" ||
      !("now" in input) ||
      !timeIsValid(input.now)
    ) {
      return Response.json(
        { code: "AGGREGATION_REQUEST_INVALID" },
        { status: 400 },
      );
    }
    const now = input.now;
    if (operation === "record") {
      if (
        !("records" in input) ||
        !Array.isArray(input.records) ||
        input.records.length === 0 ||
        !input.records.every(
          (record: unknown) =>
            record &&
            typeof record === "object" &&
            "key" in record &&
            keyIsValid(record.key) &&
            "member" in record &&
            typeof record.member === "string" &&
            record.member.length > 0,
        )
      ) {
        return Response.json(
          { code: "AGGREGATION_REQUEST_INVALID" },
          { status: 400 },
        );
      }
      const records = input.records as Array<{ key: string; member: string }>;
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
      }
      this.ctx.storage.transactionSync(() => {
        for (const { key, member } of records) {
          this.ctx.storage.sql.exec(
            "DELETE FROM policy_events WHERE key = ? AND occurred_at <= ?",
            key,
            now - RETENTION_MS,
          );
          this.ctx.storage.sql.exec(
            "INSERT INTO policy_events(key, member, occurred_at) VALUES (?, ?, ?) ON CONFLICT(key, member) DO UPDATE SET occurred_at = excluded.occurred_at",
            key,
            member,
            now,
          );
        }
      });
      return Response.json({ recorded: true });
    }
    if (
      !("key" in input) ||
      !keyIsValid(input.key) ||
      !("windowStart" in input) ||
      typeof input.windowStart !== "number" ||
      !Number.isSafeInteger(input.windowStart) ||
      input.windowStart >= now ||
      input.windowStart < now - RETENTION_MS
    ) {
      return Response.json(
        { code: "AGGREGATION_REQUEST_INVALID" },
        { status: 400 },
      );
    }
    const key = input.key;
    const windowStart = input.windowStart;
    const members = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM policy_events WHERE key = ? AND occurred_at <= ?",
        key,
        now - RETENTION_MS,
      );
      return this.ctx.storage.sql
        .exec<{ member: string }>(
          "SELECT member FROM policy_events WHERE key = ? AND occurred_at > ? AND occurred_at <= ? ORDER BY occurred_at, member",
          key,
          windowStart,
          now,
        )
        .toArray()
        .map((row) => row.member);
    });
    return Response.json({ members });
  }
}
