/**
 * `InMemoryComputeProvider` — a deterministic, in-memory fake of the
 * `ComputeProvider` IaaS seam.
 *
 * Purpose: let the warm-pool scheduler, autoscaler, and sidecar lifecycle code
 * be exercised end-to-end with NO network, NO real clock, and NO randomness,
 * while faithfully simulating the *asynchronous* shape of a real IaaS provider
 * (DigitalOcean / Hetzner): `createServer` returns before the server is ready,
 * `createVolume` is provisioned before it is `available`, attach/detach/power
 * actions go `in-progress` then `completed`, and `waitForAction` resolves the
 * action to its terminal state.
 *
 * Determinism contract
 * --------------------
 *  - Time is an injected integer tick counter, advanced ONLY by `tick(n?)`.
 *    Nothing here reads `Date.now()`, `Math.random()`, or schedules a timer.
 *  - Reads (`getServer`, `getVolume`, `listServers`, ...) are PURE functions of
 *    (state, currentTick): they never mutate the simulation, never auto-advance
 *    the clock. A server flips `new → active` because ticks were *advanced* past
 *    its `activeAtTick`, not because `getServer` was *called*.
 *  - `waitForAction` does NOT sleep. It force-resolves the action to terminal
 *    (`completed`, or `errored` for a poisoned id) and returns it. Poisoned
 *    actions resolve to an `error` action WITHOUT throwing (mirrors the real
 *    Hetzner client returning the error action rather than rejecting).
 *
 * Status vocabulary (DO-native, self-consistent; the interface only requires
 * `status: string`, so the fake is free to pick its own strings):
 *  - server:  `new`         → `active`
 *  - volume:  `creating`    → `available`
 *  - action:  `in-progress` → `completed` | `errored`
 *
 * Ids are assigned from a single deterministic monotonically-increasing counter
 * so every test run produces identical ids.
 */

import type {
  ComputeAction,
  ComputeImage,
  ComputeLocation,
  ComputeProvider,
  ComputeServer,
  ComputeServerType,
  ComputeVolume,
  CreateServerInput,
  CreateVolumeInput,
  ProvisionedServer,
} from "./compute-provider";

// ---------------------------------------------------------------------------
// Status constants (single source of truth shared by emitters + waitForAction)
// ---------------------------------------------------------------------------

export const SERVER_STATUS_NEW = "new";
export const SERVER_STATUS_ACTIVE = "active";
export const VOLUME_STATUS_CREATING = "creating";
export const VOLUME_STATUS_AVAILABLE = "available";
export const ACTION_STATUS_IN_PROGRESS = "in-progress";
export const ACTION_STATUS_COMPLETED = "completed";
export const ACTION_STATUS_ERRORED = "errored";

/**
 * Error thrown by the fake for capacity / limit violations. Not bound to any
 * provider's concrete error type — the fake is a test double, so a recognizable
 * `code` is enough for assertions.
 */
