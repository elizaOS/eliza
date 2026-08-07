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
import { shellQuote } from "./docker-sandbox-utils";

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

/**
 * Ordered `docker create` memory flags for a hosted-agent container.
 *
 * Why this exists: agent containers historically ran with no `--memory` flag
 * at all (`HostConfig.Memory=0`, unlimited) while also carrying
 * `--restart unless-stopped`. One agent stuck in a boot loop — each attempt
 * spiking ~2GB of anon RSS before dying — could drive a node's available
 * memory to single-digit MB and get the kernel to OOM-kill unrelated HEALTHY
 * co-tenant agents (observed fleet-wide on staging, 2026-08-05). A ceiling
 * turns that failure from "node-wide outage" into "the one broken agent gets
 * OOM-killed inside its own cgroup".
 *
 * `memoryMb <= 0` (or non-finite) disables the ceiling and emits no flags —
 * the pre-2026-08 behavior, selectable via CONTAINERS_AGENT_MEMORY_LIMIT_MB=0.
 *
 * Swap is pinned to the same value (i.e. no swap headroom) so the ceiling
 * cannot be escaped via swap on the shared node — the same hardening the app
 * container lane applies in app-docker-cmd.ts.
 */
export function buildAgentContainerMemoryFlags(memoryMb: number | undefined): string[] {
  if (!memoryMb || !Number.isFinite(memoryMb) || memoryMb <= 0) return [];
  const mb = Math.ceil(memoryMb);
  return [`--memory ${shellQuote(`${mb}m`)}`, `--memory-swap ${shellQuote(`${mb}m`)}`];
}
