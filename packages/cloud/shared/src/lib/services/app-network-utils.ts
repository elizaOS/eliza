/**
 * Per-tenant network isolation builders (Apps / Product 2).
 *
 * Untrusted user app containers must NOT share the agent network or reach the
 * host/control plane. These pure builders produce the docker args that put each
 * app on its OWN `--internal` network (no direct egress, no inter-tenant
 * routing) behind a default-deny egress proxy, with capabilities dropped. The
 * capability/no-new-privileges/PID flags are also reusable by hosted-agent
 * lanes that intentionally add back their own network capabilities afterward.
 *
 * Pure string/arg construction, so the isolation posture is a unit-testable
 * contract; kernel enforcement (does --internal actually block egress?) is
 * validated on a throwaway scratch network on the VPS, never here.
 *
 * ADDITIVE: callers opt into these args at their Docker command boundary.
 */

import { shellQuote } from "./docker-sandbox-utils";

export const APP_NETWORK_DEFAULTS = {
  /** Cap on processes to blunt fork bombs from untrusted images. */
  pidsLimit: 512,
} as const;

/** Per-app docker network name (each tenant gets its own isolated network). */
export function appNetworkName(appId: string): string {
  const short = appId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 24);
  return `app-net-${short}`;
}

/**
 * Idempotently ensure a per-app `--internal` bridge exists. `--internal` is the
 * load-bearing flag: containers on it have NO route off the network except via
 * an explicitly-attached egress proxy. Mirrors the agent
 * `buildEnsureNetworkCmd` shape but adds `--internal`.
 */
export function buildEnsureAppNetworkCmd(network: string): string {
  const net = shellQuote(network);
  return `docker network inspect ${net} >/dev/null 2>&1 || docker network create --driver bridge --internal ${net} >/dev/null 2>&1 || docker network inspect ${net} >/dev/null`;
}

/**
 * Hardening flags for an untrusted app or hosted-agent container. Drops ALL
 * capabilities, forbids privilege escalation, and bounds processes.
 * Deliberately NEVER emits NET_ADMIN, `--device /dev/net/tun`, `--privileged`,
 * or `--add-host host.docker.internal:host-gateway`; agent callers that need
 * tailnet plumbing must add NET_ADMIN/tun after this drop-all baseline.
 */
export function buildAppContainerSecurityFlags(opts: { pidsLimit?: number } = {}): string[] {
  const pids = opts.pidsLimit ?? APP_NETWORK_DEFAULTS.pidsLimit;
  return ["--cap-drop=ALL", "--security-opt", "no-new-privileges", `--pids-limit=${pids}`];
}

/** Publish a container port only on the Docker host's loopback interface. */
export function buildLoopbackPortPublishFlag(
  hostPort: number,
  containerPort: number | string,
): string {
  return `-p 127.0.0.1:${hostPort}:${containerPort}`;
}

/**
 * Env that routes all HTTP(S) egress through the per-node egress proxy so the
 * default-deny allowlist (see {@link buildSquidAllowlistConf}) applies. Set on
 * the app container; combined with `--internal` there is no other way out.
 */
export function buildAppEgressEnv(egressProxyUrl: string): Record<string, string> {
  return {
    HTTP_PROXY: egressProxyUrl,
    HTTPS_PROXY: egressProxyUrl,
    http_proxy: egressProxyUrl,
    https_proxy: egressProxyUrl,
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
  };
}

/**
 * Build a default-deny Squid config that permits egress ONLY to the listed
 * destination hosts. Anything not on the allowlist is refused, so a compromised
 * app can't exfiltrate to or pivot through arbitrary hosts.
 */
export function buildSquidAllowlistConf(allowedHosts: readonly string[]): string {
  const safe = allowedHosts.filter((h) => /^[A-Za-z0-9.*_-]+$/.test(h));
  const acls = safe.map((h) => `acl allowed_dst dstdomain ${h}`).join("\n");
  return [
    "# Apps egress allowlist — default deny. Generated; do not hand-edit.",
    "http_port 3128",
    acls,
    safe.length > 0 ? "http_access allow allowed_dst" : "",
    "http_access deny all",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
