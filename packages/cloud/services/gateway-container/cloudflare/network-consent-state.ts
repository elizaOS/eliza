import { createHash, timingSafeEqual } from "node:crypto";
import {
  CONSENT_HISTORY_LIMIT,
  consentAddress,
  type NetworkConsentEntry,
  parseConsentEntry,
} from "@elizaos/cloud-services-common/network-consent";

export function networkConsentOwner(project: string, address: string): string {
  return `consent-v1:${createHash("sha256")
    .update(JSON.stringify([project, consentAddress(address)]))
    .digest("hex")}`;
}
const scope = (app: NetworkConsentEntry["app"]) => app ?? "global";
const validApp = (app: unknown) =>
  app === undefined ||
  app === null ||
  (typeof app === "string" &&
    ["ntwrk", "slop", "peon", "friends"].includes(app));
function entryFor(
  value: unknown,
  project: string,
  address: string,
): NetworkConsentEntry | null {
  const entry = parseConsentEntry(value);
  return entry &&
    entry.project === project &&
    entry.address === address &&
    validApp(entry.app) &&
    ["telegram", "blooio", "twilio", "whatsapp"].includes(entry.channel)
    ? entry
    : null;
}
/** One durable owner per project/address; consent never expires. */
export class NetworkConsentState {
  constructor(private readonly state: DurableObjectState) {
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1), project TEXT NOT NULL,address TEXT NOT NULL)",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS current_state(scope TEXT PRIMARY KEY, entry TEXT NOT NULL)",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY AUTOINCREMENT,entry TEXT NOT NULL)",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS serving(id INTEGER PRIMARY KEY CHECK(id=1))",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS imported(id INTEGER PRIMARY KEY CHECK(id=1),snapshot TEXT NOT NULL)",
    );
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    const body: unknown = await request.json();
    if (!body || typeof body !== "object")
      return new Response("Invalid request", { status: 400 });
    const input = body as Record<string, unknown>;
    const { operation, project, address, app } = input;
    if (
      typeof project !== "string" ||
      !project ||
      typeof address !== "string" ||
      !address ||
      consentAddress(address) !== address ||
      !validApp(app)
    )
      return new Response("Invalid consent identity", { status: 400 });
    if (
      typeof operation !== "string" ||
      !["current", "record", "import", "history"].includes(operation)
    )
      return new Response("Invalid operation", { status: 400 });
    const entry =
      operation === "record" ? entryFor(input.entry, project, address) : null;
    if (operation === "record" && !entry)
      return new Response("Invalid consent entry", { status: 400 });
    let snapshot: {
      current: NetworkConsentEntry[];
      history: NetworkConsentEntry[];
    } | null = null;
    if (operation === "import") {
      if (
        input.sourceQuiesced !== true ||
        !Array.isArray(input.current) ||
        !Array.isArray(input.history)
      )
        return new Response("Quiesced snapshot required", { status: 400 });
      const current = input.current.map((v) => entryFor(v, project, address));
      const history = input.history.map((v) => entryFor(v, project, address));
      if (
        current.some((v) => !v) ||
        history.some((v) => !v) ||
        new Set(current.map((v) => scope(v?.app))).size !== current.length
      )
        return new Response("Invalid consent snapshot", { status: 400 });
      snapshot = {
        current: current as NetworkConsentEntry[],
        history: history as NetworkConsentEntry[],
      };
    }
    const result = this.state.storage.transactionSync(() => {
      const priorOwner = this.state.storage.sql
        .exec<{ project: string; address: string }>(
          "SELECT project,address FROM owner",
        )
        .toArray()[0];
      if (
        priorOwner &&
        (priorOwner.project !== project || priorOwner.address !== address)
      )
        return { status: 403, value: null };
      this.state.storage.sql.exec(
        "INSERT OR IGNORE INTO owner VALUES(1,?,?)",
        project,
        address,
      );
      if (snapshot) {
        if (
          this.state.storage.sql.exec("SELECT id FROM serving").toArray().length
        )
          return { status: 409, value: null };
        const serialized = JSON.stringify(snapshot);
        const prior = this.state.storage.sql
          .exec<{ snapshot: string }>("SELECT snapshot FROM imported")
          .toArray()[0];
        if (prior && prior.snapshot !== serialized)
          return { status: 409, value: null };
        if (!prior) {
          for (const row of snapshot.current)
            this.state.storage.sql.exec(
              "INSERT INTO current_state VALUES(?,?)",
              scope(row.app),
              JSON.stringify(row),
            );
          // Redis LPUSH keeps newest first; SQLite IDs preserve that order on DESC reads.
          for (const row of [...snapshot.history].reverse())
            this.state.storage.sql.exec(
              "INSERT INTO history(entry) VALUES(?)",
              JSON.stringify(row),
            );
          this.state.storage.sql.exec(
            "INSERT INTO imported VALUES(1,?)",
            serialized,
          );
        }
        return { status: 200, value: { imported: true } };
      }
      this.state.storage.sql.exec("INSERT OR IGNORE INTO serving VALUES(1)");
      if (operation === "history")
        return {
          status: 200,
          value: this.state.storage.sql
            .exec<{ entry: string }>(
              "SELECT entry FROM history ORDER BY id DESC",
            )
            .toArray()
            .map((r) => JSON.parse(r.entry)),
        };
      const row = this.state.storage.sql
        .exec<{ entry: string }>(
          "SELECT entry FROM current_state WHERE scope=?",
          scope(
            operation === "record"
              ? entry?.app
              : (app as NetworkConsentEntry["app"]),
          ),
        )
        .toArray()[0];
      const old = row ? entryFor(row.entry, project, address) : null;
      if (row && !old) return { status: 500, value: null };
      if (operation === "current") return { status: 200, value: old };
      if (!entry) return { status: 400, value: null };
      const normalized = { ...entry, at: new Date(entry.at).toISOString() };
      if (
        old &&
        (Date.parse(old.at) > Date.parse(normalized.at) ||
          (Date.parse(old.at) === Date.parse(normalized.at) &&
            (old.state === normalized.state || old.state === "opted_out")))
      )
        return { status: 200, value: { accepted: true, changed: false } };
      const serialized = JSON.stringify(normalized);
      this.state.storage.sql.exec(
        "INSERT INTO current_state VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET entry=excluded.entry",
        scope(normalized.app),
        serialized,
      );
      this.state.storage.sql.exec(
        "INSERT INTO history(entry) VALUES(?)",
        serialized,
      );
      this.state.storage.sql.exec(
        "DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT ?)",
        CONSENT_HISTORY_LIMIT,
      );
      return { status: 200, value: { accepted: true, changed: true } };
    });
    return Response.json(result.value, { status: result.status });
  }
}

