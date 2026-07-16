/**
 * The per-window state machine that guarantees exactly one shell chat/voice
 * engine across the desktop's webviews (#16442). Every window runs one
 * `ShellControllerCoordinator`; together they elect a single owner from a shared
 * presence table, and only the owner instantiates the engine. Followers apply
 * the owner's snapshots and forward typed, idempotent commands.
 *
 * It is deliberately transport- and React-agnostic and holds NO timers: the
 * clock is injected (`now`) and time only advances when the host calls `tick()`.
 * That makes owner election, stale-snapshot rejection, command idempotency,
 * crash re-election, and version-mismatch degrade all provable without a desktop
 * or fake-timer choreography — see `coordinator.test.ts`. The React host
 * (`useShellControllerSync.ts`) supplies the real interval + wall clock.
 */
import {
  electOwnerWindowId,
  isProtocolCompatible,
  isSnapshotNewer,
  pruneStalePeers,
  SHELL_SYNC_PROTOCOL_VERSION,
  type ShellControllerCommand,
  type ShellPeer,
  type ShellSyncEnvelope,
  type ShellWindowRole,
} from "./protocol";
import type { ShellControllerSnapshot } from "./snapshot";
import type { ShellSyncTransport } from "./transport";

/** A follower's live link to the owner. `connecting` before the first snapshot,
 *  `connected` once one arrives, `disconnected` when the owner is gone (pruned)
 *  and re-election has not yet produced a new one, `version-mismatch` when the
 *  owner speaks an incompatible protocol. Distinct renders, never silent. */
export type ShellFollowerStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "version-mismatch";

export interface ShellCoordinatorOptions {
  windowId: string;
  priority: number;
  transport: ShellSyncTransport;
  now: () => number;
  /** How long since a peer's last announce before it is presumed gone. Must be a
   *  few heartbeats so a slow tick does not evict a live owner. */
  peerTtlMs?: number;
  protocolVersion?: string;
  /** When true, this window may claim ownership the instant it computes itself
   *  the rightful owner. A lone window (no cross-window transport) sets this. A
   *  multi-window desktop window leaves it false and calls `completeDiscovery()`
   *  after a short grace, so a joiner hears an existing owner before it would
   *  otherwise briefly claim and flash a second engine. */
  claimOwnershipImmediately?: boolean;
  onRoleChange?: (role: ShellWindowRole) => void;
  onStatusChange?: (status: ShellFollowerStatus) => void;
  /** Latest snapshot a follower should render, or null when none is available. */
  onSnapshot?: (snapshot: ShellControllerSnapshot | null) => void;
  /** Owner-side: apply a follower's command against the real engine. May throw;
   *  the throw becomes a failed ack the follower observes. */
  onCommand?: (command: ShellControllerCommand) => void;
  /** Surface a coordinator-internal failure (e.g. an owner-side command apply
   *  that threw) to the host's error channel. The failed ack already signals the
   *  follower; this lets the OWNER window observe it too. */
  onError?: (message: string, error: unknown, context?: Record<string, unknown>) => void;
}

const DEFAULT_PEER_TTL_MS = 6000;
const COMMAND_ACK_TIMEOUT_MS = 5000;
const SEEN_COMMAND_LIMIT = 512;

interface PendingCommand {
  resolve: () => void;
  reject: (error: Error) => void;
  deadlineMs: number;
}

let commandCounter = 0;

