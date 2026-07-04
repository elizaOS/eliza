/**
 * Ordered kernel-capability posture for the hosted-AGENT container lane.
 *
 * The agent container reuses the same escape-hardening primitive as the app
 * lane — {@link buildAppContainerSecurityFlags}: `--cap-drop=ALL`,
 * `--security-opt no-new-privileges`, `--pids-limit=<n>` (#12230/#12302) — but,
 * unlike an untrusted app, the agent legitimately needs ONE capability back
 * when the headscale VPN is enabled: `NET_ADMIN` plus `/dev/net/tun` to bring up
 * the tailnet interface.
 *
 * ORDER IS LOAD-BEARING. `--cap-drop=ALL` must be emitted BEFORE
 * `--cap-add=NET_ADMIN` so the result is the canonical docker drop-all-then-
 * re-add-exactly-one idiom, leaving the container with NET_ADMIN and nothing
 * else. Keeping the composition in one pure builder makes that invariant a
 * unit-testable contract instead of an implicit ordering buried in a large
 * inline arg array in the provider.
 */

import { buildAppContainerSecurityFlags } from "./app-network-utils";

/**
 * Build the ordered `docker create` capability/security flags for a hosted-agent
 * container. Always drops all capabilities and forbids privilege escalation;
 * under headscale, re-adds exactly `NET_ADMIN` + the tun device AFTER the drop.
 */
export function buildAgentContainerSecurityFlags(opts: {
  headscaleEnabled: boolean;
  pidsLimit?: number;
}): string[] {
  return [
    ...buildAppContainerSecurityFlags({ pidsLimit: opts.pidsLimit }),
    ...(opts.headscaleEnabled ? ["--cap-add=NET_ADMIN", "--device /dev/net/tun"] : []),
  ];
}