export class ComputeFakeError extends Error {
  constructor(
    public readonly code: "no_capacity" | "not_found" | "invalid_input",
    message: string,
  ) {
    super(message);
    this.name = "ComputeFakeError";
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface InMemoryComputeProviderConfig {
  /** Tick at which the simulation starts. Default 0. */
  startTick?: number;
  /**
   * Number of ticks after `createServer` before `getServer` reports `active`.
   * `0` means a server is active immediately (at the tick it was created).
   * Default 3.
   */
  serverActivateAfterTicks?: number;
  /**
   * Number of ticks after `createVolume` before a volume reports `available`.
   * `0` means available immediately. Default 1.
   */
  volumeAvailableAfterTicks?: number;
  /**
   * Maximum number of *live* (not-yet-deleted) servers. Once reached,
   * `createServer` rejects with `ComputeFakeError("no_capacity")`. Default
   * `Infinity` (unbounded).
   */
  maxServers?: number;
  /**
   * Maximum number of *live* volumes. Once reached, `createVolume` rejects with
   * `ComputeFakeError("no_capacity")`. Default `Infinity` (unbounded).
   */
  maxVolumes?: number;
  /**
   * Action ids that `waitForAction` resolves to an `errored` state instead of
   * `completed`. Seeded ids are matched against the action id the fake mints;
   * since ids are deterministic this can be pre-seeded, or use `poisonAction`
   * after an action has been returned.
   */
  poisonedActionIds?: Iterable<number>;
}

// ---------------------------------------------------------------------------
// Internal state records
// ---------------------------------------------------------------------------

interface ServerRecord {
  id: number;
  name: string;
  createdTick: number;
  activeAtTick: number;
  createdIso: string;
  labels: Record<string, string>;
  deleted: boolean;
}

interface VolumeRecord {
  id: number;
  name: string;
  size: number;
  location: string;
  createdTick: number;
  availableAtTick: number;
  server: number | null;
  labels: Record<string, string>;
  deleted: boolean;
}

interface ActionRecord {
  id: number;
  command: string;
  /** Tick at which the action was issued; terminal once `waitForAction` runs. */
  status: string;
  error: { code: string; message: string } | null;
}

// ---------------------------------------------------------------------------
// InMemoryComputeProvider
// ---------------------------------------------------------------------------

export class InMemoryComputeProvider implements ComputeProvider {
  private currentTick: number;
  private readonly serverActivateAfterTicks: number;
  private readonly volumeAvailableAfterTicks: number;
  private readonly maxServers: number;
  private readonly maxVolumes: number;

  private nextId = 1;
  private readonly servers = new Map<number, ServerRecord>();
  private readonly volumes = new Map<number, VolumeRecord>();
  private readonly actions = new Map<number, ActionRecord>();
  private readonly poisonedActionIds: Set<number>;

  constructor(config: InMemoryComputeProviderConfig = {}) {
    this.currentTick = config.startTick ?? 0;
    this.serverActivateAfterTicks = config.serverActivateAfterTicks ?? 3;
    this.volumeAvailableAfterTicks = config.volumeAvailableAfterTicks ?? 1;
    this.maxServers = config.maxServers ?? Number.POSITIVE_INFINITY;
    this.maxVolumes = config.maxVolumes ?? Number.POSITIVE_INFINITY;
    this.poisonedActionIds = new Set(config.poisonedActionIds ?? []);
  }

  // -- Injected clock ------------------------------------------------------

  /** The current simulated tick. Pure read. */
  now(): number {
    return this.currentTick;
  }

  /** Advance the simulated clock by `n` ticks (default 1). Returns the new tick. */
  tick(n = 1): number {
    if (!Number.isInteger(n) || n < 0) {
      throw new ComputeFakeError(
        "invalid_input",
        `tick(n) requires a non-negative integer, got ${n}`,
      );
    }
    this.currentTick += n;
    return this.currentTick;
  }

  /** Mark an action id so a subsequent `waitForAction` resolves it `errored`. */
  poisonAction(actionId: number): void {
    this.poisonedActionIds.add(actionId);
  }

  // ----------------------------------------------------------------------
  // Server lifecycle
  // ----------------------------------------------------------------------

  async listServers(labels?: Record<string, string>): Promise<ComputeServer[]> {
    const out: ComputeServer[] = [];
    for (const rec of this.servers.values()) {
      if (rec.deleted) continue;
      if (labels && !matchesLabels(rec.labels, labels)) continue;
      out.push(this.toServer(rec));
    }
    return out;
  }

  async getServer(id: number): Promise<ComputeServer | null> {
    const rec = this.servers.get(id);
    if (!rec || rec.deleted) return null;
    return this.toServer(rec);
  }

  async createServer(input: CreateServerInput): Promise<ProvisionedServer> {
    if (this.liveServerCount() >= this.maxServers) {
      throw new ComputeFakeError(
        "no_capacity",
        `server capacity exhausted (maxServers=${this.maxServers})`,
      );
    }
    const id = this.allocId();
    const rec: ServerRecord = {
      id,
      name: input.name,
      createdTick: this.currentTick,
      activeAtTick: this.currentTick + this.serverActivateAfterTicks,
      createdIso: this.deterministicIso(),
      labels: { ...(input.labels ?? {}) },
      deleted: false,
    };
    this.servers.set(id, rec);
    // Returns BEFORE the server is ready: status is `new` until ticks advance.
    return { server: this.toServer(rec), rootPassword: null };
  }

  async deleteServer(id: number): Promise<void> {
    const rec = this.servers.get(id);
    // Idempotent: a missing or already-deleted server is a 404==success no-op.
    if (!rec || rec.deleted) return;
    rec.deleted = true;
    // Detach any volumes still pointing at this server.
    for (const vol of this.volumes.values()) {
      if (vol.server === id) vol.server = null;
    }
  }

  async powerOff(id: number): Promise<ComputeAction> {
    this.requireLiveServer(id, "powerOff");
    return this.emitAction("power_off");
  }

  async powerOn(id: number): Promise<ComputeAction> {
    this.requireLiveServer(id, "powerOn");
    return this.emitAction("power_on");
  }

  // ----------------------------------------------------------------------
  // Block storage
  // ----------------------------------------------------------------------

  async listVolumes(filter?: {
    label?: Record<string, string>;
    location?: string;
  }): Promise<ComputeVolume[]> {
    const out: ComputeVolume[] = [];
    for (const rec of this.volumes.values()) {
      if (rec.deleted) continue;
      if (filter?.label && !matchesLabels(rec.labels, filter.label)) continue;
      if (filter?.location && rec.location !== filter.location) continue;
      out.push(this.toVolume(rec));
    }
    return out;
  }

  async getVolume(id: number): Promise<ComputeVolume | null> {
    const rec = this.volumes.get(id);
    if (!rec || rec.deleted) return null;
    return this.toVolume(rec);
  }

  async createVolume(input: CreateVolumeInput): Promise<ComputeVolume> {
    if (this.liveVolumeCount() >= this.maxVolumes) {
      throw new ComputeFakeError(
        "no_capacity",
        `volume capacity exhausted (maxVolumes=${this.maxVolumes})`,
      );
    }
    const id = this.allocId();
    const rec: VolumeRecord = {
      id,
      name: input.name,
      size: input.sizeGb,
      location: input.location,
      createdTick: this.currentTick,
      availableAtTick: this.currentTick + this.volumeAvailableAfterTicks,
      server: input.serverId ?? null,
      labels: { ...(input.labels ?? {}) },
      deleted: false,
    };
    this.volumes.set(id, rec);
    return this.toVolume(rec);
  }

  async attachVolume(volumeId: number, serverId: number): Promise<ComputeAction> {
    const vol = this.requireLiveVolume(volumeId, "attachVolume");
    this.requireLiveServer(serverId, "attachVolume");
    vol.server = serverId;
    return this.emitAction("attach_volume");
  }

  async detachVolume(volumeId: number): Promise<ComputeAction> {
    const vol = this.requireLiveVolume(volumeId, "detachVolume");
    vol.server = null;
    return this.emitAction("detach_volume");
  }

  async deleteVolume(id: number): Promise<void> {
    const rec = this.volumes.get(id);
    // Idempotent, mirrors deleteServer's 404==success.
    if (!rec || rec.deleted) return;
    rec.deleted = true;
  }

  // ----------------------------------------------------------------------
  // The load-bearing async primitive
  // ----------------------------------------------------------------------

  /**
   * Resolve an action to terminal WITHOUT sleeping. A poisoned id resolves to
   * `errored` (and returns it; does not throw). An unknown action id throws
   * `ComputeFakeError("not_found")`.
   */
  async waitForAction(actionId: number, _timeoutMs?: number): Promise<ComputeAction> {
    const rec = this.actions.get(actionId);
    if (!rec) {
      throw new ComputeFakeError("not_found", `no such action ${actionId}`);
    }
    if (this.poisonedActionIds.has(actionId)) {
      rec.status = ACTION_STATUS_ERRORED;
      rec.error = { code: "action_failed", message: `action ${actionId} failed (poisoned)` };
    } else {
      rec.status = ACTION_STATUS_COMPLETED;
      rec.error = null;
    }
    return this.toAction(rec);
  }

  // ----------------------------------------------------------------------
  // Catalog (read-only, static)
  // ----------------------------------------------------------------------

  async listServerTypes(): Promise<ComputeServerType[]> {
    return [
      { id: 1, name: "s-1vcpu-1gb" },
      { id: 2, name: "s-2vcpu-2gb" },
      { id: 3, name: "s-4vcpu-8gb" },
    ];
  }

  async listLocations(): Promise<ComputeLocation[]> {
    return [
      { id: 1, name: "nyc1" },
      { id: 2, name: "ams3" },
      { id: 3, name: "sfo3" },
    ];
  }

  async listImages(filter?: {
    type?: string;
    architecture?: "x86" | "arm";
  }): Promise<ComputeImage[]> {
    const all: ComputeImage[] = [
      { id: 1, name: "ubuntu-24-04-x64" },
      { id: 2, name: "docker-24-04" },
    ];
    if (filter?.type === "snapshot") return [];
    return all;
  }

  // ----------------------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------------------

  private allocId(): number {
    return this.nextId++;
  }

  private emitAction(command: string): ComputeAction {
    const id = this.allocId();
    const rec: ActionRecord = {
      id,
      command,
      status: ACTION_STATUS_IN_PROGRESS,
      error: null,
    };
    this.actions.set(id, rec);
    return this.toAction(rec);
  }

  private liveServerCount(): number {
    let n = 0;
    for (const rec of this.servers.values()) if (!rec.deleted) n++;
    return n;
  }

  private liveVolumeCount(): number {
    let n = 0;
    for (const rec of this.volumes.values()) if (!rec.deleted) n++;
    return n;
  }

  private requireLiveServer(id: number, op: string): ServerRecord {
    const rec = this.servers.get(id);
    if (!rec || rec.deleted) {
      throw new ComputeFakeError("not_found", `${op}: no such server ${id}`);
    }
    return rec;
  }

  private requireLiveVolume(id: number, op: string): VolumeRecord {
    const rec = this.volumes.get(id);
    if (!rec || rec.deleted) {
      throw new ComputeFakeError("not_found", `${op}: no such volume ${id}`);
    }
    return rec;
  }

  private toServer(rec: ServerRecord): ComputeServer {
    return {
      id: rec.id,
      name: rec.name,
      status: this.currentTick >= rec.activeAtTick ? SERVER_STATUS_ACTIVE : SERVER_STATUS_NEW,
      created: rec.createdIso,
      labels: { ...rec.labels },
    };
  }

  private toVolume(rec: VolumeRecord): ComputeVolume {
    return {
      id: rec.id,
      name: rec.name,
      size: rec.size,
      server: rec.server,
      status:
        this.currentTick >= rec.availableAtTick ? VOLUME_STATUS_AVAILABLE : VOLUME_STATUS_CREATING,
      labels: { ...rec.labels },
    };
  }

  private toAction(rec: ActionRecord): ComputeAction {
    return {
      id: rec.id,
      command: rec.command,
      status: rec.status,
      error: rec.error,
    };
  }

  /**
   * A deterministic ISO timestamp derived from the tick counter, not the wall
   * clock — keeps `created` reproducible across runs.
   */
  private deterministicIso(): string {
    // Epoch + currentTick seconds, fixed base so output never depends on now().
    return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + this.currentTick * 1000).toISOString();
  }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

function matchesLabels(have: Record<string, string>, want: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(want)) {
    if (have[k] !== v) return false;
  }
  return true;
}
