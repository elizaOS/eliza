/** Durable, time-bucketed USD telemetry. PostgreSQL owns vault spend enforcement. */
import { DurableObject } from "cloudflare:workers";

type Bucket = { key: string; ttlSeconds: number };
type Stored = { total: number; tenant: string; hosts: string };
const validKey = (key: unknown): key is string =>
  typeof key === "string" && key.startsWith("spend:") && key.length > 6;
const validBucket = (value: unknown): value is Bucket =>
  !!value &&
  typeof value === "object" &&
  "key" in value &&
  validKey(value.key) &&
  "ttlSeconds" in value &&
  typeof value.ttlSeconds === "number" &&
  [172800, 691200, 2764800].includes(value.ttlSeconds);

export class LoginSpendMetrics extends DurableObject<Record<string, unknown>> {
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS spend_metrics (
      key TEXT PRIMARY KEY, total INTEGER NOT NULL, tenant TEXT NOT NULL,
      hosts TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS spend_metrics_expiry ON spend_metrics(expires_at)",
    );
  }

  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec(
      "DELETE FROM spend_metrics WHERE expires_at <= ?",
      Date.now(),
    );
    const { count } = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT count(*) AS count FROM spend_metrics")
      .one();
    if (count > 0) await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
  }

  async fetch(request: Request): Promise<Response> {
    const operation = new URL(request.url).pathname.split("/").pop();
    if (
      request.method !== "POST" ||
      !["record", "read"].includes(operation ?? "")
    )
      return new Response("Not found", { status: 404 });
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return Response.json(
        { code: "SPEND_METRICS_REQUEST_INVALID" },
        { status: 400 },
      );
    }
    if (!input || typeof input !== "object")
      return Response.json(
        { code: "SPEND_METRICS_REQUEST_INVALID" },
        { status: 400 },
      );
    const now = Date.now();
    if (operation === "read") {
      if (!("key" in input) || !validKey(input.key))
        return Response.json(
          { code: "SPEND_METRICS_REQUEST_INVALID" },
          { status: 400 },
        );
      const row = this.ctx.storage.sql
        .exec<Stored>(
          "SELECT total, tenant, hosts FROM spend_metrics WHERE key = ? AND expires_at > ?",
          input.key,
          now,
        )
        .toArray()[0];
      return Response.json(
        row
          ? { total: row.total, hosts: JSON.parse(row.hosts) }
          : { total: 0, hosts: {} },
      );
    }
    if (
      !("buckets" in input) ||
      !Array.isArray(input.buckets) ||
      input.buckets.length === 0 ||
      !input.buckets.every(validBucket) ||
      !("units" in input) ||
      typeof input.units !== "number" ||
      !Number.isSafeInteger(input.units) ||
      input.units <= 0 ||
      !("tenantId" in input) ||
      typeof input.tenantId !== "string" ||
      !input.tenantId ||
      !("host" in input) ||
      typeof input.host !== "string" ||
      !input.host
    )
      return Response.json(
        { code: "SPEND_METRICS_REQUEST_INVALID" },
        { status: 400 },
      );
    const { buckets, units, tenantId, host } = input;
    if (new Set(buckets.map((bucket) => bucket.key)).size !== buckets.length)
      return Response.json(
        { code: "SPEND_METRICS_REQUEST_INVALID" },
        { status: 400 },
      );
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(now + 86_400_000);
    const result = this.ctx.storage.transactionSync(() => {
      const updates: Array<{
        bucket: Bucket;
        total: number;
        hosts: Record<string, number>;
      }> = [];
      for (const bucket of buckets) {
        const row = this.ctx.storage.sql
          .exec<Stored>(
            "SELECT total, tenant, hosts FROM spend_metrics WHERE key = ? AND expires_at > ?",
            bucket.key,
            now,
          )
          .toArray()[0];
        if (row && row.tenant !== tenantId)
          return { code: "SPEND_METRICS_TENANT_CONFLICT" };
        const hosts: Record<string, number> = row
          ? Object.assign(Object.create(null), JSON.parse(row.hosts))
          : Object.create(null);
        const hostTotal =
          (Object.hasOwn(hosts, host) ? hosts[host] : 0) + units;
        const total = (row?.total ?? 0) + units;
        if (!Number.isSafeInteger(total) || !Number.isSafeInteger(hostTotal))
          return { code: "SPEND_METRICS_OVERFLOW" };
        hosts[host] = hostTotal;
        updates.push({ bucket, total, hosts });
      }
      for (const { bucket, total, hosts } of updates) {
        this.ctx.storage.sql.exec(
          "INSERT INTO spend_metrics(key,total,tenant,hosts,expires_at) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET total=excluded.total, tenant=excluded.tenant, hosts=excluded.hosts, expires_at=excluded.expires_at",
          bucket.key,
          total,
          tenantId,
          JSON.stringify(hosts),
          now + bucket.ttlSeconds * 1000,
        );
      }
      return { recorded: true };
    });
    return Response.json(result, { status: "code" in result ? 409 : 200 });
  }
}
