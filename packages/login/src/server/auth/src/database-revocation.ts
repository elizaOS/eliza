/** Persists logout and monotonic account revocation in the identity database across restarts. */
import { ElizaError } from "@elizaos/core/errors";
import { createDatabaseAuthSql } from "./auth-sql";
import type { RevocationStore } from "./revocation";

const DEFAULT_REVOCATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function expiry(value: Date | number): string {
  const milliseconds =
    value instanceof Date
      ? value.getTime()
      : value > 10_000_000_000
        ? value
        : value * 1000;
  return new Date(milliseconds).toISOString();
}

function issuedBefore(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new ElizaError("Stored revocation timestamp is invalid", {
      code: "LOGIN_REVOCATION_INVALID",
    });
  }
  return result;
}

export class DatabaseRevocationStore implements RevocationStore {
  private readonly sql = createDatabaseAuthSql();

  async revokeToken(jti: string, expiresAt: Date | number): Promise<void> {
    await this.sql`
      INSERT INTO auth_kv_store (id, namespace, value, expires_at)
      VALUES (${jti}, 'revocation:jti', 'revoked', ${expiry(expiresAt)})
      ON CONFLICT (id, namespace) DO UPDATE
      SET expires_at = GREATEST(auth_kv_store.expires_at, EXCLUDED.expires_at)
    `;
  }

  async isRevoked(jti: string): Promise<boolean> {
    const rows = await this.sql<Array<{ id: string }>>`
      SELECT id FROM auth_kv_store WHERE id = ${jti}
        AND namespace = 'revocation:jti' AND expires_at > clock_timestamp()
    `;
    return rows.length > 0;
  }

  private async revokeLine(
    namespace: string,
    id: string,
    timestamp: number,
    expiresAt: Date | number,
  ): Promise<number> {
    issuedBefore(String(timestamp));
    const [row] = await this.sql<Array<{ value: string }>>`
      INSERT INTO auth_kv_store (id, namespace, value, expires_at)
      VALUES (${id}, ${namespace}, ${String(timestamp)}, ${expiry(expiresAt)})
      ON CONFLICT (id, namespace) DO UPDATE SET
        value = CASE WHEN auth_kv_store.expires_at > clock_timestamp()
          THEN GREATEST(auth_kv_store.value::bigint, EXCLUDED.value::bigint)::text
          ELSE EXCLUDED.value END,
        expires_at = GREATEST(auth_kv_store.expires_at, EXCLUDED.expires_at)
      RETURNING value
    `;
    return issuedBefore(row.value);
  }

  private async readLine(
    namespace: string,
    id: string,
  ): Promise<number | null> {
    const [row] = await this.sql<Array<{ value: string }>>`
      SELECT value FROM auth_kv_store WHERE id = ${id}
        AND namespace = ${namespace} AND expires_at > clock_timestamp()
    `;
    return row ? issuedBefore(row.value) : null;
  }

  revokeAgentTokens(
    agentId: string,
    timestamp = Math.floor(Date.now() / 1000),
    expiresAt: Date | number = Date.now() + DEFAULT_REVOCATION_TTL_MS,
  ): Promise<number> {
    return this.revokeLine("revocation:agent", agentId, timestamp, expiresAt);
  }

  getAgentRevokedBefore(agentId: string): Promise<number | null> {
    return this.readLine("revocation:agent", agentId);
  }

  revokeUserTokens(
    userId: string,
    timestamp = Math.floor(Date.now() / 1000),
    expiresAt: Date | number = Date.now() + DEFAULT_REVOCATION_TTL_MS,
  ): Promise<number> {
    return this.revokeLine("revocation:user", userId, timestamp, expiresAt);
  }

  getUserRevokedBefore(userId: string): Promise<number | null> {
    return this.readLine("revocation:user", userId);
  }
}
