/**
 * DockerNodeManager — Manages Docker VPS node pool for sandbox provisioning.
 *
 * Handles node selection (least-loaded), health checks, capacity reporting,
 * and allocation count synchronisation.
 *
 * Reference: eliza-cloud/backend/services/node-manager.ts
 */

import crypto from "node:crypto";
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core/edge";
import { parseLinuxBootId } from "../../db/repositories/agent-backup-source-authority";
import { dockerNodesRepository } from "../../db/repositories/docker-nodes";
import type { DockerNode, DockerNodeStatus } from "../../db/schemas/docker-nodes";
import { containersEnv } from "../config/containers-env";
import { logger } from "../utils/logger";
import type { ComputeProvider } from "./containers/compute-provider";
import { getComputeProvider } from "./containers/compute-provider";
import {
  buildEmbeddingSidecarProbeCmd,
  buildEnsureEmbeddingSidecarCmd,
  type EmbeddingSidecarStatus,
  embeddingSidecarStatusFromMetadata,
  parseEmbeddingSidecarProbe,
} from "./containers/embedding-sidecar";
import {
  attestHetznerCloudNode,
  isTypedHetznerCloudNode,
} from "./containers/hetzner-node-attestation";
import { countAllocatedWorkloadsOnNode } from "./docker-node-workloads";
import {
  dockerPlatformFlag,
  inferNodeArchitectureFromMetadata,
  isArchitectureCompatibleWithPlatform,
  normalizeDockerArchitecture,
  requiredArchitectureForPlatform,
  shellQuote,
} from "./docker-sandbox-utils";
import { DockerSSHClient } from "./docker-ssh";
import { type DiskHealthVerdict, diskHealthVerdict, probeNodeDiskUsage } from "./node-disk-manager";

const NODE_BOOT_ID_COMMAND = "cat /proc/sys/kernel/random/boot_id";

class BackupSourceRevocationError extends Error {
  constructor(cause: unknown) {
    super("Failed to revoke stale backup source authority", { cause });
    this.name = "BackupSourceRevocationError";
  }
}

// ---------------------------------------------------------------------------
// Pre-pull self-heal bookkeeping (see recoverAfterTimedOutPrePull)
// ---------------------------------------------------------------------------

/** Per-node consecutive pre-pull failures + last auto-heal timestamp. Cleared
 * on the first successful pull. In-memory: the provisioning worker is a single
 * long-lived process, and a restart is itself a clean slate. */
const prePullFailureState = new Map<
  string,
  { consecutiveFailures: number; lastSelfHealMs: number }
>();
/** Consecutive failed pre-pulls on a node before an auto docker restart. */
const PREPULL_SELF_HEAL_FAILURE_THRESHOLD = 2;
/** Minimum gap between auto docker restarts on the same node (anti-restart-loop). */
const PREPULL_SELF_HEAL_COOLDOWN_MS = 30 * 60 * 1000;
const PREPULL_PID_DIR = "/tmp";

// ---------------------------------------------------------------------------
// Health-check failure tracking (auto-disable a dead node)
// ---------------------------------------------------------------------------

/**
 * Consecutive failed health checks (across cycles) before a node is auto-disabled.
 *
 * Derived IN-MEMORY rather than via a new schema column: the provisioning
 * worker is a single long-lived process that owns the health loop, a restart is
 * a legitimate clean slate (the node gets re-probed and either re-fails toward
 * the threshold again or recovers), and this avoids a schema migration on the
 * hot health-check write path. Cleared on the first successful check.
 *
 * Overridable via `CONTAINERS_NODE_HEALTH_FAILURE_THRESHOLD` for ops tuning;
 * default 3 (≈ three full retry-exhausted cycles) balances not flapping on a
 * transient SSH hiccup against not stranding a genuinely dead node in rotation.
 */
const NODE_HEALTH_FAILURE_THRESHOLD = (() => {
  const raw = process.env.CONTAINERS_NODE_HEALTH_FAILURE_THRESHOLD;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 3;
})();

/** Per-node consecutive failed health checks. In-memory (see threshold docs). */
const nodeHealthFailureState = new Map<string, number>();

export function __resetNodeHealthFailureStateForTests(): void {
  nodeHealthFailureState.clear();
}

// ---------------------------------------------------------------------------
// Placement circuit breaker (docker-command timeouts feed back into selection)
// ---------------------------------------------------------------------------

/**
 * Per-node docker-command timeout timestamps + quarantine deadline. In-memory
 * for the same reason as the health/pre-pull state above: the provisioning
 * worker is a single long-lived process and a restart is a clean slate.
 *
 * Why this exists (#17880): capacity accounting and the `docker info`
 * readiness probe are both blind to a node that is alive but drowning in IO —
 * `docker info` answers from daemon memory while `docker create` needs journal
 * flushes, so an overloaded node passes selection and then times out every
 * provision. Timeouts recorded here quarantine the node from selection instead
 * of letting it be re-picked for every subsequent provision.
 */
const placementTimeoutState = new Map<
  string,
  { timeoutsMs: number[]; quarantinedUntilMs: number }
>();
/** Docker-command timeouts on a node within the window before quarantine. */
const PLACEMENT_TIMEOUT_THRESHOLD = 3;
/** Sliding window in which timeouts count toward the threshold. */
const PLACEMENT_TIMEOUT_WINDOW_MS = 10 * 60 * 1000;
/**
 * How long a quarantined node is excluded from selection. Longer than the
 * window, so a node coming out of quarantine starts from a drained window and
 * gets the full threshold of fresh attempts before re-quarantining.
 */
const PLACEMENT_QUARANTINE_MS = 15 * 60 * 1000;

export function __resetPlacementTimeoutStateForTests(): void {
  placementTimeoutState.clear();
}

/** Matches only the docker-ssh timeout signature in an error or its causes. */
export function isDockerSshCommandTimeoutError(
  error: unknown,
  commandFirstToken?: string,
): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && current !== null && !visited.has(current)) {
    visited.add(current);
    const message = current instanceof Error ? current.message : String(current);
    const commandSuffix = commandFirstToken ? `: ${commandFirstToken} [redacted]` : " [redacted]";
    if (
      message.includes("[docker-ssh] Command timed out after") &&
      message.endsWith(commandSuffix)
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }

  return false;
}

/**
 * Feed a container-operation failure on a node back into placement. Only
 * docker-command timeouts count — they are the overload signature; every other
 * failure mode (bad image, auth, node absent) has its own handling and says
 * nothing about the node's ability to take work.
 */
export function notePlacementCommandFailure(
  nodeId: string,
  error: unknown,
  nowMs = Date.now(),
): void {
  if (!isDockerSshCommandTimeoutError(error, "docker")) return;
  const state = placementTimeoutState.get(nodeId) ?? {
    timeoutsMs: [],
    quarantinedUntilMs: 0,
  };
  state.timeoutsMs = state.timeoutsMs.filter((ts) => nowMs - ts < PLACEMENT_TIMEOUT_WINDOW_MS);
  state.timeoutsMs.push(nowMs);
  if (state.timeoutsMs.length >= PLACEMENT_TIMEOUT_THRESHOLD) {
    state.quarantinedUntilMs = nowMs + PLACEMENT_QUARANTINE_MS;
    state.timeoutsMs = [];
    logger.warn("[docker-node-manager] Node quarantined from placement after docker timeouts", {
      nodeId,
      threshold: PLACEMENT_TIMEOUT_THRESHOLD,
      windowMs: PLACEMENT_TIMEOUT_WINDOW_MS,
      quarantineMs: PLACEMENT_QUARANTINE_MS,
    });
  }
  placementTimeoutState.set(nodeId, state);
}

/** A successful container operation proves the node can take work again. */
export function clearPlacementCommandFailures(nodeId: string): void {
  placementTimeoutState.delete(nodeId);
}

export function isNodePlacementQuarantined(nodeId: string, nowMs = Date.now()): boolean {
  const state = placementTimeoutState.get(nodeId);
  return !!state && state.quarantinedUntilMs > nowMs;
}

