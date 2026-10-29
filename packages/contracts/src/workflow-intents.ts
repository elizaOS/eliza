/**
 * Durable record of workflow requests the owner started but whose receipt the
 * host has not yet confirmed (a Save, Run, approval decision or lifecycle
 * change sent just before the app closed). A pending intent locks its action so
 * it is never sent twice; it is acknowledged only with the exact revision it
 * was admitted with.
 *
 * Intents are nonsecret and scoped to one captured agent account: every key
 * carries `[origin, ownerId, agentId, id]`, and a store refuses keys for any
 * other owner. Persistence is host-provided (`WorkflowIntentBackend`), so a
 * browser host can use a document store and a phone its installed slots. The
 * key prefix is a host parameter so installed data keeps its identifiers.
 */

export interface WorkflowIntentOwner {
  origin: string;
  ownerId: string;
  agentId: string;
}
export interface WorkflowIntentArchive {
  entries: Record<string, string>;
}
/** Host persistence. `edit` must apply `update` atomically to the stored archive. */
export interface WorkflowIntentBackend {
  read(signal?: AbortSignal): Promise<WorkflowIntentArchive>;
  edit(
    update: (archive: WorkflowIntentArchive) => void,
    signal?: AbortSignal,
  ): Promise<void>;
}
export interface WorkflowIntentStoreOptions {
  /** Installed key namespace, e.g. `"eliza.workflow.pending.v1:"`. */
  keyPrefix?: string;
  backend: WorkflowIntentBackend;
  /** Called after every committed change (to notify other views and windows). */
  onChange?: () => void;
}

export const DEFAULT_WORKFLOW_INTENT_PREFIX = "eliza.workflow.pending.v1:";

export class WorkflowIntentConflict extends Error {
  override name = "WorkflowIntentConflict";
  constructor() {
    super("Workflow request changed. Refresh its receipt before trying again.");
  }
}

export function workflowIntentKey(
  owner: WorkflowIntentOwner,
  id: string,
  keyPrefix = DEFAULT_WORKFLOW_INTENT_PREFIX,
): string {
  return (
    keyPrefix + JSON.stringify([owner.origin, owner.ownerId, owner.agentId, id])
  );
}
/** Key namespace of one owner: every key of theirs starts with it. */
export function workflowIntentOwnerPrefix(
  owner: WorkflowIntentOwner,
  keyPrefix = DEFAULT_WORKFLOW_INTENT_PREFIX,
): string {
  return (
    keyPrefix +
    JSON.stringify([owner.origin, owner.ownerId, owner.agentId]).slice(0, -1) +
    ","
  );
}

export const emptyWorkflowIntentArchive = (): WorkflowIntentArchive => ({
  entries: {},
});

