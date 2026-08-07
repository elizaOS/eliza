/**
 * In-memory state for the control-plane mock.
 *
 * Mirrors the real `agent_sandboxes` + `jobs` tables in `@elizaos/cloud-shared`
 * just enough for tests that exercise the cloud-api → control-plane integration.
 *
 * Status models match PR #7746 + cloud-shared schemas:
 *   sandbox.status: provisioning → running → stopped | error
 *                                ↳ deletion_pending → deleted | deletion_failed
 *   job.status:     pending → in_progress → completed | failed
 *   job.type:       agent_provision | agent_delete
 */

export type SandboxStatus =
  | "provisioning"
  | "running"
  | "stopped"
  | "error"
  | "deletion_pending"
  | "deleted"
  | "deletion_failed";

export interface Sandbox {
  id: string;
  organizationId: string;
  userId: string;
  agentId?: string;
  status: SandboxStatus;
  hetznerServerId: number | null;
  errorReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type JobStatus = "pending" | "in_progress" | "completed" | "failed";
export type JobType = "agent_provision" | "agent_delete";

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  sandboxId: string;
  organizationId: string;
  userId: string;
  payload: Record<string, unknown>;
  errorReason?: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

export type ContainerStatus =
  | "pending"
  | "running"
  | "restarting"
  | "deleting"
  | "deleted"
  | "error";

export interface Container {
  id: string;
  name: string;
  projectName: string;
  organizationId: string;
  userId: string;
  image: string;
  port: number;
  desiredCount: number;
  cpu: number;
  memoryMb: number;
  healthCheckPath: string;
  environmentVars: Record<string, string>;
  status: ContainerStatus;
  errorReason?: string;
  /** ms when the pending action completes (delete/restart) — used by tick. */
  pendingActionAt?: number;
  /** What the pending action will produce when it fires. */
  pendingAction?: "running" | "deleted";
  workspaceSyncs: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WarmSandbox {
  id: string;
  image: string;
  createdAt: Date;
}

export type WarmPoolRolloutState = "idle" | "in-progress" | "complete";

export interface WarmPoolState {
  enabled: boolean;
  minSize: number;
  maxSize: number;
  image: string;
  rolloutState: WarmPoolRolloutState;
  targetImage: string;
  completedSandboxes: number;
  totalSandboxes: number;
}

/** A single message imported into a dedicated agent's conversation. */
export interface ImportedMessage {
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
}

/**
 * Outcome of importing a transcript into a dedicated agent's conversation.
 * Byte-matches the real agent route's `POST /api/conversations/:id/import`:
 * `alreadyPopulated` is present (and `true`) only on the idempotent skip path.
 */
export interface ConversationImportResult {
  conversationId: string;
  inserted: number;
  skipped: number;
  alreadyPopulated?: boolean;
}

export class ControlPlaneStore {
  private readonly jobs = new Map<string, Job>();
  private readonly sandboxes = new Map<string, Sandbox>();
  private readonly containers = new Map<string, Container>();
  private readonly warmPool = new Map<string, WarmSandbox>();
  private readonly cronCounters = new Map<string, number>();
  /**
   * Per-(sandbox,conversation) message store backing the dedicated-agent
   * conversation import/read routes — the mock stand-in for a real container's
   * PGlite memories. Keyed `${sandboxId}::${conversationId}`.
   */
  private readonly conversations = new Map<string, ImportedMessage[]>();
  private hotPoolTarget = 0;
  private warmPoolState: WarmPoolState = {
    enabled: true,
    minSize: 0,
    maxSize: 10,
    image: "elizaos/agent:latest",
    rolloutState: "idle",
    targetImage: "elizaos/agent:latest",
    completedSandboxes: 0,
    totalSandboxes: 0,
  };
  private idSeq = 0;

  constructor(private readonly nowFn: () => Date = () => new Date()) {}