// ---------------------------------------------------------------------------
// IO-pressure readiness signal
// ---------------------------------------------------------------------------

/**
 * Refuse placement above this /proc/pressure/io `full avg60` percentage.
 *
 * Both ends are measured on the same production node (88.99.66.168):
 * while healthy and completing provisions in ~36s it reports avg60 33.6–36.4,
 * and during the #17880 outage — every `docker create` timing out at 60s — it
 * reported avg60 78.50. 60 leaves ~24 points of margin below the healthy
 * ceiling and ~18 above the outage floor.
 *
 * avg60, not avg10: on that same healthy node avg10 swings 30.5–40.9, so a
 * gate anywhere near the working range refuses a working node on a transient
 * spike (an image extract is enough) and manufactures the "no nodes available"
 * outage this is meant to prevent. avg60 spans 2.8 points over the same window.
 */
const PLACEMENT_MAX_IO_PRESSURE_FULL_AVG60 = 60;

/** Separates docker-info output from the PSI section in the readiness probe. */
const READINESS_PROBE_PSI_MARKER = "---IO-PRESSURE---";

/**
 * Parse `full avg60=` out of /proc/pressure/io content. Returns null when the
 * signal is absent (pre-4.20 kernel, CONFIG_PSI off, unreadable) — absence
 * must not block placement; the circuit breaker still protects that node.
 */
export function parseIoPressureFullAvg60(section: string): number | null {
  const match = section.match(/^full\s+avg10=[\d.]+\s+avg60=(\d+(?:\.\d+)?)/m);
  if (!match) return null;
  const value = Number.parseFloat(match[1]!);
  return Number.isFinite(value) ? value : null;
}

/**
 * Memory the host keeps outside every agent ceiling: dockerd, tailscaled, the
 * page cache, and the embedding sidecar — which is launched with no `--memory`
 * of its own, so its footprint has to be absorbed here or the reserve is
 * fiction.
 */
export const HOST_RESERVE_MB = 1024;

/** Separates the meminfo and committed-ceiling sections in the readiness probe. */
const READINESS_PROBE_MEMINFO_MARKER = "---MEMINFO---";
const READINESS_PROBE_COMMITTED_MARKER = "---MEM-COMMITTED---";

/**
 * Slice one section out of the readiness probe's concatenated output.
 *
 * `marker === null` returns everything before the first marker, i.e. the
 * `docker info` reply. Sections are addressed by name rather than by position
 * so a probe that omits one (a caller that skips the memory gate) cannot shift
 * the meaning of the others.
 */
export function readProbeSection(output: string, marker: string | null): string {
  const anyMarker = /---[A-Z-]+---/;
  if (marker === null) {
    const first = output.search(anyMarker);
    return first === -1 ? output : output.slice(0, first);
  }
  const start = output.indexOf(marker);
  if (start === -1) return "";
  const rest = output.slice(start + marker.length);
  const next = rest.search(anyMarker);
  return next === -1 ? rest : rest.slice(0, next);
}

export interface NodeMemorySnapshot {
  memTotalMb: number;
  memAvailableMb: number;
  /** Sum of the explicit `--memory` ceilings of the containers resident on the node. */
  declaredCeilingMb: number;
}

/**
 * Read the node's memory facts out of the readiness probe.
 *
 * Returns null when the signal is absent or unparseable. Absence must not block
 * placement — the same policy the IO-pressure gate follows — so a node whose
 * kernel or Docker output we cannot read stays eligible rather than freezing
 * the fleet.
 */
export function parseNodeMemorySnapshot(
  meminfoSection: string,
  committedSection: string,
): NodeMemorySnapshot | null {
  const total = meminfoSection.match(/^MemTotal:\s+(\d+)\s+kB/m);
  const availableMatch = meminfoSection.match(/^MemAvailable:\s+(\d+)\s+kB/m);
  if (!total || !availableMatch) return null;

  const memTotalMb = Math.floor(Number.parseInt(total[1]!, 10) / 1024);
  const memAvailableMb = Math.floor(Number.parseInt(availableMatch[1]!, 10) / 1024);
  if (!Number.isFinite(memTotalMb) || !Number.isFinite(memAvailableMb) || memTotalMb <= 0) {
    return null;
  }

  // `docker inspect -f '{{.HostConfig.Memory}}'` prints one byte count per
  // container; 0 means that container runs unbounded and contributes nothing
  // measurable here. Unbounded containers are recovered through used memory in
  // `admitsRequiredMemory`, so they are not silently free.
  let declaredCeilingMb = 0;
  for (const line of committedSection.split("\n")) {
    const trimmed = line.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    declaredCeilingMb += Math.floor(Number.parseInt(trimmed, 10) / (1024 * 1024));
  }

  return { memTotalMb, memAvailableMb, declaredCeilingMb };
}

export interface MemoryAdmissionVerdict {
  admitted: boolean;
  /** The larger of the declared ceilings and what the node is actually using. */
  effectiveCommittedMb: number;
  /** Memory the node may commit in total, i.e. `memTotalMb - HOST_RESERVE_MB`. */
  budgetMb: number;
}

/**
 * Decide whether a node can take one more container of `requiredMemoryMb`.
 *
 * The gate is the sum of *committed ceilings*, not free memory. Free memory
 * only collapses once the new agent is already allocating, so a MemAvailable
 * check passes at the moment of the decision and the kernel OOM-kills seconds
 * later — which is exactly how a 7745 MiB node accepted a third 3072 MiB
 * ceiling and then killed the booting agent every ~29s.
 *
 * Used memory is taken as a floor for the commitment because a container
 * launched without a ceiling declares nothing while still occupying the node.
 */
export function admitsRequiredMemory(
  snapshot: NodeMemorySnapshot,
  requiredMemoryMb: number,
): MemoryAdmissionVerdict {
  const usedMb = Math.max(0, snapshot.memTotalMb - snapshot.memAvailableMb);
  const effectiveCommittedMb = Math.max(snapshot.declaredCeilingMb, usedMb);
  const budgetMb = snapshot.memTotalMb - HOST_RESERVE_MB;
  return {
    admitted: effectiveCommittedMb + requiredMemoryMb <= budgetMb,
    effectiveCommittedMb,
    budgetMb,
  };
}

/**
 * CPU a node keeps for itself: dockerd, tailscaled, the embedding sidecar, and
 * the SSH work the control plane does on it.
 */
export const HOST_RESERVE_VCPU = 1;

/**
 * vCPU budgeted per agent container.
 *
 * A policy number, not a measurement — agent containers ship with NO `--cpus`
 * limit, so nothing enforces this and nothing can measure a per-agent share
 * from a running box. It encodes the sizing the code was designed around
 * (ccx33 + capacity 8, i.e. one core per agent) so that capacity stops being
 * blind to CPU entirely. Override per fleet once real contention data exists.
 */
export const DEFAULT_AGENT_VCPU_BUDGET = 1;

export interface NodeCapacityBreakdown {
  /** The binding value: the smallest dimension. */
  capacity: number;
  byMemory: number | null;
  byCpu: number | null;
  /** Which dimension decided, for the operator reading the log. */
  boundBy: "memory" | "cpu" | "unknown";
}

/**
 * How many agent containers a node can actually hold, across every dimension
 * we can size statically.
 *
 * Capacity was a slot counter stamped from one global env var, unrelated to the
 * machine. That number is wrong in both directions, and both were measured on
 * the fleet: it licensed 4 x 3072 MiB of ceilings onto 7745 MiB / 4 vCPU boxes
 * (the global OOM the admission gate closed), and it would hand a
 * 257626 MiB / 12 vCPU robot the blind default of 8.
 *
 * The dimensions do not agree, which is the whole point of taking the minimum:
 * that robot has ~21 GiB of RAM per core against the cloud box's ~1.9, so
 * sizing it on memory alone would over-subscribe its CPU by roughly sevenfold.
 *
 * Memory uses the SAME reserve as {@link admitsRequiredMemory}. If the two
 * diverged, a node would advertise slots that admission refuses on every
 * placement: a pool that believes it has room and rejects all work.
 *
 * IO is deliberately absent. It is a transient signal, already enforced where
 * it belongs — `ensureNodeReady` refuses placement above
 * PLACEMENT_MAX_IO_PRESSURE_FULL_AVG60 — and a static IO slot count would be a
 * fiction. Disk space has its own monitor.
 *
 * This is a ceiling, not a promise: it reads totals, not what is free, so a box
 * shared with other workloads can still advertise more than it has room for
 * right now. The admission gate measures what is committed at placement time.
 */