/** Nonsecret pending requests, scoped to the captured agent account. */
export class WorkflowIntentStore {
  readonly keyPrefix: string;
  readonly ownerPrefix: string;
  private readonly backend: WorkflowIntentBackend;
  private readonly onChange?: () => void;
  private epoch = 0;
  private cached: Record<string, string> | null = null;
  constructor(owner: WorkflowIntentOwner, options: WorkflowIntentStoreOptions) {
    this.keyPrefix = options.keyPrefix ?? DEFAULT_WORKFLOW_INTENT_PREFIX;
    this.ownerPrefix = workflowIntentOwnerPrefix(owner, this.keyPrefix);
    this.backend = options.backend;
    this.onChange = options.onChange;
  }
  key(owner: WorkflowIntentOwner, id: string): string {
    const key = workflowIntentKey(owner, id, this.keyPrefix);
    this.check(key);
    return key;
  }
  private check(key: string) {
    if (!key.startsWith(this.ownerPrefix))
      throw new Error("Workflow intent belongs to another agent");
  }
  private validate(value: WorkflowIntentArchive): WorkflowIntentArchive {
    if (
      !value ||
      typeof value !== "object" ||
      !value.entries ||
      typeof value.entries !== "object" ||
      Array.isArray(value.entries) ||
      Object.keys(value).some((key) => key !== "entries")
    )
      throw new Error("Workflow request history needs recovery");
    for (const [key, raw] of Object.entries(value.entries)) {
      this.check(key);
      if (typeof raw !== "string")
        throw new Error("Workflow request history needs recovery");
    }
    return value;
  }
  invalidate() {
    this.epoch++;
    this.cached = null;
  }
  /** True while no committed snapshot is held, when every key reads as locked. */
  get stale() {
    return this.cached === null;
  }
  /** A key is locked while it is pending, or while the store has no snapshot. */
  locked(key: string) {
    this.check(key);
    return this.cached === null || Object.hasOwn(this.cached, key);
  }
  /** Workflow IDs with a pending lifecycle change (`<id>:lifecycle` keys). */
  pendingLifecycle(): string[] {
    const suffix = ":lifecycle";
    return Object.keys(this.cached ?? {})
      .filter((key) => key.endsWith(suffix))
      .flatMap((key) => {
        try {
          const parts = JSON.parse(
            key.slice(this.keyPrefix.length, -suffix.length),
          );
          return Array.isArray(parts) &&
            parts.length === 4 &&
            typeof parts[3] === "string"
            ? [parts[3] as string]
            : [];
        } catch {
          return [];
        }
      });
  }
  async load(signal?: AbortSignal): Promise<Record<string, string>> {
    const epoch = ++this.epoch;
    signal?.throwIfAborted();
    const value = await this.backend.read(signal);
    signal?.throwIfAborted();
    const entries = { ...this.validate(value).entries };
    if (epoch === this.epoch) this.cached = entries;
    return entries;
  }
  async read(key: string, signal?: AbortSignal): Promise<string | null> {
    this.check(key);
    return (await this.load(signal))[key] ?? null;
  }
  private async replace(
    key: string,
    expected: string | null,
    next: string | null,
    signal?: AbortSignal,
  ) {
    this.check(key);
    signal?.throwIfAborted();
    const result: { committed: Record<string, string> | null } = {
      committed: null,
    };
    try {
      await this.backend.edit((value) => {
        result.committed = null;
        const entries = this.validate(value).entries;
        if ((entries[key] ?? null) !== expected)
          throw new WorkflowIntentConflict();
        if (next === null) delete entries[key];
        else entries[key] = next;
        result.committed = { ...entries };
      }, signal);
    } catch (error) {
      this.invalidate();
      throw error;
    }
    const committed = result.committed;
    if (!committed) {
      this.invalidate();
      throw new Error("Workflow intent save unconfirmed");
    }
    // The snapshot this write committed is the current state; dropping it would
    // leave every key reading as locked until the next reload.
    this.epoch++;
    this.cached = committed;
    this.onChange?.();
  }
  /** Records a new pending intent; refuses when one is already pending for the key. */
  async admit(
    key: string,
    intent: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const raw = JSON.stringify({
      ...intent,
      intentRevision: globalThis.crypto.randomUUID(),
    });
    await this.replace(key, null, raw, signal);
    return raw;
  }
  /** Clears an intent only when it is still exactly the admitted revision. */
  async acknowledge(key: string, expected: string, signal?: AbortSignal) {
    await this.replace(key, expected, null, signal);
  }
}

/**
 * Backend over a `Storage` (localStorage) holding one entry per key, for hosts
 * whose installed intents live in per-key slots. Reads and writes are
 * synchronous, so each edit is atomic within one window.
 */
export function storageWorkflowIntentBackend(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key"> & {
    readonly length: number;
  },
  ownerPrefix: string,
): WorkflowIntentBackend {
  const snapshot = (): WorkflowIntentArchive => {
    const entries: Record<string, string> = {};
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(ownerPrefix)) keys.push(key);
    }
    for (const key of keys.sort()) {
      const raw = storage.getItem(key);
      if (raw !== null) entries[key] = raw;
    }
    return { entries };
  };
  return {
    async read() {
      return snapshot();
    },
    async edit(update) {
      const before = snapshot();
      const after: WorkflowIntentArchive = { entries: { ...before.entries } };
      update(after);
      for (const key of Object.keys(before.entries))
        if (!Object.hasOwn(after.entries, key)) storage.removeItem(key);
      for (const [key, raw] of Object.entries(after.entries))
        if (before.entries[key] !== raw) storage.setItem(key, raw);
      for (const [key, raw] of Object.entries(after.entries))
        if (storage.getItem(key) !== raw)
          throw new Error("Workflow intent save unconfirmed");
    },
  };
}