  // ── Cron counters ─────────────────────────────────────────────────────
  incrementCron(name: string): number {
    const next = (this.cronCounters.get(name) ?? 0) + 1;
    this.cronCounters.set(name, next);
    return next;
  }
  getCronCount(name: string): number {
    return this.cronCounters.get(name) ?? 0;
  }

  // ── Hot pool ──────────────────────────────────────────────────────────
  setHotPoolTarget(n: number): void {
    this.hotPoolTarget = Math.max(0, Math.floor(n));
  }
  getHotPoolTarget(): number {
    return this.hotPoolTarget;
  }
  warmPoolSnapshot(): WarmSandbox[] {
    return [...this.warmPool.values()];
  }
  /** Bring the warm pool up to `targetSize`, returning how many were added. */
  replenishWarmPool(image: string, targetSize: number): number {
    let added = 0;
    while (this.warmPool.size < targetSize) {
      const id = this.nextId("warm");
      this.warmPool.set(id, { id, image, createdAt: this.now() });
      added += 1;
    }
    return added;
  }

  // ── Warm-pool state ──────────────────────────────────────────────────
  getWarmPoolState(): WarmPoolState {
    return { ...this.warmPoolState };
  }
  setWarmPoolState(patch: Partial<WarmPoolState>): WarmPoolState {
    this.warmPoolState = { ...this.warmPoolState, ...patch };
    return { ...this.warmPoolState };
  }