function generateCommandId(windowId: string): string {
  commandCounter += 1;
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${commandCounter}`;
  return `${windowId}:${rand}`;
}

export class ShellControllerCoordinator {
  private readonly windowId: string;
  private readonly priority: number;
  private readonly transport: ShellSyncTransport;
  private readonly now: () => number;
  private readonly peerTtlMs: number;
  private readonly protocolVersion: string;
  private readonly opts: ShellCoordinatorOptions;

  private readonly peers = new Map<string, ShellPeer>();
  private unsubscribe: (() => void) | null = null;
  private started = false;

  private role: ShellWindowRole = "follower";
  private status: ShellFollowerStatus = "connecting";
  /** Gate on claiming ownership until discovery completes; see the option doc. */
  private canClaim: boolean;

  /** Owner-side outbound epoch/seq. `epoch` starts above any epoch this window
   *  saw as a follower so a new owner's snapshots always beat the old owner's. */
  private ownerEpoch = 0;
  private ownerSeq = 0;
  /** The last snapshot the owner broadcast, replayed (targeted) to a late joiner
   *  so a newly-opened window sees current state without waiting for the next
   *  engine change. */
  private lastSnapshot: ShellControllerSnapshot | null = null;
  /** Highest epoch observed in any snapshot, used to seed `ownerEpoch` on
   *  promotion so handoffs stay monotonic. */
  private highestSeenEpoch = 0;

  /** Follower-side last-applied position, for stale-snapshot rejection. */
  private applied: { epoch: number; seq: number } | null = null;

  /** Owner-side idempotency: command ids already applied (insertion-ordered so
   *  the oldest evicts first when bounded). */
  private readonly seenCommandIds = new Set<string>();
  /** Follower-side in-flight commands awaiting an ack. */
  private readonly pending = new Map<string, PendingCommand>();

  constructor(options: ShellCoordinatorOptions) {
    this.windowId = options.windowId;
    this.priority = options.priority;
    this.transport = options.transport;
    this.now = options.now;
    this.peerTtlMs = options.peerTtlMs ?? DEFAULT_PEER_TTL_MS;
    this.protocolVersion = options.protocolVersion ?? SHELL_SYNC_PROTOCOL_VERSION;
    this.canClaim = options.claimOwnershipImmediately ?? false;
    this.opts = options;
  }

  /** Called by the host once the join grace has elapsed: this window may now
   *  claim ownership if it is the rightful owner and none exists. Idempotent. */
  completeDiscovery(): void {
    if (this.canClaim) return;
    this.canClaim = true;
    this.recomputeOwner();
  }

  getRole(): ShellWindowRole {
    return this.role;
  }

  getStatus(): ShellFollowerStatus {
    return this.status;
  }

  /** Join the bus: record self, announce, subscribe, and elect. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.peers.set(this.windowId, {
      windowId: this.windowId,
      priority: this.priority,
      protocolVersion: this.protocolVersion,
      lastSeenMs: this.now(),
    });
    this.unsubscribe = this.transport.subscribe((envelope) =>
      this.handleEnvelope(envelope),
    );
    this.announce("announce");
    this.recomputeOwner();
  }

  /** Leave the bus cleanly so peers re-elect immediately instead of waiting for
   *  the TTL. Idempotent. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.announce("bye");
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const [, pending] of this.pending) {
      pending.reject(new Error("shell-sync: coordinator stopped"));
    }
    this.pending.clear();
  }

  /**
   * Advance the clock: refresh self, heartbeat, prune the dead, time out stale
   * pending commands, and re-elect. The host calls this on a fixed interval.
   */
  tick(): void {
    if (!this.started) return;
    const nowMs = this.now();
    const self = this.peers.get(this.windowId);
    if (self) self.lastSeenMs = nowMs;
    this.announce("announce");

    const survivors = pruneStalePeers([...this.peers.values()], nowMs, this.peerTtlMs);
    this.peers.clear();
    for (const peer of survivors) this.peers.set(peer.windowId, peer);
    // Self never evicts itself even under a long stall between ticks.
    if (!this.peers.has(this.windowId)) {
      this.peers.set(this.windowId, {
        windowId: this.windowId,
        priority: this.priority,
        protocolVersion: this.protocolVersion,
        lastSeenMs: nowMs,
      });
    }

    for (const [commandId, pending] of [...this.pending]) {
      if (nowMs >= pending.deadlineMs) {
        this.pending.delete(commandId);
        pending.reject(new Error("shell-sync: command timed out"));
      }
    }

    this.recomputeOwner();
  }

  /**
   * Owner-side: broadcast the latest engine snapshot. Coalescing (skipping
   * unchanged snapshots) is the caller's job; this always advances `seq` so
   * followers can order what they receive. No-op for a follower.
   */
  publishSnapshot(snapshot: ShellControllerSnapshot): void {
    if (this.role !== "owner") return;
    this.lastSnapshot = snapshot;
    this.ownerSeq += 1;
    this.transport.send({
      type: "snapshot",
      protocolVersion: this.protocolVersion,
      ownerWindowId: this.windowId,
      epoch: this.ownerEpoch,
      seq: this.ownerSeq,
      snapshot,
    });
  }

  /**
   * Follower-side: send a command to the owner and resolve when it acks. An
   * owner applies its own commands locally (the follower controller is only
   * built for followers, but this keeps the call total). Rejects — visibly — on
   * a failed ack, a timeout, or when no owner exists.
   */
  dispatchCommand(command: ShellControllerCommand): Promise<void> {
    if (this.role === "owner") {
      try {
        this.opts.onCommand?.(command);
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    const ownerId = electOwnerWindowId([...this.peers.values()]);
    if (!ownerId || ownerId === this.windowId) {
      return Promise.reject(new Error("shell-sync: no owner to receive command"));
    }
    const commandId = generateCommandId(this.windowId);
    return new Promise<void>((resolve, reject) => {
      this.pending.set(commandId, {
        resolve,
        reject,
        deadlineMs: this.now() + COMMAND_ACK_TIMEOUT_MS,
      });
      this.transport.send({
        type: "command",
        protocolVersion: this.protocolVersion,
        commandId,
        fromWindowId: this.windowId,
        command,
      });
    });
  }

  private announce(event: "announce" | "bye"): void {
    this.transport.send({
      type: "presence",
      protocolVersion: this.protocolVersion,
      event,
      windowId: this.windowId,
      priority: this.priority,
    });
  }

  private handleEnvelope(envelope: ShellSyncEnvelope): void {
    switch (envelope.type) {
      case "presence":
        // Presence is seated even from an incompatible peer: it must still
        // compete for ownership so this window does not spawn a second engine
        // across the version boundary. A follower of an incompatible owner
        // degrades (see recomputeOwner), rather than running its own.
        this.handlePresence(envelope);
        return;
      case "snapshot":
        this.handleSnapshot(envelope);
        return;
      case "command":
        // A command from an incompatible follower is rejected with a reason, not
        // applied against fields that may have moved.
        if (!isProtocolCompatible(envelope.protocolVersion)) {
          if (this.role === "owner") {
            this.sendAck(
              envelope.commandId,
              envelope.fromWindowId,
              false,
              "version-mismatch",
            );
          }
          return;
        }
        this.handleCommand(envelope);
        return;
      case "ack":
        if (!isProtocolCompatible(envelope.protocolVersion)) return;
        this.handleAck(envelope);
        return;
      default: {
        const _exhaustive: never = envelope;
        return _exhaustive;
      }
    }
  }

  private handlePresence(
    envelope: Extract<ShellSyncEnvelope, { type: "presence" }>,
  ): void {
    const { event, windowId, priority, protocolVersion } = envelope;
    if (windowId === this.windowId) return;
    if (event === "bye") {
      this.peers.delete(windowId);
      this.recomputeOwner();
      return;
    }
    // A newcomer that announces after we joined never heard our initial
    // announce. Echo ours exactly once (only for a peer we did not already know)
    // so presence converges without an announce storm, and — if we own the
    // engine — replay the current snapshot to it so it renders immediately.
    const isNewPeer = !this.peers.has(windowId);
    this.peers.set(windowId, {
      windowId,
      priority,
      protocolVersion,
      lastSeenMs: this.now(),
    });
    this.recomputeOwner();
    if (isNewPeer) {
      this.announce("announce");
      if (this.role === "owner" && this.lastSnapshot) {
        this.publishSnapshotTo(windowId, this.lastSnapshot);
      }
    }
  }

  private publishSnapshotTo(
    targetWindowId: string,
    snapshot: ShellControllerSnapshot,
  ): void {
    this.ownerSeq += 1;
    this.transport.send({
      type: "snapshot",
      protocolVersion: this.protocolVersion,
      ownerWindowId: this.windowId,
      epoch: this.ownerEpoch,
      seq: this.ownerSeq,
      snapshot,
      targetWindowId,
    });
  }

  private handleSnapshot(
    envelope: Extract<ShellSyncEnvelope, { type: "snapshot" }>,
  ): void {
    if (envelope.epoch > this.highestSeenEpoch) {
      this.highestSeenEpoch = envelope.epoch;
    }
    // A targeted re-publish is only for its addressee; ignoring it elsewhere
    // keeps a late joiner's rejoin from resetting everyone's applied position.
    if (envelope.targetWindowId && envelope.targetWindowId !== this.windowId) {
      return;
    }
    if (this.role !== "follower") return;
    const incompatible = !isProtocolCompatible(envelope.protocolVersion);
    // A compatible-but-stale/zombie snapshot is dropped WITHOUT touching the
    // peer table, so a late duplicate from a dead owner cannot re-seat it.
    if (!incompatible && !isSnapshotNewer(envelope, this.applied)) return;
    // Refresh the (live) owner's liveness + version from its snapshots too, so a
    // chatty owner is never pruned between heartbeats.
    this.peers.set(envelope.ownerWindowId, {
      windowId: envelope.ownerWindowId,
      priority:
        this.peers.get(envelope.ownerWindowId)?.priority ?? this.priority,
      protocolVersion: envelope.protocolVersion,
      lastSeenMs: this.now(),
    });
    // An owner speaking an incompatible protocol: never render its snapshot;
    // show the version-mismatch degrade. recomputeOwner also drives this, but a
    // snapshot can arrive before the presence table catches the owner's version.
    if (incompatible) {
      this.setStatus("version-mismatch");
      this.opts.onSnapshot?.(null);
      return;
    }
    this.applied = { epoch: envelope.epoch, seq: envelope.seq };
    this.setStatus("connected");
    this.opts.onSnapshot?.(envelope.snapshot);
  }

  private handleCommand(
    envelope: Extract<ShellSyncEnvelope, { type: "command" }>,
  ): void {
    if (this.role !== "owner") return;
    // Idempotency: a redelivered command re-acks success but never re-applies.
    if (this.seenCommandIds.has(envelope.commandId)) {
      this.sendAck(envelope.commandId, envelope.fromWindowId, true);
      return;
    }
    this.rememberCommandId(envelope.commandId);
    try {
      this.opts.onCommand?.(envelope.command);
      this.sendAck(envelope.commandId, envelope.fromWindowId, true);
    } catch (error) {
      // The failed ack is the follower's observable signal; also report so the
      // owner window surfaces the failure to the agent/owner.
      this.opts.onError?.("shell-sync command apply failed", error, {
        command: envelope.command.kind,
      });
      this.sendAck(
        envelope.commandId,
        envelope.fromWindowId,
        false,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private handleAck(
    envelope: Extract<ShellSyncEnvelope, { type: "ack" }>,
  ): void {
    if (envelope.toWindowId !== this.windowId) return;
    const pending = this.pending.get(envelope.commandId);
    if (!pending) return;
    this.pending.delete(envelope.commandId);
    if (envelope.ok) pending.resolve();
    else pending.reject(new Error(envelope.error || "shell-sync: command rejected"));
  }

  private sendAck(
    commandId: string,
    toWindowId: string,
    ok: boolean,
    error?: string,
  ): void {
    this.transport.send({
      type: "ack",
      protocolVersion: this.protocolVersion,
      commandId,
      toWindowId,
      ok,
      ...(error ? { error } : {}),
    });
  }

  private rememberCommandId(commandId: string): void {
    this.seenCommandIds.add(commandId);
    if (this.seenCommandIds.size > SEEN_COMMAND_LIMIT) {
      const oldest = this.seenCommandIds.values().next().value;
      if (oldest !== undefined) this.seenCommandIds.delete(oldest);
    }
  }

  private recomputeOwner(): void {
    const ownerId = electOwnerWindowId([...this.peers.values()]);
    const ownerIncompatible =
      ownerId !== null &&
      ownerId !== this.windowId &&
      !isProtocolCompatible(
        this.peers.get(ownerId)?.protocolVersion ??
          SHELL_SYNC_PROTOCOL_VERSION,
      );
    const iAmElected = ownerId === this.windowId;
    // Elected owner but still inside the discovery grace: stay a follower and
    // keep the engine unmounted until the grace elapses, so a just-opened window
    // never briefly claims ownership over an owner it has not heard from yet.
    const claimingOwnership = iAmElected && this.canClaim;
    const nextRole: ShellWindowRole = claimingOwnership ? "owner" : "follower";

    if (nextRole === this.role) {
      // Role unchanged, but the follower's link status may still need to move.
      if (nextRole === "follower") {
        if (iAmElected) this.setStatus("connecting");
        else if (!ownerId) this.setStatus("disconnected");
        else if (ownerIncompatible) this.setStatus("version-mismatch");
      }
      return;
    }

    this.role = nextRole;
    if (nextRole === "owner") {
      // Seed the outbound epoch above anything seen so old-owner snapshots that
      // arrive late are dropped by every follower.
      this.ownerEpoch = this.highestSeenEpoch + 1;
      this.highestSeenEpoch = this.ownerEpoch;
      this.ownerSeq = 0;
      this.applied = null;
    } else {
      // Demoted to follower: forget our outbound position and wait for the new
      // owner's snapshots. Following an incompatible owner is a visible degrade,
      // never a duplicate engine.
      this.applied = null;
      this.setStatus(
        !ownerId
          ? "disconnected"
          : ownerIncompatible
            ? "version-mismatch"
            : "connecting",
      );
      this.opts.onSnapshot?.(null);
    }
    this.opts.onRoleChange?.(nextRole);
  }

  private setStatus(status: ShellFollowerStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatusChange?.(status);
  }
}