export function deriveNodeCapacity(opts: {
  memTotalMb?: number | null;
  vCpuCount?: number | null;
  agentMemoryLimitMb: number;
  agentVCpuBudget?: number;
}): NodeCapacityBreakdown {
  const byMemory = deriveCapacityDimension(
    opts.memTotalMb,
    HOST_RESERVE_MB,
    opts.agentMemoryLimitMb,
  );
  const byCpu = deriveCapacityDimension(
    opts.vCpuCount,
    HOST_RESERVE_VCPU,
    opts.agentVCpuBudget ?? DEFAULT_AGENT_VCPU_BUDGET,
  );

  const known = [
    { value: byMemory, name: "memory" as const },
    { value: byCpu, name: "cpu" as const },
  ].filter((d): d is { value: number; name: "memory" | "cpu" } => d.value !== null);

  if (known.length === 0) {
    return { capacity: 0, byMemory, byCpu, boundBy: "unknown" };
  }
  const binding = known.reduce((a, b) => (b.value < a.value ? b : a));
  return { capacity: binding.value, byMemory, byCpu, boundBy: binding.name };
}

/** Total minus what the host keeps, divided by what one agent takes. */
function deriveCapacityDimension(
  total: number | null | undefined,
  hostReserve: number,
  perAgent: number,
): number | null {
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(perAgent) || perAgent <= 0) return null;
  const budget = total - hostReserve;
  if (budget <= 0) return 0;
  return Math.floor(budget / perAgent);
}

export function resolveNodeCapacity(opts: {
  requestedCapacity?: number | null;
  memTotalMb?: number | null;
  vCpuCount?: number | null;
  agentMemoryLimitMb: number;
  agentVCpuBudget?: number;
  fallbackCapacity: number;
}): {
  capacity: number;
  derived: boolean;
  clampedFrom?: number;
  boundBy: NodeCapacityBreakdown["boundBy"];
} {
  const breakdown = deriveNodeCapacity({
    memTotalMb: opts.memTotalMb,
    vCpuCount: opts.vCpuCount,
    agentMemoryLimitMb: opts.agentMemoryLimitMb,
    agentVCpuBudget: opts.agentVCpuBudget,
  });
  const supported = breakdown.boundBy === "unknown" ? null : breakdown.capacity;

  if (typeof opts.requestedCapacity === "number" && opts.requestedCapacity > 0) {
    if (supported !== null && opts.requestedCapacity > supported) {
      return {
        capacity: supported,
        derived: false,
        clampedFrom: opts.requestedCapacity,
        boundBy: breakdown.boundBy,
      };
    }
    return { capacity: opts.requestedCapacity, derived: false, boundBy: breakdown.boundBy };
  }

  if (supported !== null) {
    return { capacity: supported, derived: true, boundBy: breakdown.boundBy };
  }
  return { capacity: opts.fallbackCapacity, derived: false, boundBy: breakdown.boundBy };
}

// ---------------------------------------------------------------------------
// Embedding-sidecar self-heal bookkeeping
// ---------------------------------------------------------------------------

/**
 * Last self-heal attempt per node. In-memory for the same reason as the
 * pre-pull/health state above: the provisioning worker owns the loop and a
 * restart is a clean slate. The cooldown exists because the ensure command may
 * pull the sidecar image (hundreds of MB) — a node whose install keeps failing
 * must not re-pull every health cycle.
 */
const embeddingSidecarSelfHealState = new Map<string, number>();
/** Minimum gap between sidecar self-heal attempts on the same node. */
const EMBEDDING_SIDECAR_SELF_HEAL_COOLDOWN_MS = 30 * 60 * 1000;
/** Generous ensure timeout: first run pulls the TEI image + model weights. */
const EMBEDDING_SIDECAR_ENSURE_TIMEOUT_MS = 5 * 60 * 1000;

