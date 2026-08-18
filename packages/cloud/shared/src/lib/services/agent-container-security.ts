/**
 * Ordered kernel-capability posture for the hosted-AGENT container lane.
 *
 * The agent container reuses the same escape-hardening primitive as the app
 * lane — {@link buildAppContainerSecurityFlags}: `--cap-drop=ALL`,
 * `--security-opt no-new-privileges`, `--pids-limit=<n>` (#12230/#12302) — but,
 * the normal lane starts directly as uid 10001. The Headscale lane starts its
 * trusted bootstrap as root and receives only `SETUID`, `SETGID`, `NET_ADMIN`
 * plus `/dev/net/tun`; after tailscaled starts, PID 1 irreversibly execs the
 * runtime as uid 10001 under no-new-privileges. Volume ownership is prepared on
 * the host before `docker start`, so the container never needs CHOWN authority.
 *
 * ORDER IS LOAD-BEARING. `--cap-drop=ALL` must be emitted BEFORE
 * the narrow Headscale bootstrap set so the result remains an
 * explicit drop-all-then-re-add contract. Keeping the composition in one pure
 * builder makes that invariant a
 * unit-testable contract instead of an implicit ordering buried in a large
 * inline arg array in the provider.
 */

import { buildAppContainerSecurityFlags } from "./app-network-utils";
import { shellQuote } from "./docker-sandbox-utils";
import { HOSTED_AGENT_BWRAP_APPARMOR_PROFILE_NAME } from "./hosted-agent-apparmor-profile";
import { buildHostedAgentPolicyRootCmd } from "./hosted-agent-root-command";
import { HOSTED_AGENT_BWRAP_SECCOMP_PROFILE_PATH } from "./hosted-agent-seccomp-profile";

/**
 * Build the ordered `docker create` capability/security flags for a hosted-agent
 * container. Always drops all capabilities and forbids privilege escalation;
 * under headscale only, re-adds `SETUID`, `SETGID`, `NET_ADMIN` + the tun device
 * AFTER the drop. The normal lane stays at cap-drop=ALL.
 */
export function buildAgentContainerSecurityFlags(opts: {
  headscaleEnabled: boolean;
  pidsLimit?: number;
}): string[] {
  return [
    ...buildAppContainerSecurityFlags({ pidsLimit: opts.pidsLimit }),
    "--security-opt",
    `seccomp=${shellQuote(HOSTED_AGENT_BWRAP_SECCOMP_PROFILE_PATH)}`,
    "--security-opt",
    `apparmor=${shellQuote(HOSTED_AGENT_BWRAP_APPARMOR_PROFILE_NAME)}`,
    ...(opts.headscaleEnabled
      ? ["--cap-add=SETUID", "--cap-add=SETGID", "--cap-add=NET_ADMIN", "--device /dev/net/tun"]
      : []),
  ];
}

/** Start the non-VPN lane as the final unprivileged runtime user. */
export function buildAgentContainerUserFlags(opts: { headscaleEnabled: boolean }): string[] {
  return opts.headscaleEnabled ? [] : ["--user 10001:10001"];
}

/**
 * Prepare the two bind-mounted state trees as root on the Docker host. The
 * provider derives this path from a validated agent id; the extra assertion
 * keeps this destructive ownership operation fail-closed if that contract ever
 * changes. GNU chown's physical traversal does not follow symlinks encountered
 * below the tree.
 */
export function buildPrepareAgentRuntimeVolumesCmd(volumePath: string): string {
  if (!/^\/data\/agents\/[A-Za-z0-9_-]+$/u.test(volumePath)) {
    throw new Error("hosted-agent runtime volume must be a validated per-agent path");
  }
  const elizaStatePath = `${volumePath}/eliza`;
  return buildHostedAgentPolicyRootCmd(
    [
      `install -d -m 0750 -o 10001 -g 10001 ${shellQuote(volumePath)} ${shellQuote(elizaStatePath)}`,
      `chown -hR 10001:10001 -- ${shellQuote(volumePath)}`,
    ].join(" && "),
  );
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

/**
 * Ordered `docker create` CPU flags for a hosted-agent container.
 *
 * The `--cpus` analog of {@link buildAgentContainerMemoryFlags} (#18485): agent
 * containers carry no CPU ceiling, so one runaway agent can monopolize every
 * core of a shared box. That was survivable on 4-vCPU cloud nodes holding 2-3
 * agents; robot-first placement packs many more agents per 12-vCPU robot, so a
 * per-agent CPU ceiling is what makes that density safe. `--cpus` is a hard
 * cgroup quota, throttling — never killing — the container.
 *
 * `cpus <= 0` (or non-finite) disables the ceiling and emits no flags — the
 * historical behavior, selectable via CONTAINERS_AGENT_CPU_LIMIT=0. Fractional
 * values are valid docker input and are kept to two decimals.
 */
export function buildAgentContainerCpuFlags(cpus: number | undefined): string[] {
  if (!cpus || !Number.isFinite(cpus) || cpus <= 0) return [];
  const value = Math.round(cpus * 100) / 100;
  return [`--cpus ${shellQuote(String(value))}`];
}

/** Converts the persisted ECS-style CPU unit contract to Docker vCPUs. */
export function agentCpuUnitsToDockerCpus(cpuUnits: number | undefined): number | undefined {
  if (!cpuUnits || !Number.isFinite(cpuUnits) || cpuUnits <= 0) return undefined;
  return cpuUnits / 1024;
}
