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

/**
 * Whether to keep TLS but skip server-certificate verification.
 *
 * Managed providers like Railway terminate the public TCP proxy with a
 * self-signed certificate, so strict CA verification fails even though the
 * connection is fully encrypted. Opt in — per the provider's own guidance —
 * with `DATABASE_SSL_NO_VERIFY=true` or `?sslmode=no-verify` on the URL. The
 * default stays strict; this never disables encryption (only verification).
 */
export function shouldSkipTlsVerification(url: string): boolean {
  if (process.env.DATABASE_SSL_NO_VERIFY === "true") return true;
  try {
    return new URL(url).searchParams.get("sslmode") === "no-verify";
  } catch {
    // error-policy:J3 malformed URLs cannot opt out of strict verification.
    return false;
  }
}

/**
 * Enforce TLS on remote Postgres connections (D-2 / SOC2 CC6.7).
 *
 * Local (127.0.0.1 / localhost) connections may run without TLS for dev.
 * Anything else must use TLS — both via the URL `sslmode` parameter (so it
 * survives external connection-pool configs) AND via the `ssl` option on the
 * pg driver (so the handshake is enforced even if the parameter is dropped by
 * a proxy). We fail closed: `sslmode=disable`/`allow` is rejected outright, and
 * certificate verification stays on (`rejectUnauthorized: true`) unless the
 * operator explicitly opts into `no-verify` for a self-signed managed proxy
 * (the connection remains encrypted; only CA verification is relaxed).
 */
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
    if (error instanceof Error && error.message.startsWith("Refusing to connect")) {
      throw error;
    }
    // Preserve the original string so node-postgres owns the parse failure.
  }
  return {
    url: normalized,
    ssl: { rejectUnauthorized: !skipVerify },
  };
}