/** Authenticated gateway-only transport; import and history are private-binding operations. */
export async function handleNetworkConsent(
  request: Request,
  env: {
    GATEWAY_KIND: string;
    GATEWAY_RUNTIME_CONFIG?: string;
    NETWORK_CONSENT_STATE?: DurableObjectNamespace;
  },
): Promise<Response> {
  if (env.GATEWAY_KIND !== "webhook")
    return new Response("Not found", { status: 404 });
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(env.GATEWAY_RUNTIME_CONFIG ?? "null");
  } catch {
    return new Response("Consent service unavailable", { status: 503 });
  }
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    config.CLOUD_NETWORK_CONSENT_BACKEND !== "cloudflare" ||
    typeof config.NETWORK_CONSENT_TOKEN !== "string" ||
    !config.NETWORK_CONSENT_TOKEN.trim() ||
    !env.NETWORK_CONSENT_STATE
  )
    return new Response("Consent service unavailable", { status: 503 });
  const expected = Buffer.from(`Bearer ${config.NETWORK_CONSENT_TOKEN}`);
  const actual = Buffer.from(request.headers.get("Authorization") ?? "");
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
  if (!body || typeof body !== "object")
    return new Response("Invalid operation", { status: 400 });
  const input = body as Record<string, unknown>;
  if (
    typeof input.operation !== "string" ||
    !["current", "record"].includes(input.operation) ||
    typeof input.project !== "string" ||
    !input.project ||
    typeof input.address !== "string" ||
    !input.address
  )
    return new Response("Invalid operation", { status: 400 });
  return env.NETWORK_CONSENT_STATE.getByName(
    networkConsentOwner(input.project, input.address),
  ).fetch("https://consent.internal/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}