  // ── Containers ────────────────────────────────────────────────────────
  createContainer(input: {
    name: string;
    projectName: string;
    organizationId: string;
    userId: string;
    image: string;
    port?: number;
    desiredCount?: number;
    cpu?: number;
    memoryMb?: number;
    healthCheckPath?: string;
    environmentVars?: Record<string, string>;
    actionMs: number;
  }): Container {
    const now = this.now();
    const container: Container = {
      id: this.nextId("ctr"),
      name: input.name,
      projectName: input.projectName,
      organizationId: input.organizationId,
      userId: input.userId,
      image: input.image,
      port: input.port ?? 3000,
      desiredCount: input.desiredCount ?? 1,
      cpu: input.cpu ?? 256,
      memoryMb: input.memoryMb ?? 512,
      healthCheckPath: input.healthCheckPath ?? "/health",
      environmentVars: input.environmentVars ?? {},
      status: "pending",
      pendingActionAt: now.getTime() + input.actionMs,
      pendingAction: "running",
      workspaceSyncs: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.containers.set(container.id, container);
    return container;
  }

  getContainer(id: string): Container | undefined {
    return this.containers.get(id);
  }

  updateContainer(id: string, patch: Partial<Container>): Container {
    const existing = this.containers.get(id);
    if (!existing) throw new Error(`container '${id}' not found`);
    const next: Container = {
      ...existing,
      ...patch,
      id,
      updatedAt: this.now(),
    };
    this.containers.set(id, next);
    return next;
  }

  removeContainer(id: string): void {
    this.containers.delete(id);
  }

  allContainers(): Container[] {
    return [...this.containers.values()];
  }

  /** Advance any containers whose pending action time has elapsed. */
  resolveContainerActions(): { resolved: number } {
    const now = this.now().getTime();
    let resolved = 0;
    for (const container of [...this.containers.values()]) {
      if (
        container.pendingActionAt !== undefined &&
        container.pendingAction !== undefined &&
        container.pendingActionAt <= now
      ) {
        const action = container.pendingAction;
        if (action === "deleted") {
          this.containers.delete(container.id);
        } else {
          this.updateContainer(container.id, {
            status: action,
            pendingActionAt: undefined,
            pendingAction: undefined,
          });
        }
        resolved += 1;
      }
    }
    return { resolved };
  }

  now(): Date {
    return this.nowFn();
  }

  private nextId(prefix: string): string {
    this.idSeq += 1;
    return `${prefix}-${this.idSeq.toString().padStart(6, "0")}`;
  }

  createSandbox(input: {
    organizationId: string;
    userId: string;
    agentId?: string;
  }): Sandbox {
    const now = this.now();
    const sandbox: Sandbox = {
      id: this.nextId("sbx"),
      organizationId: input.organizationId,
      userId: input.userId,
      agentId: input.agentId,
      status: "provisioning",
      hetznerServerId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  getSandbox(id: string): Sandbox | undefined {
    return this.sandboxes.get(id);
  }

  updateSandbox(id: string, patch: Partial<Sandbox>): Sandbox {
    const existing = this.sandboxes.get(id);
    if (!existing) throw new Error(`sandbox '${id}' not found`);
    const next: Sandbox = { ...existing, ...patch, id, updatedAt: this.now() };
    this.sandboxes.set(id, next);
    return next;
  }

  // ── Dedicated-agent conversation store (handoff import target) ─────────
  private convKey(sandboxId: string, conversationId: string): string {
    return `${sandboxId}::${conversationId}`;
  }

  /**
   * Silently bulk-insert a transcript into a dedicated agent's conversation —
   * the mock counterpart of the agent's `POST /api/conversations/:id/import`
   * (no inference). Idempotent per conversation: importing into an already
   * populated conversation inserts nothing and reports `alreadyPopulated`,
   * matching the real skip-all behaviour.
   */
  importConversation(
    sandboxId: string,
    conversationId: string,
    messages: ImportedMessage[],
  ): ConversationImportResult {
    const key = this.convKey(sandboxId, conversationId);
    const existing = this.conversations.get(key);
    if (existing && existing.length > 0) {
      return {
        conversationId,
        inserted: 0,
        skipped: messages.length,
        alreadyPopulated: true,
      };
    }
    this.conversations.set(key, [...messages]);
    return {
      conversationId,
      inserted: messages.length,
      skipped: 0,
    };
  }

  /** Read back a dedicated agent's imported conversation transcript. */
  getConversation(
    sandboxId: string,
    conversationId: string,
  ): ImportedMessage[] {
    return (
      this.conversations.get(this.convKey(sandboxId, conversationId)) ?? []
    );
  }

  /**
   * Read back an imported transcript by the cloud `agentId` rather than the
   * internal sandbox id (the import routes key on the sandbox id from the
   * advertised bridge_url; callers that only know the agent id use this).
   */
  getConversationByAgent(
    agentId: string,
    conversationId: string,
  ): ImportedMessage[] {
    const sandbox = [...this.sandboxes.values()].find(
      (s) => s.agentId === agentId,
    );
    if (!sandbox) return [];
    return this.getConversation(sandbox.id, conversationId);
  }

  createJob(input: {
    type: JobType;
    sandboxId: string;
    organizationId: string;
    userId: string;
    payload?: Record<string, unknown>;
  }): Job {
    const now = this.now();
    const job: Job = {
      id: this.nextId("job"),
      type: input.type,
      status: "pending",
      sandboxId: input.sandboxId,
      organizationId: input.organizationId,
      userId: input.userId,
      payload: input.payload ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  updateJob(id: string, patch: Partial<Job>): Job {
    const existing = this.jobs.get(id);
    if (!existing) throw new Error(`job '${id}' not found`);
    const next: Job = { ...existing, ...patch, id, updatedAt: this.now() };
    this.jobs.set(id, next);
    return next;
  }

  /** Pending jobs in FIFO order. */
  pendingJobs(): Job[] {
    return [...this.jobs.values()]
      .filter((j) => j.status === "pending")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /** Count of pending jobs (used to compute skipped after limit). */
  pendingJobCount(): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.status === "pending") n += 1;
    return n;
  }

  /** Sandboxes still in `provisioning` whose `createdAt` is older than the cutoff. */
  stuckProvisioningSandboxes(cutoff: Date): Sandbox[] {
    return [...this.sandboxes.values()].filter(
      (s) =>
        s.status === "provisioning" && s.createdAt.getTime() < cutoff.getTime(),
    );
  }

  allSandboxes(): Sandbox[] {
    return [...this.sandboxes.values()];
  }

  allJobs(): Job[] {
    return [...this.jobs.values()];
  }
}
