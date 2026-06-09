/**
 * App-node firewall builders (Apps / Product 2) — defense-in-depth on top of
 * the per-app `--internal` network + egress proxy (U4). Pure config/rule
 * builders so the posture is a unit-testable contract; applying them on a node
 * is an operator/terraform step, VPS-validated, never done from here.
 *
 * Two layers: a host nftables ruleset that DROPs container traffic to the cloud
 * metadata endpoint + RFC1918 ranges (so a container can't reach the
 * instance-metadata service or pivot across the private network), and
 * server-level Hetzner Cloud firewall rules.
 */

/** Cloud instance-metadata endpoint — must never be reachable from a tenant app. */
export const CLOUD_METADATA_IP = "169.254.169.254";
/** RFC1918 private ranges blocked from tenant containers. */
export const RFC1918_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] as const;

/**
 * nftables ruleset for the forward chain on an app node: default-drop, block
 * the metadata IP + private ranges from container egress, allow established
 * return traffic and (optionally) the egress proxy. Belt-and-suspenders behind
 * the `--internal` network.
 */
export function buildAppNodeNftablesRules(
  opts: { egressProxyIp?: string; allowedPrivateCidrs?: readonly string[] } = {},
): string {
  const allowProxy = opts.egressProxyIp ? [`        ip daddr ${opts.egressProxyIp} accept`] : [];
  const allowPrivate = (opts.allowedPrivateCidrs ?? []).map(
    (cidr) => `        ip daddr ${cidr} accept`,
  );
  const blocks = [
    `        ip daddr ${CLOUD_METADATA_IP} drop`,
    ...RFC1918_RANGES.map((r) => `        ip daddr ${r} drop`),
  ];
  return [
    "table inet app_isolation {",
    "    chain forward {",
    "        type filter hook forward priority 0; policy drop;",
    "        ct state established,related accept",
    ...allowProxy,
    ...allowPrivate,
    ...blocks,
    "    }",
    "}",
  ].join("\n");
}

/** A Hetzner Cloud firewall rule (subset we use). */
export interface HetznerFirewallRule {
  direction: "in" | "out";
  protocol: "tcp" | "udp" | "icmp";
  port?: string;
  source_ips?: string[];
  destination_ips?: string[];
  description?: string;
}

/**
 * Server-level Hetzner firewall for an app node: allow inbound only from the
 * control-plane/LB CIDRs on the host-port range that maps to app containers;
 * everything else inbound is denied by Hetzner's default-deny. (Egress is
 * governed by nftables + the proxy above.)
 */
export function buildHetznerAppFirewallRules(opts: {
  controlPlaneCidrs: readonly string[];
  hostPortRange: string;
}): HetznerFirewallRule[] {
  return [
    {
      direction: "in",
      protocol: "tcp",
      port: opts.hostPortRange,
      source_ips: [...opts.controlPlaneCidrs],
      description: "app container host ports — control plane / LB only",
    },
  ];
}
