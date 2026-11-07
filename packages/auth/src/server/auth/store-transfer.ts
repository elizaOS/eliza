/** Transfers quiesced Redis login records into the existing PostgreSQL store. */
import { ElizaError } from "@elizaos/core";
import type { Sql } from "postgres";

const namespaces = new Set([
  "challenge",
  "token",
  "mfa",
  "siwe-nonce",
  "import-session",
]);

function invalidSnapshot(): never {
  throw new ElizaError("Invalid login state snapshot", {
    code: "LOGIN_STATE_SNAPSHOT_INVALID",
  });
}

function parseSnapshot(input: unknown) {
  if (
    !input ||
    typeof input !== "object" ||
    !("entries" in input) ||
    !Array.isArray(input.entries) ||
    !("capturedAtMs" in input) ||
    !Number.isSafeInteger(input.capturedAtMs) ||
    Number(input.capturedAtMs) <= 0
  ) {
    return invalidSnapshot();
  }
  const identities = new Set<string>();
  return input.entries.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("key" in entry) ||
      typeof entry.key !== "string" ||
      !("value" in entry) ||
      typeof entry.value !== "string" ||
      !("expiresAtMs" in entry) ||
      !Number.isSafeInteger(entry.expiresAtMs) ||
      Number(entry.expiresAtMs) <= 0
    ) {
      return invalidSnapshot();
    }
    let namespace: string;
    let id: string;
    const auth = /^auth:([^:]+):(.+)$/.exec(entry.key);
    if (auth && namespaces.has(auth[1])) {
      [, namespace, id] = auth;
    } else if (
      entry.key.startsWith("idempotency:") &&
      !entry.key.startsWith("idempotency:metrics:")
    ) {
      namespace = "idempotency";
      id = entry.key.slice("idempotency:".length);
    } else {
      return invalidSnapshot();
    }
    if (!id) return invalidSnapshot();
    const identity = JSON.stringify([namespace, id]);
    if (identities.has(identity)) return invalidSnapshot();
    identities.add(identity);
    const expiry = new Date(Number(entry.expiresAtMs));
    if (!Number.isFinite(expiry.getTime())) return invalidSnapshot();
    return {
      id,
      namespace,
      value: entry.value,
      expires_at: expiry.toISOString(),
    };
  });
}

/** Caller must stop source writers before apply; validation never changes records. */
export async function transferLoginState(
  sql: Sql,
  snapshot: unknown,
  mode: "validate" | "apply-quiesced",
): Promise<{
  entries: number;
  live: number;
  conflicts: number;
  applied: boolean;
}> {
  const entries = parseSnapshot(snapshot);
  const result = await sql.begin(
    mode === "validate" ? "isolation level repeatable read read only" : "",
    async (transaction) => {
      if (mode === "apply-quiesced") {
        // Serialize the conflict check and publication with all destination writes.
        await transaction`LOCK TABLE auth_kv_store IN SHARE ROW EXCLUSIVE MODE`;
      }
      const [counts] = await transaction<{ live: number; conflicts: number }[]>`
        WITH incoming AS (
          SELECT * FROM jsonb_to_recordset(${sql.json(entries)})
          AS record(id text, namespace text, value text, expires_at timestamptz)
        )
        SELECT count(*)::integer AS live,
          count(*) FILTER (WHERE existing.expires_at > clock_timestamp()
            AND existing.value <> incoming.value)::integer AS conflicts
        FROM incoming LEFT JOIN auth_kv_store existing
          ON existing.id = incoming.id AND existing.namespace = incoming.namespace
        WHERE incoming.expires_at > clock_timestamp()
      `;
      if (counts.conflicts > 0) {
        throw new ElizaError(
          "Destination login state conflicts with the snapshot",
          {
            code: "LOGIN_STATE_TRANSFER_CONFLICT",
            context: { conflicts: counts.conflicts },
          },
        );
      }
      if (mode === "apply-quiesced") {
        await transaction`
          INSERT INTO auth_kv_store (id, namespace, value, expires_at)
          SELECT id, namespace, value, expires_at
          FROM jsonb_to_recordset(${sql.json(entries)})
            AS record(id text, namespace text, value text, expires_at timestamptz)
          WHERE expires_at > clock_timestamp()
          ON CONFLICT (id, namespace) DO UPDATE SET
            value = EXCLUDED.value,
            expires_at = CASE WHEN auth_kv_store.expires_at > clock_timestamp()
              THEN LEAST(auth_kv_store.expires_at, EXCLUDED.expires_at)
              ELSE EXCLUDED.expires_at END
        `;
      }
      return {
        entries: entries.length,
        ...counts,
        applied: mode === "apply-quiesced",
      };
    },
  );
  return result;
}
