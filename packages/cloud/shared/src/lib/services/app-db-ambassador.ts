/**
 * DB ambassador (Apps / Product 2) — the controlled TCP path that lets an
 * isolated `--internal` app container reach ONLY its own tenant Postgres, with
 * no other egress.
 *
 * The app container sits on its per-app `--internal` network (proven: zero
 * internet/lateral egress — it can't even reach 8.8.8.8). That same isolation
 * also blocks its tenant DB, which lives on a different host/node. So a tiny
 * trusted `socat` forwarder ("ambassador") is attached to the app's network and
 * forwards `:5432` to exactly that tenant DB; the app's `DATABASE_URL` host is
 * rewritten to the ambassador. The untrusted app keeps zero general egress; the
 * single-purpose forwarder is the only thing that can reach the DB, and only the
 * DB (its socat target is a fixed host:port). REVOKE-CONNECT still isolates the
 * actual databases, so even a shared cluster stays per-tenant safe.
 *
 * Pure builders + a regex DSN rewrite (no URL parser — the `postgresql://`
 * scheme is non-special and parses inconsistently), so the posture is a
 * unit-testable contract; the real `ssh.exec` lives in the provider.
 *
 * ADDITIVE: nothing here touches the agent path or 2AM's container schema.
 */

import { buildAppContainerSecurityFlags } from "./app-network-utils";
import { shellQuote } from "./docker-sandbox-utils";

/** Default socat image for the forwarder. Override via deps/env in production (pin a digest). */
export const DEFAULT_AMBASSADOR_IMAGE = "alpine/socat";

/** The port the ambassador listens on (and that the rewritten DSN points at). */
export const AMBASSADOR_LISTEN_PORT = 5432;

/**
 * Per-app ambassador container name — stable + DNS-safe. Uses the SAME 12-char
 * slug as `containerNameForApp` (`app-<slug>`), so the ambassador is
 * `app-db-<slug>` and teardown can derive it from the container name alone.
 */
export function ambassadorName(appId: string): string {
  const short = appId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);
  return `app-db-${short}`;
}

/**
 * Derive the ambassador name from the app container name (`app-<slug>` ->
 * `app-db-<slug>`), so `delete(containerName)` can tear the forwarder down
 * without the appId.
 */
export function ambassadorNameForContainer(containerName: string): string {
  const slug = containerName.startsWith("app-")
    ? containerName.slice("app-".length)
    : containerName;
  return `app-db-${slug}`;
}

export interface DbEndpoint {
  host: string;
  port: number;
}

/**
 * Extract the upstream host:port from a Postgres DSN
 * (`postgresql://user:pass@HOST:PORT/db?params`). The credential half never
 * contains `@` (generated passwords are base64url), so the first `@` is the
 * userinfo separator and the host:port runs to the next `/` or `?`.
 */
export function parseDsnEndpoint(dsn: string): DbEndpoint | null {
  const at = dsn.indexOf("@");
  if (at < 0) return null;
  const rest = dsn.slice(at + 1);
  const end = rest.search(/[/?]/);
  const hostport = (end >= 0 ? rest.slice(0, end) : rest).trim();
  if (!hostport) return null;
  const lastColon = hostport.lastIndexOf(":");
  if (lastColon <= 0) return { host: hostport, port: 5432 };
  const host = hostport.slice(0, lastColon);
  const port = Number(hostport.slice(lastColon + 1));
  if (!host || !Number.isFinite(port)) return null;
  return { host, port };
}

/**
 * Rewrite a Postgres DSN's host:port to the ambassador address, preserving the
 * user, password, database, and query params verbatim.
 */
export function rewriteDsnToAmbassador(
  dsn: string,
  ambassadorHost: string,
  ambassadorPort: number = AMBASSADOR_LISTEN_PORT,
): string {
  const at = dsn.indexOf("@");
  if (at < 0) return dsn;
  const head = dsn.slice(0, at + 1); // `postgresql://user:pass@`
  const rest = dsn.slice(at + 1);
  const end = rest.search(/[/?]/);
  const tail = end >= 0 ? rest.slice(end) : ""; // `/db?params`
  return `${head}${ambassadorHost}:${ambassadorPort}${tail}`;
}

export interface AmbassadorParams {
  appId: string;
  /** The app's per-app `--internal` network (the app + ambassador share it). */
  network: string;
  /** The tenant DB the ambassador forwards to. */
  db: DbEndpoint;
  /** Network that can actually reach the DB host (gives the forwarder its only egress). Default `bridge`. */
  egressNetwork?: string;
  /** socat image. Default {@link DEFAULT_AMBASSADOR_IMAGE}. */
  image?: string;
}

/**
 * Commands to (re)create the per-app DB ambassador: a socat forwarder started on
 * an egress-capable network (so it can reach the tenant DB) and then attached to
 * the app's `--internal` network (so the app can reach it). Capabilities are
 * dropped — it only needs to listen + connect TCP.
 */
export function buildEnsureAmbassadorCmds(params: AmbassadorParams): string[] {
  const name = ambassadorName(params.appId);
  const image = params.image ?? DEFAULT_AMBASSADOR_IMAGE;
  const egressNetwork = params.egressNetwork ?? "bridge";
  const security = buildAppContainerSecurityFlags();
  const target = `TCP:${params.db.host}:${params.db.port}`;
  const listen = `TCP-LISTEN:${AMBASSADOR_LISTEN_PORT},fork,reuseaddr`;
  return [
    `docker rm -f ${shellQuote(name)} >/dev/null 2>&1 || true`,
    [
      "docker run -d",
      `--name ${shellQuote(name)}`,
      "--restart unless-stopped",
      `--network ${shellQuote(egressNetwork)}`,
      ...security,
      shellQuote(image),
      "-dd",
      shellQuote(listen),
      shellQuote(target),
    ].join(" "),
    `docker network connect ${shellQuote(params.network)} ${shellQuote(name)}`,
  ];
}

/** Command to remove an app's ambassador, derived from the app container name. */
export function buildRemoveAmbassadorCmdForContainer(containerName: string): string {
  return `docker rm -f ${shellQuote(ambassadorNameForContainer(containerName))} >/dev/null 2>&1 || true`;
}