export function __resetEmbeddingSidecarSelfHealStateForTests(): void {
  embeddingSidecarSelfHealState.clear();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NodeCapacityReport {
  nodeId: string;
  hostname: string;
  capacity: number;
  allocated: number;
  available: number;
  status: DockerNodeStatus;
  enabled: boolean;
  lastHealthCheck: Date | null;
  /**
   * Last persisted local-embedding-sidecar verdict for the node ("unknown"
   * until the health loop has probed it). Surfaced so a fleet silently missing
   * its sidecars is visible in every capacity read, not just node-local logs.
   */
  embeddingSidecar: EmbeddingSidecarStatus | "unknown";
}

export interface CapacitySummary {
  totalCapacity: number;
  totalAllocated: number;
  totalAvailable: number;
  nodes: NodeCapacityReport[];
}

export interface NodeSelectionOptions {
  /** Docker image platform the selected node must be able to run. */
  requiredPlatform?: string | null;
  /**
   * Skip this node when picking a target. Used by the fleet-upgrade handler
   * to force a blue/green swap onto a *different* node than the one the
   * agent is currently on, because Docker container names are unique per
   * docker daemon and the deterministic name `agent-${id}` would collide
   * if the blue landed on the same node as the old.
   */
  excludeNodeId?: string;
  /**
   * Refuse transient IO pressure only while selecting new placement. Sticky
   * stateful routing and autoscaler readiness must remain liveness-only.
   */
  enforcePlacementIoPressure?: boolean;
  /**
   * The `--memory` ceiling the caller is about to apply to the container. When
   * set, a node is refused unless it can still commit that much on top of what
   * it has already committed. Callers must pass the value they will actually
   * hand to `docker create`, so the admitted and applied ceilings cannot drift.
   */
  requiredMemoryMb?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether a node was provisioned by the autoscaler (Hetzner Cloud) and is
 * therefore safe to mark offline on health-check failure. Canonical cores
 * (manually-provisioned, no `provider` metadata, or any non-autoscaled
 * provider) are protected — they remain healthy in DB even if a transient
 * ssh probe fails, because flapping them removes real production capacity.
 *
 * Operators always have `enabled=false` to disable a node explicitly.
 */
function isAutoscaledNode(node: DockerNode): boolean {
  const meta = node.metadata as Record<string, unknown> | null | undefined;
  if (!meta || typeof meta !== "object") return false;
  return meta.provider === "hetzner-cloud" && meta.autoscaled === true;
}

/**
 * Whether a node belongs to the hand-registered robot (auction/dedicated)
 * fleet rather than the autoscaled cloud fleet.
 *
 * Explicit `metadata.fleet` wins when present ("robot" vs anything else).
 * Otherwise the discriminator is the one the scheduler already relies on
 * (hetzner-client/scheduling.ts findNodeInLocation): only Cloud-provisioned
 * nodes carry `metadata.location`, so an autoscaled flag or a location string
 * marks cloud, and a hand-registered node without either is robot.
 */
export function isRobotFleetNode(node: DockerNode): boolean {
  const meta = node.metadata as Record<string, unknown> | null | undefined;
  if (meta && typeof meta === "object") {
    if (typeof meta.fleet === "string") return meta.fleet === "robot";
    if (isAutoscaledNode(node)) return false;
    if (typeof meta.location === "string" && meta.location.length > 0) return false;
  }
  return true;
}

/**
 * Placement ordering (#18485): robot slots cost ~€3-4.5/agent/mo against
 * ~€35/agent/mo on autoscaled cloud, and the workload is identical on both, so
 * every dedicated agent placed on cloud while a robot has a real free slot is
 * pure drift. Robot-fleet candidates come first; within a fleet the existing
 * least-loaded order (most free slots first) is preserved, which also serves
 * as the tie-break between equal fleets.
 */
export function comparePlacementCandidates(
  a: { node: DockerNode; available: number },
  b: { node: DockerNode; available: number },
): number {
  const fleetRankA = isRobotFleetNode(a.node) ? 0 : 1;
  const fleetRankB = isRobotFleetNode(b.node) ? 0 : 1;
  if (fleetRankA !== fleetRankB) return fleetRankA - fleetRankB;
  return b.available - a.available;
}

function prePullPidFile(marker: string): string {
  return `${PREPULL_PID_DIR}/eliza-prepull-${marker}.pid`;
}

export function buildTrackedPrePullCommand(
  image: string,
  platform: string | null | undefined,
  marker = crypto.randomUUID(),
): { command: string; pidFile: string } {
  const pidFile = prePullPidFile(marker);
  const pullCommand = ["docker pull", ...dockerPlatformFlag(platform), shellQuote(image)].join(" ");
  const script = [
    `pidfile=${shellQuote(pidFile)}`,
    'rm -f "$pidfile"',
    `(${pullCommand}) &`,
    "pid=$!",
    'printf "%s\\n" "$pid" > "$pidfile"',
    'wait "$pid"',
    "status=$?",
    'rm -f "$pidfile"',
    'exit "$status"',
    // Join with newlines, NOT "; ": one line ends in `&` (the backgrounded
    // pull). The node's /bin/sh is dash, where `&` immediately followed by `;`
    // ("&;") is a hard syntax error ("Syntax error: ";" unexpected"), so every
    // pull would fail at parse time. Newlines are valid separators after `&`.
  ].join("\n");
  return { command: `sh -c ${shellQuote(script)}`, pidFile };
}

export function buildPrePullReapCommand(pidFile: string, image: string): string {
  const quotedImage = shellQuote(image);
  const script = [
    `pidfile=${shellQuote(pidFile)}`,
    'if [ -s "$pidfile" ]; then',
    'pid="$(cat "$pidfile" 2>/dev/null || true)"',
    'case "$pid" in ""|*[!0-9]*) rm -f "$pidfile"; exit 0 ;; esac',
    'cmdline="$(tr "\\0" " " < "/proc/$pid/cmdline" 2>/dev/null || true)"',
    `if printf "%s\\n" "$cmdline" | grep -F "docker pull" >/dev/null && printf "%s\\n" "$cmdline" | grep -F -- ${quotedImage} >/dev/null; then`,
    'kill -9 "$pid" 2>/dev/null || true',
    "fi",
    'rm -f "$pidfile"',
    "fi",
    // Newlines, NOT "; ": `if …; then` joined with "; " yields `then;`, which
    // is a dash syntax error. Newlines compose correctly with if/case/&/fi.
  ].join("\n");
  return `sh -c ${shellQuote(script)}`;
}

export function buildPrePullSelfHealRecoverCommand(): string {
  return [
    "systemctl kill -s SIGKILL docker.service docker.socket 2>/dev/null",
    "sleep 2",
    "systemctl restart containerd 2>/dev/null",
    "sleep 4",
    "systemctl reset-failed docker.service 2>/dev/null",
    "systemctl start docker.service",
  ].join("; ");
}

export function __resetPrePullFailureStateForTests(): void {
  prePullFailureState.clear();
}

// ---------------------------------------------------------------------------
// DockerNodeManager
// ---------------------------------------------------------------------------

export class DockerNodeManager {
  private static instance: DockerNodeManager;

  constructor(private readonly provider?: ComputeProvider) {}

  private computeProvider(): ComputeProvider {
    return this.provider ?? getComputeProvider();
  }

  static getInstance(): DockerNodeManager {
    if (!DockerNodeManager.instance) {
      DockerNodeManager.instance = new DockerNodeManager();
    }
    return DockerNodeManager.instance;
  }

  // ---- Node Selection ---------------------------------------------------

  /**
   * Find the best healthy node with available capacity: robot-fleet nodes
   * first (see {@link comparePlacementCandidates}), least-loaded within a
   * fleet. Sticky-volume pinning and location matching happen in the callers
   * (hetzner-client/scheduling.ts) before this fallback is consulted.
   * Returns null if no capacity is available.
   */
  async getAvailableNode(options: NodeSelectionOptions = {}): Promise<DockerNode | null> {
    const nodes = await dockerNodesRepository.findPlaceable();
    const candidates = (
      await Promise.all(
        nodes.map(async (node) => {
          const allocated = await countAllocatedWorkloadsOnNode(node.node_id);
          const canProbeForCapacity = node.status !== "offline";
          return {
            node,
            allocated,
            available: canProbeForCapacity ? Math.max(0, node.capacity - allocated) : 0,
          };
        }),
      )
    )
      .filter((candidate) => candidate.available > 0)
      .filter((candidate) => candidate.node.node_id !== options.excludeNodeId)
      .sort(comparePlacementCandidates);

    const compatibleCandidates = candidates.filter((candidate) => {
      if (isNodeMetadataCompatible(candidate.node, options.requiredPlatform)) {
        return true;
      }
      logger.warn("[docker-node-manager] Skipping node with incompatible architecture", {
        nodeId: candidate.node.node_id,
        requiredPlatform: options.requiredPlatform,
        metadata: candidate.node.metadata,
      });
      return false;
    });
    const nowMs = Date.now();
    const selectable: typeof compatibleCandidates = [];
    const quarantined: Array<{
      candidate: (typeof compatibleCandidates)[number];
      quarantinedUntilMs: number;
    }> = [];
    for (const candidate of compatibleCandidates) {
      const quarantinedUntilMs =
        placementTimeoutState.get(candidate.node.node_id)?.quarantinedUntilMs ?? 0;
      if (quarantinedUntilMs > nowMs) {
        quarantined.push({ candidate, quarantinedUntilMs });
      } else {
        selectable.push(candidate);
      }
    }
    if (quarantined.length > 0) {
      logger.warn("[docker-node-manager] Skipping quarantined nodes during selection", {
        nodeIds: quarantined.map(({ candidate }) => candidate.node.node_id),
      });
    }

    if (selectable.length === 0 && quarantined.length > 0) {
      const fallback = quarantined.reduce((oldest, current) =>
        current.quarantinedUntilMs < oldest.quarantinedUntilMs ? current : oldest,
      );
      selectable.push(fallback.candidate);
      logger.warn(
        "[docker-node-manager] Overriding placement quarantine because every capacity-bearing node is quarantined",
        {
          nodeId: fallback.candidate.node.node_id,
          quarantinedUntilMs: fallback.quarantinedUntilMs,
        },
      );
    }

    for (const candidate of selectable) {
      if (
        !(await this.ensureNodeReady(candidate.node, {
          ...options,
          enforcePlacementIoPressure: true,
        }))
      ) {
        continue;
      }
      logger.info(
        `[docker-node-manager] Selected node ${candidate.node.node_id} (${candidate.allocated}/${candidate.node.capacity} used)`,
      );
      return { ...candidate.node, allocated_count: candidate.allocated };
    }

    logger.warn("[docker-node-manager] No reachable healthy nodes with capacity");
    return null;
  }

  /**
   * Get node configuration by node_id.
   */
  async getNodeConfig(nodeId: string): Promise<DockerNode | null> {
    return dockerNodesRepository.findByNodeId(nodeId);
  }

  // ---- SSH client construction ------------------------------------------

  /**
   * Build a pooled SSH client for a node, wiring the Trust-On-First-Use
   * persist callback: when the node's `host_key_fingerprint` is NULL, the
   * client accepts the presented key on first connect and this callback pins it
   * to `docker_nodes` (idempotent, NULL-guarded in the repo) so every later
   * connect verifies against a real fingerprint. Passing `host_key_fingerprint`
   * from the row keeps strict verification once a pin exists.
   */
  private sshClientForNode(node: DockerNode): DockerSSHClient {
    return DockerSSHClient.getClient(
      node.hostname,
      node.ssh_port ?? undefined,
      node.host_key_fingerprint ?? undefined,
      node.ssh_user ?? undefined,
      node.host_key_fingerprint
        ? undefined
        : async (hostname, fingerprint) => {
            await dockerNodesRepository.rotateNodeHostKeyFingerprint({
              id: node.id,
              nodeId: node.node_id,
              expectedFingerprint: null,
              observedFingerprint: fingerprint,
            });
            logger.warn(
              `[docker-node-manager] TOFU-pinned host key for node ${node.node_id} (${hostname}): SHA256:${fingerprint}`,
            );
          },
    );
  }

  // ---- Health Checks ----------------------------------------------------

  /**
   * Run health checks on all enabled nodes.
   * SSH into each node, verify Docker daemon is responsive, update status.
   */
  async healthCheckAll(): Promise<Map<string, DockerNodeStatus>> {
    const nodes = await dockerNodesRepository.findEnabled();
    const results = new Map<string, DockerNodeStatus>();

    const checks = nodes.map(async (node) => {
      const status = await this.healthCheckNode(node);
      results.set(node.node_id, status);
    });

    await Promise.allSettled(checks);
    return results;
  }

  /**
   * Health-check a single node via SSH.
   * Verifies Docker daemon is running by executing `docker info --format '{{.ID}}'`.
   * Retries up to MAX_RETRIES times before marking the node offline.
   */
  async healthCheckNode(node: DockerNode): Promise<DockerNodeStatus> {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 3_000;
    // Worst-case per node: MAX_RETRIES * (SSH_TIMEOUT + RETRY_DELAY) ≈ 39s with defaults
    let lastError: string = "";

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (isTypedHetznerCloudNode(node)) {
          await attestHetznerCloudNode(node, this.computeProvider());
        }
        const ssh = this.sshClientForNode(node);
        await ssh.connect();
        const dockerId = await ssh.exec("docker info --format '{{.ID}}'", 10_000);

        if (dockerId.trim()) {
          await this.attestBackupSourceBoot(node, ssh);
          // Disk-aware verdict: a node whose Docker daemon answers but whose
          // disk is critically full still can't pull images or provision agents
          // (`no space left on device`). Mark it `degraded` so the scheduler
          // stops placing on it (available only counts `healthy`) and the
          // autoscaler sees lost capacity and provisions a replacement. Probed
          // AFTER `docker info` confirmed reachability; a failed df read is
          // treated as `ok` (returns null → `ok`) so disk never owns
          // reachability — the docker-info probe does.
          const diskStatus = await this.diskHealthStatus(node);
          if (diskStatus === "critical") {
            // Only autoscaler-managed nodes are safe to drain on disk pressure:
            // the autoscaler replaces them, so `degraded` trades a full node for
            // a fresh one. Canonical (operator-managed) cores are NEVER
            // autoscaler-replaced AND the disk-clean cycle skips non-healthy
            // nodes — so marking a canonical node `degraded` would strand it
            // full with no automated remediation. Keep it `healthy` so the
            // disk-clean manager prunes it next cycle (the real fix) and surface
            // the pressure loudly for operators.
            if (isAutoscaledNode(node)) {
              logger.warn(
                `[docker-node-manager] Node ${node.node_id} (${node.hostname}) is reachable but disk is critically full; marking degraded so it drains/replaces instead of taking new work.`,
              );
              await dockerNodesRepository.updateStatus(node.node_id, "degraded");
              return "degraded";
            }
            logger.warn(
              `[docker-node-manager] Canonical node ${node.node_id} (${node.hostname}) is reachable but disk is critically full; leaving healthy so the disk-clean cycle can reclaim space (canonical nodes are not autoscaler-replaced). Operators: free space or set enabled=false.`,
            );
          }
          // Embedding-sidecar sub-verdict: surfaced (metadata + capacity report
          // + ERROR log) and self-healed, but it never owns the node status —
          // no agent is scheduled onto the sidecar itself, and flipping a whole
          // fleet to degraded because sidecars are missing would zero scheduling
          // capacity. The invariant is "absence is loud and converges", not
          // "absence drains the node".
          await this.embeddingSidecarHealth(node, ssh);
          // A reachable node clears any accumulated consecutive-failure count so
          // one recovered cycle undoes prior transient failures.
          nodeHealthFailureState.delete(node.node_id);
          await dockerNodesRepository.updateStatus(node.node_id, "healthy");
          return "healthy";
        } else {
          await this.invalidateBackupSourceBoot(node);
          lastError = "Docker returned empty ID";
        }
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : String(error);
        if (!(error instanceof BackupSourceRevocationError)) {
          try {
            await this.invalidateBackupSourceBoot(node);
          } catch (invalidationError) {
            // error-policy:J1 the health-loop boundary retains a failed revoke as
            // the attempt failure and returns only an explicit offline verdict.
            lastError =
              invalidationError instanceof Error
                ? invalidationError.message
                : String(invalidationError);
          }
        }
        if (attempt < MAX_RETRIES) {
          logger.warn(
            `[docker-node-manager] Health check attempt ${attempt}/${MAX_RETRIES} failed for ${node.node_id}: ${lastError}, retrying in ${RETRY_DELAY_MS}ms`,
          );
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }

    // All retries exhausted
    logger.warn(
      `[docker-node-manager] Health check failed for ${node.node_id} after ${MAX_RETRIES} attempts: ${lastError}`,
    );
    const status: DockerNodeStatus = lastError.includes("empty ID") ? "degraded" : "offline";

    // A `degraded` verdict means the daemon ANSWERED but returned no ID — the
    // node is reachable, just unhealthy. Persist it and let the disk-clean /
    // autoscaler paths handle it; it is not a "dead node" for auto-disable
    // purposes, so it never accrues toward the disable threshold. Because the
    // node WAS reachable this cycle, clear the consecutive-offline counter so a
    // reachable-but-degraded cycle breaks the "N consecutive UNREACHABLE checks"
    // streak (otherwise offline, offline, degraded, offline would wrongly disable).
    if (status === "degraded") {
      nodeHealthFailureState.delete(node.node_id);
      await dockerNodesRepository.updateStatus(node.node_id, "degraded");
      return "degraded";
    }

    // `offline` = unreachable. Previously we SUPPRESSED offline for canonical
    // (operator-managed) nodes to avoid flapping on a transient SSH hiccup —
    // but that let a genuinely-dead node keep reporting `healthy` forever, so
    // the scheduler kept routing agents onto a black hole. Replace that mask
    // with consecutive-failure tracking: persist `offline` every cycle, and
    // once a node has failed the reachability probe N cycles in a row (default
    // 3), auto-disable it (enabled=false) so it leaves rotation, with a loud
    // ERROR so operators are paged. A dead node must NEVER report healthy.
    const consecutive = (nodeHealthFailureState.get(node.node_id) ?? 0) + 1;
    nodeHealthFailureState.set(node.node_id, consecutive);

    if (consecutive >= NODE_HEALTH_FAILURE_THRESHOLD) {
      logger.error(
        `[docker-node-manager] Node ${node.node_id} (${node.hostname}) unreachable for ${consecutive} consecutive health checks (threshold ${NODE_HEALTH_FAILURE_THRESHOLD}); auto-disabling (enabled=false, status=offline) and routing it out of the pool. Last error: ${lastError}. Operator action required to re-enable.`,
        {
          nodeId: node.node_id,
          hostname: node.hostname,
          consecutiveFailures: consecutive,
          threshold: NODE_HEALTH_FAILURE_THRESHOLD,
        },
      );
      await dockerNodesRepository.markOfflineAndDisable(node.node_id);
      nodeHealthFailureState.delete(node.node_id);
      return "offline";
    }

    logger.warn(
      `[docker-node-manager] Node ${node.node_id} (${node.hostname}) unreachable (${consecutive}/${NODE_HEALTH_FAILURE_THRESHOLD} consecutive failures); marking offline. Will auto-disable if it keeps failing.`,
    );
    await dockerNodesRepository.updateStatus(node.node_id, "offline");
    return "offline";
  }

  /**
   * Publish an exact boot UUID only for explicitly typed Robot/Cloud rows.
   * An invalid observation may preserve operational health only after the old
   * incarnation is durably CAS-invalidated; failure to revoke it propagates to
   * the health/readiness boundary instead of leaving stale capture authority.
   */
  private async attestBackupSourceBoot(node: DockerNode, ssh: DockerSSHClient): Promise<void> {
    if (!hasTypedBackupSourceClassification(node)) return;
    let expectedHostKeyFingerprint = node.host_key_fingerprint;
    try {
      if (expectedHostKeyFingerprint === null) {
        const observedFingerprint = ssh.getVerifiedHostKeyFingerprint();
        if (!observedFingerprint) {
          throw new Error("Verified SSH connection did not expose its host-key fingerprint");
        }
        const pinned = await dockerNodesRepository.rotateNodeHostKeyFingerprint({
          id: node.id,
          nodeId: node.node_id,
          expectedFingerprint: null,
          observedFingerprint,
        });
        expectedHostKeyFingerprint = pinned.host_key_fingerprint;
      }
      if (expectedHostKeyFingerprint === null) {
        throw new Error("Backup source node has no persisted SSH host-key fingerprint");
      }
      const observedIncarnation = parseLinuxBootId(await ssh.exec(NODE_BOOT_ID_COMMAND, 10_000));
      await dockerNodesRepository.attestNodeIncarnation({
        id: node.id,
        nodeId: node.node_id,
        expectedIncarnation: node.node_incarnation,
        expectedHostKeyFingerprint,
        observedIncarnation,
      });
    } catch (error) {
      // error-policy:J1 source-attestation boundary translates every failed
      // proof into durable revocation before operational health may continue.
      logger.error(
        "[docker-node-manager] Backup source boot attestation failed; invalidating source authority",
        {
          nodeId: node.node_id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      await this.invalidateBackupSourceBoot(node, expectedHostKeyFingerprint);
    }
  }

  /** Revoke a typed source boot without inferring identity from node metadata. */
  private async invalidateBackupSourceBoot(
    node: DockerNode,
    expectedHostKeyFingerprint: string | null = node.host_key_fingerprint,
  ): Promise<void> {
    if (!hasTypedBackupSourceClassification(node)) return;
    try {
      await dockerNodesRepository.invalidateNodeIncarnation({
        id: node.id,
        nodeId: node.node_id,
        expectedIncarnation: node.node_incarnation,
        expectedHostKeyFingerprint,
      });
    } catch (error) {
      // error-policy:J2 callers must distinguish failed revocation from the
      // original SSH/probe error and preserve the repository failure as cause.
      throw new BackupSourceRevocationError(error);
    }
  }

  /**
   * Disk-aware health sub-verdict for a node already confirmed reachable. Reads
   * `df` over the shared SSH pool and applies the pure {@link diskHealthVerdict}
   * against `NODE_DISK_UNHEALTHY_THRESHOLD_PCT`. A failed df read yields `ok`
   * (null usage) so disk never owns reachability — the `docker info` probe does.
   * Isolated so a df hiccup can never throw out of the health check.
   */
  async diskHealthStatus(node: DockerNode): Promise<DiskHealthVerdict> {
    try {
      const usedPercent = await probeNodeDiskUsage(node);
      return diskHealthVerdict(usedPercent, containersEnv.nodeDiskUnhealthyThresholdPct());
    } catch (error) {
      logger.warn("[docker-node-manager] Disk health probe failed; treating as ok", {
        nodeId: node.node_id,
        hostname: node.hostname,
        error: error instanceof Error ? error.message : String(error),
      });
      return "ok";
    }
  }

  /**
   * Probe the node's local-embedding sidecar and persist the verdict to
   * `docker_nodes.metadata.embeddingSidecar` so its absence is a queryable
   * fleet fact (capacity report, admin API) instead of a silent fall-through
   * to the cloud embedding path — the failure mode that lost the fleet's
   * hand-installed sidecars unnoticed. When the sidecar is not serving, one
   * cooldown-gated ensure attempt re-installs it (the durable remediation for
   * nodes provisioned before the sidecar shipped in bootstrap); the persisted
   * verdict is re-probed AFTER the repair so recovery is visible immediately.
   *
   * Runs only after `docker info` confirmed reachability and never throws out
   * of the health check: like the disk sub-probe, the sidecar never owns
   * reachability — the docker-info probe does.
   */
  async embeddingSidecarHealth(node: DockerNode, ssh: DockerSSHClient): Promise<void> {
    try {
      let status = await this.probeEmbeddingSidecar(ssh);
      if (status === null) return;

      if (status !== "running" && containersEnv.embeddingSidecarSelfHealEnabled()) {
        const lastAttempt = embeddingSidecarSelfHealState.get(node.node_id) ?? 0;
        if (Date.now() - lastAttempt >= EMBEDDING_SIDECAR_SELF_HEAL_COOLDOWN_MS) {
          // Stamp BEFORE the attempt so a hanging/failing ensure still honors
          // the cooldown next cycle instead of re-pulling the image every tick.
          embeddingSidecarSelfHealState.set(node.node_id, Date.now());
          logger.warn(
            `[docker-node-manager] Embedding sidecar ${status} on node ${node.node_id} (${node.hostname}); attempting self-heal install`,
          );
          await ssh.exec(buildEnsureEmbeddingSidecarCmd(), EMBEDDING_SIDECAR_ENSURE_TIMEOUT_MS);
          status = (await this.probeEmbeddingSidecar(ssh)) ?? status;
        }
      }

      if (status === "running") {
        embeddingSidecarSelfHealState.delete(node.node_id);
      } else {
        logger.error(
          `[docker-node-manager] Embedding sidecar ${status} on node ${node.node_id} (${node.hostname}) — agents on this node cannot reach local embeddings. Self-heal ${containersEnv.embeddingSidecarSelfHealEnabled() ? "will retry after cooldown" : "is disabled"}.`,
          {
            nodeId: node.node_id,
            hostname: node.hostname,
            embeddingSidecar: status,
          },
        );
      }
      await dockerNodesRepository.setEmbeddingSidecarHealth(node.node_id, status);
    } catch (error) {
      // error-policy:J7 the sidecar sub-probe/self-heal is diagnostics on the
      // health loop; a thrown SSH/exec failure is logged loudly here and must
      // not take down the reachability verdict the loop exists to produce.
      logger.warn("[docker-node-manager] Embedding sidecar probe/self-heal failed", {
        nodeId: node.node_id,
        hostname: node.hostname,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Run the sidecar probe over SSH; null = probe output was unusable. */
  private async probeEmbeddingSidecar(
    ssh: DockerSSHClient,
  ): Promise<EmbeddingSidecarStatus | null> {
    const output = await ssh.exec(buildEmbeddingSidecarProbeCmd(), 20_000);
    const status = parseEmbeddingSidecarProbe(output);
    if (status === null) {
      logger.warn("[docker-node-manager] Embedding sidecar probe returned no status token", {
        output: truncateWellFormed(toWellFormedUnicode(output), 200),
      });
    }
    return status;
  }

  /**
   * Single-attempt readiness probe used during scheduling. This prevents stale
   * healthy rows from receiving new work when SSH credentials or the Docker
   * daemon are no longer valid.
   */
  async ensureNodeReady(node: DockerNode, options: NodeSelectionOptions = {}): Promise<boolean> {
    try {
      if (isTypedHetznerCloudNode(node)) {
        await attestHetznerCloudNode(node, this.computeProvider());
      }
      const ssh = this.sshClientForNode(node);
      await ssh.connect();
      const dockerInfoCommand = "docker info --format '{{.ID}}|{{.Architecture}}'";
      // Placement reads PSI in the same round trip because `docker info`
      // answers from daemon memory even when IO stalls `docker create`. Other
      // callers use this method as a liveness probe for sticky stateful routing
      // and autoscaler bootstrap, where transient pressure must not reroute or
      // reject the node.
      const extraSections: string[] = [];
      if (options.enforcePlacementIoPressure) {
        extraSections.push(
          `echo '${READINESS_PROBE_PSI_MARKER}'; cat /proc/pressure/io 2>/dev/null || true`,
        );
      }
      // The memory facts ride the same round trip: reading them separately would
      // race the placement they are meant to gate.
      if (typeof options.requiredMemoryMb === "number") {
        extraSections.push(
          `echo '${READINESS_PROBE_MEMINFO_MARKER}'; cat /proc/meminfo 2>/dev/null || true`,
          `echo '${READINESS_PROBE_COMMITTED_MARKER}'; docker ps -q | xargs -r docker inspect -f '{{.HostConfig.Memory}}' 2>/dev/null || true`,
        );
      }
      const probeCommand =
        extraSections.length > 0
          ? `${dockerInfoCommand} && { ${extraSections.join("; ")}; }`
          : dockerInfoCommand;
      const probeOutput = await ssh.exec(probeCommand, 10_000);
      const dockerSection = readProbeSection(probeOutput, null);
      const psiSection = readProbeSection(probeOutput, READINESS_PROBE_PSI_MARKER);
      const { dockerId, architecture } = parseDockerInfoProbe(dockerSection);
      if (dockerId.trim()) {
        await this.attestBackupSourceBoot(node, ssh);
        if (
          !isArchitectureCompatibleWithPlatform(architecture, options.requiredPlatform) &&
          requiredArchitectureForPlatform(options.requiredPlatform)
        ) {
          logger.warn("[docker-node-manager] Node is reachable but incompatible with image", {
            nodeId: node.node_id,
            architecture,
            requiredPlatform: options.requiredPlatform,
          });
          return false;
        }
        const ioPressure = options.enforcePlacementIoPressure
          ? parseIoPressureFullAvg60(psiSection)
          : null;
        if (ioPressure !== null && ioPressure >= PLACEMENT_MAX_IO_PRESSURE_FULL_AVG60) {
          // No DB status write: IO overload is transient and node-status flips
          // are reserved for dead/unreachable daemons (see the canonical-node
          // protection below).
          logger.warn("[docker-node-manager] Node refused for placement: IO-starved", {
            nodeId: node.node_id,
            ioPressureFullAvg60: ioPressure,
            max: PLACEMENT_MAX_IO_PRESSURE_FULL_AVG60,
          });
          return false;
        }
        if (typeof options.requiredMemoryMb === "number") {
          const meminfoSection = readProbeSection(probeOutput, READINESS_PROBE_MEMINFO_MARKER);
          const committedSection = readProbeSection(probeOutput, READINESS_PROBE_COMMITTED_MARKER);
          const snapshot = parseNodeMemorySnapshot(meminfoSection, committedSection);
          if (!snapshot) {
            // Admitting here is the deliberate direction, but it is the one
            // branch that restores pre-gate behaviour, so it must never be
            // silent: an edit to the probe command or the section grammar
            // would otherwise turn this gate into a permanent no-op that
            // neither the logs nor CI would notice.
            logger.warn(
              "[docker-node-manager] Memory admission skipped: node did not report readable memory facts",
              {
                nodeId: node.node_id,
                requiredMemoryMb: options.requiredMemoryMb,
                meminfoBytes: meminfoSection.length,
                committedBytes: committedSection.length,
              },
            );
          }
          if (snapshot) {
            const verdict = admitsRequiredMemory(snapshot, options.requiredMemoryMb);
            if (!verdict.admitted) {
              // No DB status write, for the same reason as IO: the node is
              // healthy, it is simply full. Marking it degraded would hide a
              // capacity problem behind an infrastructure one.
              logger.warn(
                "[docker-node-manager] Node refused for placement: memory would be oversubscribed",
                {
                  nodeId: node.node_id,
                  requiredMemoryMb: options.requiredMemoryMb,
                  effectiveCommittedMb: verdict.effectiveCommittedMb,
                  budgetMb: verdict.budgetMb,
                  memTotalMb: snapshot.memTotalMb,
                  memAvailableMb: snapshot.memAvailableMb,
                  declaredCeilingMb: snapshot.declaredCeilingMb,
                },
              );
              return false;
            }
          }
        }
        await dockerNodesRepository.updateStatus(node.node_id, "healthy");
        return true;
      }
      await this.invalidateBackupSourceBoot(node);
      if (isAutoscaledNode(node)) {
        await dockerNodesRepository.updateStatus(node.node_id, "degraded");
      } else {
        logger.warn(
          `[docker-node-manager] Suppressed degraded mark for canonical node ${node.node_id} (${node.hostname}); Docker probe returned empty ID`,
        );
      }
      logger.warn(`[docker-node-manager] Node ${node.node_id} Docker probe returned empty ID`);
      return false;
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof BackupSourceRevocationError)) {
        try {
          await this.invalidateBackupSourceBoot(node);
        } catch (invalidationError) {
          // error-policy:J1 readiness fails explicitly when source revocation
          // cannot be persisted; placement never treats this as a healthy node.
          message =
            invalidationError instanceof Error
              ? invalidationError.message
              : String(invalidationError);
        }
      }
      // See healthCheckNode for rationale: canonical nodes are never marked
      // offline from a transient ssh failure during scheduling.
      if (isAutoscaledNode(node)) {
        await dockerNodesRepository.updateStatus(node.node_id, "offline").catch((updateError) => {
          logger.warn("[docker-node-manager] Failed to mark node offline", {
            nodeId: node.node_id,
            error: updateError instanceof Error ? updateError.message : String(updateError),
          });
        });
      } else {
        logger.warn(
          `[docker-node-manager] Suppressed offline mark for canonical node ${node.node_id} (${node.hostname}): ${message}`,
        );
      }
      logger.warn(`[docker-node-manager] Node ${node.node_id} is not reachable: ${message}`);
      return false;
    }
  }

  // ---- Capacity Reporting -----------------------------------------------

  /**
   * Get a full capacity report across all nodes.
   */
  async getCapacityReport(): Promise<CapacitySummary> {
    const nodes = await dockerNodesRepository.findAll();
    const allocatedByNode = new Map(
      await Promise.all(
        nodes.map(
          async (node) =>
            [node.node_id, await countAllocatedWorkloadsOnNode(node.node_id)] as const,
        ),
      ),
    );

    const nodeReports: NodeCapacityReport[] = nodes.map((node) => ({
      nodeId: node.node_id,
      hostname: node.hostname,
      capacity: node.capacity,
      allocated: allocatedByNode.get(node.node_id) ?? node.allocated_count,
      available:
        node.enabled && node.status === "healthy"
          ? Math.max(0, node.capacity - (allocatedByNode.get(node.node_id) ?? node.allocated_count))
          : 0,
      status: node.status,
      enabled: node.enabled,
      lastHealthCheck: node.last_health_check,
      embeddingSidecar: embeddingSidecarStatusFromMetadata(node.metadata),
    }));

    const enabledNodes = nodeReports.filter((n) => n.enabled && n.status === "healthy");

    return {
      totalCapacity: enabledNodes.reduce((sum, n) => sum + n.capacity, 0),
      totalAllocated: enabledNodes.reduce((sum, n) => sum + n.allocated, 0),
      totalAvailable: enabledNodes.reduce((sum, n) => sum + n.available, 0),
      nodes: nodeReports,
    };
  }

  // ---- Allocation Sync --------------------------------------------------

  /**
   * Count actual active workloads per node from the database and reconcile
   * allocated_count in docker_nodes.
   *
   * The Docker pool is shared by user `containers` and managed
   * `agent_sandboxes`; both must be counted or the scheduler can overfill a
   * node or drain a node that still has agent workloads.
   */
  async syncAllocatedCounts(): Promise<Map<string, { before: number; after: number }>> {
    const nodes = await dockerNodesRepository.findEnabled();
    const changes = new Map<string, { before: number; after: number }>();

    for (const node of nodes) {
      const actualCount = await countAllocatedWorkloadsOnNode(node.node_id);

      if (actualCount !== node.allocated_count) {
        logger.info(
          `[docker-node-manager] Sync ${node.node_id}: allocated_count ${node.allocated_count} → ${actualCount}`,
        );
        await dockerNodesRepository.setAllocatedCount(node.node_id, actualCount);
        changes.set(node.node_id, {
          before: node.allocated_count,
          after: actualCount,
        });
      }
    }

    if (changes.size > 0) {
      logger.info(`[docker-node-manager] Synced allocated counts for ${changes.size} node(s)`);
    }

    return changes;
  }

  /**
   * Pre-pull the agent image on healthy nodes with spare capacity so a
   * subsequent agent provision does not pay the Docker image cold-start cost.
   */
  async prePullAgentImageOnAvailableNodes(
    image = containersEnv.defaultAgentImage(),
    platform = containersEnv.defaultAgentImagePlatform(),
  ): Promise<
    Array<{
      nodeId: string;
      hostname: string;
      available: number;
      status: "pulled" | "skipped" | "failed";
      reason?: string;
      error?: string;
    }>
  > {
    const nodes = await dockerNodesRepository.findEnabled();

    return Promise.all(
      nodes.map(async (node) => {
        const allocated = await countAllocatedWorkloadsOnNode(node.node_id);
        const available = Math.max(0, node.capacity - allocated);

        if (node.status !== "healthy") {
          return {
            nodeId: node.node_id,
            hostname: node.hostname,
            available,
            status: "skipped" as const,
            reason: `node status is ${node.status}`,
          };
        }

        if (available <= 0) {
          return {
            nodeId: node.node_id,
            hostname: node.hostname,
            available,
            status: "skipped" as const,
            reason: "no spare slots",
          };
        }

        if (!isNodeMetadataCompatible(node, platform)) {
          return {
            nodeId: node.node_id,
            hostname: node.hostname,
            available,
            status: "skipped" as const,
            reason: `node architecture is incompatible with ${platform}`,
          };
        }

        const ssh = this.sshClientForNode(node);
        const prePull = buildTrackedPrePullCommand(image, platform);
        try {
          await ssh.connect();
          await ssh.exec(prePull.command, 5 * 60 * 1000);
          // Success: clear any prior wedge / self-heal bookkeeping for this node.
          prePullFailureState.delete(node.node_id);
          return {
            nodeId: node.node_id,
            hostname: node.hostname,
            available,
            status: "pulled" as const,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn("[docker-node-manager] Agent image pre-pull failed", {
            nodeId: node.node_id,
            image,
            error: message,
          });
          if (isDockerSshCommandTimeoutError(error)) {
            // A timed-out `docker pull` is NOT stopped by DockerSSHClient's
            // channel-close (that only sends SIGHUP, which a detached `docker
            // pull` ignores), so it can keep running. The tracked wrapper leaves
            // a PID file only for this pre-pull, so recovery does not kill
            // unrelated deployment pulls on the same node.
            await this.recoverAfterTimedOutPrePull(ssh, node, prePull.pidFile, image);
          } else {
            prePullFailureState.delete(node.node_id);
          }
          return {
            nodeId: node.node_id,
            hostname: node.hostname,
            available,
            status: "failed" as const,
            error: message,
          };
        }
      }),
    );
  }

  /**
   * Cleanup + optional self-heal after a pre-pull times out on a node.
   *
   * (a) SIGKILL only the PID recorded by the timed-out pre-pull wrapper, after
   *     verifying the process is still a `docker pull` for the same image.
   * (b) If a node keeps failing (its daemon is already wedged) and self-heal
   *     is enabled, restart docker once per cooldown to recover automatically
   *     instead of paging an operator. `live-restore` (node bootstrap
   *     daemon.json) keeps running agent containers alive across the restart.
   */
  private async recoverAfterTimedOutPrePull(
    ssh: DockerSSHClient,
    node: DockerNode,
    pidFile: string,
    image: string,
  ): Promise<void> {
    try {
      await ssh.exec(buildPrePullReapCommand(pidFile, image), 20_000);
    } catch (killError) {
      // error-policy:J6 best-effort timeout orphan cleanup; the pre-pull has
      // already failed and the next cycle can retry the scoped PID reap.
      logger.warn(
        "[docker-node-manager] Failed to reap orphaned docker pull after pre-pull failure",
        {
          nodeId: node.node_id,
          error: killError instanceof Error ? killError.message : String(killError),
        },
      );
    }

    // (b) Track consecutive failures; auto-recover a wedged daemon when enabled.
    const state = prePullFailureState.get(node.node_id) ?? {
      consecutiveFailures: 0,
      lastSelfHealMs: 0,
    };
    state.consecutiveFailures += 1;
    prePullFailureState.set(node.node_id, state);

    if (!containersEnv.prePullSelfHealRestartEnabled()) return;
    if (state.consecutiveFailures < PREPULL_SELF_HEAL_FAILURE_THRESHOLD) return;
    if (Date.now() - state.lastSelfHealMs < PREPULL_SELF_HEAL_COOLDOWN_MS) return;

    logger.error(
      "[docker-node-manager] Pre-pull wedged repeatedly; auto-restarting docker to self-heal",
      {
        nodeId: node.node_id,
        hostname: node.hostname,
        consecutiveFailures: state.consecutiveFailures,
      },
    );
    try {
      // Live staging showed graceful `systemctl restart docker` can hang when
      // dockerd/containerd content ingest is already wedged. Stamp the cooldown
      // before attempting the shared-host recovery, then force-kill dockerd and
      // bounce containerd; live-restore plus container shims keep agents alive.
      state.lastSelfHealMs = Date.now();
      prePullFailureState.set(node.node_id, state);
      await ssh.exec(buildPrePullSelfHealRecoverCommand(), 120_000);
      state.consecutiveFailures = 0;
      prePullFailureState.set(node.node_id, state);
    } catch (restartError) {
      // error-policy:J6 best-effort node self-heal; failure is visible in logs
      // and the cooldown/threshold state lets a later cycle retry.
      logger.error("[docker-node-manager] Self-heal docker restart failed", {
        nodeId: node.node_id,
        error: restartError instanceof Error ? restartError.message : String(restartError),
      });
    }
  }

  // ---- Runtime Container Inspection -------------------------------------

  /**
   * List running containers on a node via SSH.
   * Returns container names matching the sandbox pattern.
   */
  async getRuntimeContainers(
    node: DockerNode,
  ): Promise<{ name: string; id: string; state: string; status: string }[] | null> {
    try {
      const ssh = this.sshClientForNode(node);
      await ssh.connect();

      const output = await ssh.exec(
        "docker ps -a --format '{{.Names}}|{{.ID}}|{{.State}}|{{.Status}}'",
        15_000,
      );

      return output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name = "", id = "", state = "", status = ""] = line.split("|");
          return { name, id, state: state.toLowerCase(), status };
        });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[docker-node-manager] Failed to list containers on ${node.node_id}: ${msg}`);
      return null;
    }
  }
}

function hasTypedBackupSourceClassification(node: DockerNode): boolean {
  if (node.infrastructure_provider !== "hetzner") return false;
  return (
    (node.fleet_kind === "robot" && node.provider_server_id === null) ||
    (node.fleet_kind === "cloud" &&
      typeof node.provider_server_id === "string" &&
      node.provider_server_id.length > 0)
  );
}

export const dockerNodeManager = DockerNodeManager.getInstance();

function isNodeMetadataCompatible(
  node: DockerNode,
  requiredPlatform: string | undefined | null,
): boolean {
  if (!requiredArchitectureForPlatform(requiredPlatform)) return true;
  return isArchitectureCompatibleWithPlatform(
    inferNodeArchitectureFromMetadata(node.metadata),
    requiredPlatform,
  );
}

function parseDockerInfoProbe(output: string): {
  dockerId: string;
  architecture: ReturnType<typeof normalizeDockerArchitecture>;
} {
  const lines = output
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  let line = "";
  for (let index = lines.length - 1; index >= 0; index--) {
    const candidate = lines[index]!;
    if (!candidate.startsWith("[stderr]")) {
      line = candidate;
      break;
    }
  }
  const [dockerId = "", rawArchitecture = ""] = line.split("|");
  return {
    dockerId,
    architecture: normalizeDockerArchitecture(rawArchitecture),
  };
}
