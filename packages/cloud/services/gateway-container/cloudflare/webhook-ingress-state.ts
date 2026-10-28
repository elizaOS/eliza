import { createHash, timingSafeEqual } from "node:crypto";
import {
  HOLD_INDEX_KEY,
  HOLD_LEASE_PREFIX,
  HOLD_RECORD_PREFIX,
  isIngressKey,
  isIngressMarker,
} from "@elizaos/cloud-services-common/webhook-ingress";

type Row = { key: string; value: string; expiresAt: number | null };
type Due = { member: string; score: number };
const integer = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v);
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const keyValid = (v: unknown): v is string =>
  typeof v === "string" && isIngressKey(v);
const markerValid = (v: unknown): v is string =>
  typeof v === "string" && isIngressMarker(v);
/** One environment-local transaction owner for dedup, held payloads and their retry index. */
export class WebhookIngressState {
  constructor(private readonly state: DurableObjectState) {
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER)",
    );
    state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS expiry ON kv(expires_at) WHERE expires_at IS NOT NULL",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS due(member TEXT PRIMARY KEY,score REAL NOT NULL)",
    );
    state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS due_score ON due(score,member)",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS serving(id INTEGER PRIMARY KEY CHECK(id=1))",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS imported(id INTEGER PRIMARY KEY CHECK(id=1),fingerprint TEXT NOT NULL)",
    );
  }
  private get(key: string): string | null {
    return (
      this.state.storage.sql
        .exec<{ value: string }>("SELECT value FROM kv WHERE key=?", key)
        .toArray()[0]?.value ?? null
    );
  }
  private set(key: string, value: string, expiry: number | null): void {
    this.state.storage.sql.exec(
      "INSERT INTO kv VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at",
      key,
      value,
      expiry,
    );
  }
  private remove(key: string): number {
    const exists = this.get(key) !== null;
    this.state.storage.sql.exec("DELETE FROM kv WHERE key=?", key);
    return exists ? 1 : 0;
  }
  private async schedule(): Promise<void> {
    const row = this.state.storage.sql
      .exec<{ expires_at: number }>(
        "SELECT expires_at FROM kv WHERE expires_at IS NOT NULL ORDER BY expires_at LIMIT 1",
      )
      .toArray()[0];
    if (row)
      await this.state.storage.setAlarm(
        Math.max(Date.now() + 1, row.expires_at),
      );
  }
  async alarm(): Promise<void> {
    this.state.storage.sql.exec(
      "DELETE FROM kv WHERE expires_at<=?",
      Date.now(),
    );
    await this.schedule();
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return new Response("Invalid operation", { status: 400 });
    const input = raw as Record<string, unknown>;
    const {
      operation,
      key,
      value,
      ex,
      nx,
      seconds,
      member,
      score,
      min,
      max,
      limit,
    } = input;
    let snapshot: { kv: Row[]; due: Due[] } | undefined;
    if (operation === "import") {
      if (
        input.sourceQuiesced !== true ||
        !Array.isArray(input.kv) ||
        !Array.isArray(input.due)
      )
        return new Response("Quiesced snapshot required", { status: 400 });
      const kv = input.kv as Row[],
        due = input.due as Due[];
      if (
        kv.some(
          (r) =>
            !r ||
            !keyValid(r.key) ||
            typeof r.value !== "string" ||
            (r.expiresAt !== null &&
              (!integer(r.expiresAt) || r.expiresAt <= 0)),
        ) ||
        due.some((r) => !r || !markerValid(r.member) || !finite(r.score)) ||
        new Set(kv.map((r) => r.key)).size !== kv.length ||
        new Set(due.map((r) => r.member)).size !== due.length
      )
        return new Response("Invalid ingress snapshot", { status: 400 });
      snapshot = { kv, due };
    } else if (operation === "hold" || operation === "removeHeld") {
      const keys = input.keys,
        args = input.args;
      if (
        !Array.isArray(keys) ||
        keys.length !== 4 ||
        keys.some((k) => typeof k !== "string") ||
        !Array.isArray(args) ||
        args.some((a) => typeof a !== "string")
      )
        return new Response("Invalid hold transaction", { status: 400 });
      if (operation === "hold") {
        if (
          args.length !== 5 ||
          !markerValid(args[2]) ||
          (args[1] as string).trim() === "" ||
          !Number.isFinite(Number(args[1])) ||
          args[3] !== "held" ||
          keys[0] !== HOLD_RECORD_PREFIX + args[2] ||
          keys[1] !== HOLD_INDEX_KEY ||
          keys[2] !== args[2] ||
          keys[3] !==
            ((args[4] as string) ? HOLD_LEASE_PREFIX + args[2] : args[2])
        )
          return new Response("Invalid hold ownership", { status: 400 });
      } else if (
        args.length !== 3 ||
        !markerValid(args[1]) ||
        (args[2] !== "" && args[2] !== "held") ||
        keys[0] !== HOLD_LEASE_PREFIX + args[1] ||
        keys[1] !== HOLD_RECORD_PREFIX + args[1] ||
        keys[2] !== HOLD_INDEX_KEY ||
        keys[3] !== args[1]
      )
        return new Response("Invalid hold cleanup", { status: 400 });
    } else if (
      operation === "due" ||
      operation === "zadd" ||
      operation === "zrem"
    ) {
      if (key !== HOLD_INDEX_KEY)
        return new Response("Invalid retry index", { status: 400 });
      if (
        operation === "due"
          ? !finite(min) || !finite(max) || !integer(limit) || limit < 0
          : !markerValid(member) || (operation === "zadd" && !finite(score))
      )
        return new Response("Invalid retry operation", { status: 400 });
    } else {
      if (
        !keyValid(key) ||
        typeof operation !== "string" ||
        ![
          "get",
          "set",
          "del",
          "expire",
          "delIfEquals",
          "expireIfEquals",
        ].includes(operation)
      )
        return new Response("Invalid ingress operation", { status: 400 });
      if (
        ["set", "delIfEquals", "expireIfEquals"].includes(operation) &&
        typeof value !== "string"
      )
        return new Response("Invalid ingress value", { status: 400 });
      if (
        operation === "set" &&
        ((ex !== undefined &&
          (!integer(ex) ||
            ex <= 0 ||
            !Number.isSafeInteger(Date.now() + ex * 1000))) ||
          (nx !== undefined && typeof nx !== "boolean"))
      )
        return new Response("Invalid ingress expiry", { status: 400 });
      if (
        (operation === "expire" || operation === "expireIfEquals") &&
        (!integer(seconds) ||
          !Number.isSafeInteger(Date.now() + seconds * 1000))
      )
        return new Response("Invalid ingress expiry", { status: 400 });
    }
    const result = this.state.storage.transactionSync(() => {
      if (snapshot) {
        if (
          this.state.storage.sql.exec("SELECT id FROM serving").toArray().length
        )
          return { status: 409, value: null };
        const fingerprint = createHash("sha256")
          .update(JSON.stringify(snapshot))
          .digest("hex");
        const prior = this.state.storage.sql
          .exec<{ fingerprint: string }>("SELECT fingerprint FROM imported")
          .toArray()[0];
        if (prior && prior.fingerprint !== fingerprint)
          return { status: 409, value: null };
        if (!prior) {
          for (const row of snapshot.kv)
            if (row.expiresAt === null || row.expiresAt > Date.now())
              this.set(row.key, row.value, row.expiresAt);
          for (const row of snapshot.due)
            this.state.storage.sql.exec(
              "INSERT INTO due VALUES(?,?)",
              row.member,
              row.score,
            );
          this.state.storage.sql.exec(
            "INSERT INTO imported VALUES(1,?)",
            fingerprint,
          );
        }
        return { status: 200, value: { imported: true } };
      }
      this.state.storage.sql.exec("INSERT OR IGNORE INTO serving VALUES(1)");
      this.state.storage.sql.exec(
        "DELETE FROM kv WHERE expires_at<=?",
        Date.now(),
      );
      let result: unknown;
      const k = key as string;
      switch (operation) {
        case "get":
          result = this.get(k);
          break;
        case "set":
          if (nx === true && this.get(k) !== null) {
            result = null;
            break;
          }
          this.set(
            k,
            value as string,
            ex === undefined ? null : Date.now() + (ex as number) * 1000,
          );
          result = "OK";
          break;
        case "del":
          result = this.remove(k);
          break;
        case "delIfEquals":
          result = this.get(k) === value ? this.remove(k) : 0;
          break;
        case "expire":
        case "expireIfEquals":
          if (
            this.get(k) === null ||
            (operation === "expireIfEquals" && this.get(k) !== value)
          ) {
            result = 0;
            break;
          }
          if ((seconds as number) <= 0) this.remove(k);
          else
            this.state.storage.sql.exec(
              "UPDATE kv SET expires_at=? WHERE key=?",
              Date.now() + (seconds as number) * 1000,
              k,
            );
          result = 1;
          break;
        case "zadd": {
          const exists =
            this.state.storage.sql
              .exec("SELECT member FROM due WHERE member=?", member as string)
              .toArray().length > 0;
          this.state.storage.sql.exec(
            "INSERT INTO due VALUES(?,?) ON CONFLICT(member) DO UPDATE SET score=excluded.score",
            member as string,
            score as number,
          );
          result = exists ? 0 : 1;
          break;
        }
        case "zrem": {
          const exists =
            this.state.storage.sql
              .exec("SELECT member FROM due WHERE member=?", member as string)
              .toArray().length > 0;
          this.state.storage.sql.exec(
            "DELETE FROM due WHERE member=?",
            member as string,
          );
          result = exists ? 1 : 0;
          break;
        }
        case "due":
          result = this.state.storage.sql
            .exec<{ member: string }>(
              "SELECT member FROM due WHERE score>=? AND score<=? ORDER BY score,member LIMIT ?",
              min as number,
              max as number,
              limit as number,
            )
            .toArray()
            .map((r) => r.member);
          break;
        case "hold": {
          const keys = input.keys as string[],
            args = input.args as string[];
          if (args[4] !== "" && this.get(keys[3] as string) !== args[4]) {
            result = 0;
            break;
          }
          this.set(keys[0] as string, args[0] as string, null);
          this.set(keys[2] as string, args[3] as string, null);
          this.state.storage.sql.exec(
            "INSERT INTO due VALUES(?,?) ON CONFLICT(member) DO UPDATE SET score=excluded.score",
            args[2] as string,
            Number(args[1]),
          );
          result = 1;
          break;
        }
        case "removeHeld": {
          const keys = input.keys as string[],
            args = input.args as string[];
          const owner = this.get(keys[0] as string);
          if (
            (owner !== null && owner !== args[0]) ||
            (args[2] !== "" && this.get(keys[3] as string) === args[2])
          ) {
            result = 0;
            break;
          }
          this.remove(keys[1] as string);
          this.state.storage.sql.exec(
            "DELETE FROM due WHERE member=?",
            args[1] as string,
          );
          result = 1;
          break;
        }
      }
      return { status: 200, value: result };
    });
    await this.schedule();
    return Response.json(result.value, { status: result.status });
  }
}
export async function handleWebhookIngress(
  request: Request,
  env: {
    GATEWAY_KIND: string;
    GATEWAY_RUNTIME_CONFIG?: string;
    WEBHOOK_INGRESS_STATE?: DurableObjectNamespace;
  },
): Promise<Response> {
  if (env.GATEWAY_KIND !== "webhook")
    return new Response("Not found", { status: 404 });
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(env.GATEWAY_RUNTIME_CONFIG ?? "null");
  } catch {
    return new Response("Ingress unavailable", { status: 503 });
  }
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    config.CLOUD_WEBHOOK_INGRESS_BACKEND !== "cloudflare" ||
    typeof config.WEBHOOK_INGRESS_TOKEN !== "string" ||
    !config.WEBHOOK_INGRESS_TOKEN.trim() ||
    !env.WEBHOOK_INGRESS_STATE
  )
    return new Response("Ingress unavailable", { status: 503 });
  const expected = Buffer.from(`Bearer ${config.WEBHOOK_INGRESS_TOKEN}`),
    actual = Buffer.from(request.headers.get("Authorization") ?? "");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return new Response("Unauthorized", { status: 401 });
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !("operation" in input) ||
    typeof input.operation !== "string" ||
    ![
      "get",
      "set",
      "del",
      "expire",
      "delIfEquals",
      "expireIfEquals",
      "zadd",
      "zrem",
      "due",
      "hold",
      "removeHeld",
    ].includes(input.operation)
  )
    return new Response("Invalid operation", { status: 400 });
  return env.WEBHOOK_INGRESS_STATE.getByName("webhook-ingress-v1").fetch(
    "https://ingress.internal/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}
