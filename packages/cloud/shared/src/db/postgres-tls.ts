/** Dependency-light TLS policy shared by database clients and operator audits. */
import type { PoolConfig } from "pg";

export function isLocalTcpPostgresUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
    );
  } catch {
    // error-policy:J3 malformed URLs remain explicitly non-local.
    return false;
  }
}

/** Keeps TLS while allowing an explicit self-signed managed-provider opt-out. */
export function shouldSkipTlsVerification(url: string): boolean {
  if (process.env.DATABASE_SSL_NO_VERIFY === "true") return true;
  try {
    return new URL(url).searchParams.get("sslmode") === "no-verify";
  } catch {
    // error-policy:J3 malformed URLs cannot opt out of strict verification.
    return false;
  }
}

/** Enforces encrypted remote PostgreSQL transport and rejects insecure modes. */
export function enforceTlsForRemote(url: string): {
  url: string;
  ssl: PoolConfig["ssl"];
} {
  if (isLocalTcpPostgresUrl(url)) return { url, ssl: undefined };
  const skipVerify = shouldSkipTlsVerification(url);
  let normalized = url;
  try {
    const parsed = new URL(url);
    const sslmode = parsed.searchParams.get("sslmode");
    if (sslmode === "disable" || sslmode === "allow") {
      throw new Error(
        `Refusing to connect: remote DATABASE_URL has sslmode=${sslmode}. Remote Postgres connections must use TLS (SOC2 CC6.7).`,
      );
    }
    if (!sslmode) {
      parsed.searchParams.set("sslmode", skipVerify ? "no-verify" : "require");
      normalized = parsed.toString();
    }
  } catch (error) {
    // error-policy:J3 preserve malformed URLs for node-postgres to reject.
    if (
      error instanceof Error &&
      error.message.startsWith("Refusing to connect")
    ) {
      throw error;
    }
    // Preserve the original string so node-postgres owns the parse failure.
  }
  return {
    url: normalized,
    ssl: { rejectUnauthorized: !skipVerify },
  };
}
