import { homedir } from "node:os";
import { join } from "node:path";
import { decrypt, encrypt } from "./crypto/envelope.js";
import {
  type MasterKeyResolver,
  osKeyringMasterKey,
} from "./crypto/master-key.js";
import { EnvLegacyBackend } from "./backends/env-legacy.js";
import { KeyringBackend } from "./backends/keyring.js";
import {
  BackendError,
  BackendNotConfiguredError,
  type VaultBackend,
} from "./backends/types.js";
import { assertSecretId } from "./identifiers.js";
import { AuditLog } from "./policy/audit.js";
import { decide, PermissionDeniedError } from "./policy/grants.js";
import { parseReference } from "./references.js";
import { lookupSchema } from "./secret-schema.js";
import type { ScopedConfidant } from "./scoped.js";
import {
  emptyStore,
  readStore,
  removeSecret,
  setSecret,
  type StoreData,
  type StoreEntry,
  writeStore,
} from "./store.js";
import type {
  ConfidantLogger,
  PromptHandler,
  ResolveDetail,
  SecretDescriptor,
  SecretId,
  VaultReference,
  VaultSource,
} from "./types.js";

export interface ConfidantOptions {
  /** Path to the local store. Default: `~/.milady/confidant.json`. */
  readonly storePath?: string;
  /** Path to the audit log. Default: `~/.milady/audit/confidant.jsonl`. */
  readonly auditLogPath?: string;
  /** Master key resolver. Default: macOS keychain on darwin, else throws. */
  readonly masterKey?: MasterKeyResolver;
  /** Override or extend the registered backends. Default: keyring + env-legacy. */
  readonly backends?: readonly VaultBackend[];
  /** Optional handler invoked when a `prompt`-mode grant fires. */
  readonly promptHandler?: PromptHandler;
  /** Logger for non-fatal warnings (audit failures, etc.). Default: silent. */
  readonly logger?: ConfidantLogger;
}

export interface Confidant {
  resolve(id: SecretId): Promise<string>;
  lazyResolve(id: SecretId): () => Promise<string>;
  resolveDetailed(id: SecretId): Promise<ResolveDetail>;
  set(id: SecretId, value: string): Promise<void>;
  setReference(id: SecretId, ref: VaultReference): Promise<void>;
  has(id: SecretId): Promise<boolean>;
  remove(id: SecretId): Promise<void>;
  list(prefix?: string): Promise<readonly SecretId[]>;
  describe(id: SecretId): Promise<SecretDescriptor | null>;
  scopeFor(skillId: string): ScopedConfidant;
}

export function createConfidant(opts: ConfidantOptions = {}): Confidant {
  const root = process.env.MILADY_STATE_DIR
    ? process.env.MILADY_STATE_DIR
    : process.env.ELIZA_STATE_DIR
      ? process.env.ELIZA_STATE_DIR
      : join(homedir(), ".milady");
  const storePath = opts.storePath ?? join(root, "confidant.json");
  const auditPath = opts.auditLogPath ?? join(root, "audit", "confidant.jsonl");
  const masterKeyResolver =
    opts.masterKey ??
    osKeyringMasterKey({
      service: "elizaos",
      account: "confidant.masterKey",
    });
  const backends = new Map<VaultSource, VaultBackend>();
  for (const backend of opts.backends ?? defaultBackends()) {
    backends.set(backend.source, backend);
  }
  return new ConfidantImpl({
    storePath,
    auditPath,
    masterKeyResolver,
    backends,
    ...(opts.promptHandler ? { promptHandler: opts.promptHandler } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
}

function defaultBackends(): readonly VaultBackend[] {
  return [new KeyringBackend(), new EnvLegacyBackend()];
}

interface ConfidantImplDeps {
  readonly storePath: string;
  readonly auditPath: string;
  readonly masterKeyResolver: MasterKeyResolver;
  readonly backends: ReadonlyMap<VaultSource, VaultBackend>;
  readonly promptHandler?: PromptHandler;
  readonly logger?: ConfidantLogger;
}

class ConfidantImpl implements Confidant {
  private storeData: StoreData | null = null;
  private storeMutex: Promise<void> = Promise.resolve();
  private masterKey: Buffer | null = null;
  private readonly audit: AuditLog;
  /** Skill ids whose `prompt` decisions have been approved this session. */
  private readonly promptApprovals = new Map<string, Set<string>>();

  constructor(private readonly deps: ConfidantImplDeps) {
    this.audit = new AuditLog(deps.auditPath, deps.logger);
  }

  async resolve(id: SecretId): Promise<string> {
    const detail = await this.resolveInternal({ id, skillId: null });
    return detail.value;
  }

  lazyResolve(id: SecretId): () => Promise<string> {
    return () => this.resolve(id);
  }

  async resolveDetailed(id: SecretId): Promise<ResolveDetail> {
    return this.resolveInternal({ id, skillId: null });
  }

  async has(id: SecretId): Promise<boolean> {
    assertSecretId(id);
    const store = await this.loadStore();
    return id in store.secrets;
  }

  async list(prefix?: string): Promise<readonly SecretId[]> {
    const store = await this.loadStore();
    const ids = Object.keys(store.secrets) as SecretId[];
    if (!prefix) return ids;
    return ids.filter((id) => id === prefix || id.startsWith(`${prefix}.`));
  }

  async describe(id: SecretId): Promise<SecretDescriptor | null> {
    assertSecretId(id);
    const store = await this.loadStore();
    const entry = store.secrets[id];
    if (!entry) return null;
    const schema = lookupSchema(id);
    return {
      id,
      source: entry.source,
      isReference: entry.kind === "reference",
      lastModified: entry.lastModified,
      ...(schema ? { schema } : {}),
    };
  }

  async set(id: SecretId, value: string): Promise<void> {
    assertSecretId(id);
    if (typeof value !== "string") {
      throw new TypeError("Confidant.set: value must be a string");
    }
    const key = await this.loadMasterKey();
    const envelope = encrypt(key, value, id);
    await this.mutateStore((store) =>
      setSecret(store, id, {
        kind: "literal",
        source: "file",
        ciphertext: envelope.ciphertext,
        lastModified: Date.now(),
      }),
    );
  }

  async setReference(id: SecretId, ref: VaultReference): Promise<void> {
    assertSecretId(id);
    const parsed = parseReference(ref);
    if (parsed.source === "file") {
      throw new TypeError(
        "setReference does not accept file:// references. Use set() to store a literal value.",
      );
    }
    if (!this.deps.backends.has(parsed.source)) {
      throw new BackendNotConfiguredError(
        parsed.source,
        `cannot set reference for unconfigured backend ${parsed.source}`,
      );
    }
    await this.mutateStore((store) => {
      const entry: StoreEntry = {
        kind: "reference",
        source: parsed.source as Exclude<VaultSource, "file">,
        ref: parsed.raw,
        lastModified: Date.now(),
      };
      return setSecret(store, id, entry);
    });
  }

  async remove(id: SecretId): Promise<void> {
    assertSecretId(id);
    await this.mutateStore((store) => removeSecret(store, id));
  }

  scopeFor(skillId: string): ScopedConfidant {
    if (!skillId || typeof skillId !== "string") {
      throw new TypeError("scopeFor: skillId must be a non-empty string");
    }
    const self = this;
    return {
      resolve: async (id) =>
        (await self.resolveInternal({ id, skillId })).value,
      lazyResolve: (id) => () =>
        self.resolveInternal({ id, skillId }).then((d) => d.value),
      has: async (id) => self.has(id),
    };
  }

  // ── internals ───────────────────────────────────────────────────────

  private async resolveInternal(input: {
    id: SecretId;
    skillId: string | null;
  }): Promise<ResolveDetail> {
    assertSecretId(input.id);
    const store = await this.loadStore();
    const entry = store.secrets[input.id];

    if (input.skillId !== null) {
      const grants = store.permissions[input.skillId]?.grants ?? [];
      const decision = decide({
        skillId: input.skillId,
        secretId: input.id,
        grants,
      });
      let promptedUser = false;
      if (decision.kind === "deny") {
        await this.audit.record({
          skill: input.skillId,
          secret: input.id,
          granted: false,
          reason: decision.reason,
        });
        throw new PermissionDeniedError(
          input.skillId,
          input.id,
          decision.reason,
        );
      }
      if (decision.kind === "prompt") {
        const approvedThisSession = this.promptApprovals
          .get(input.skillId)
          ?.has(input.id);
        if (!approvedThisSession) {
          if (!this.deps.promptHandler) {
            await this.audit.record({
              skill: input.skillId,
              secret: input.id,
              granted: false,
              reason: "prompt-mode grant but no PromptHandler configured",
            });
            throw new PermissionDeniedError(
              input.skillId,
              input.id,
              "prompt-mode grant but no PromptHandler configured",
            );
          }
          const approved = await this.deps.promptHandler.promptForGrant({
            skillId: input.skillId,
            secretId: input.id,
          });
          promptedUser = true;
          if (!approved) {
            await this.audit.record({
              skill: input.skillId,
              secret: input.id,
              granted: false,
              reason: "user denied prompt",
            });
            throw new PermissionDeniedError(
              input.skillId,
              input.id,
              "user denied prompt",
            );
          }
          let set = this.promptApprovals.get(input.skillId);
          if (!set) {
            set = new Set();
            this.promptApprovals.set(input.skillId, set);
          }
          set.add(input.id);
        }
      }
      // resolve and audit
      const value = await this.materialize(input.id, entry);
      await this.audit.record({
        skill: input.skillId,
        secret: input.id,
        granted: true,
        ...(entry ? { source: entry.source } : {}),
        cached: false,
      });
      return {
        value,
        source: entry?.source ?? "file",
        cached: false,
        promptedUser,
      };
    }

    // Unscoped: no policy enforcement; audit-as-internal.
    const value = await this.materialize(input.id, entry);
    return {
      value,
      source: entry?.source ?? "file",
      cached: false,
      promptedUser: false,
    };
  }

  private async materialize(
    id: SecretId,
    entry: StoreEntry | undefined,
  ): Promise<string> {
    if (!entry) {
      throw new BackendError(
        "file",
        `no entry for ${id} (call set() or setReference() first)`,
      );
    }
    if (entry.kind === "literal") {
      const key = await this.loadMasterKey();
      return decrypt(key, entry.ciphertext, id);
    }
    const backend = this.deps.backends.get(entry.source);
    if (!backend) {
      throw new BackendNotConfiguredError(
        entry.source,
        `no backend registered for source "${entry.source}" (id ${id})`,
      );
    }
    return backend.resolve(entry.ref);
  }

  private async loadStore(): Promise<StoreData> {
    if (this.storeData) return this.storeData;
    this.storeData = await readStore(this.deps.storePath);
    return this.storeData;
  }

  private async mutateStore(
    mutator: (store: StoreData) => StoreData,
  ): Promise<void> {
    // Serialize concurrent mutations within this process. (Cross-process
    // safety would require a file lock; out of scope for phase 0.)
    const previous = this.storeMutex;
    let release!: () => void;
    this.storeMutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      const current = await this.loadStore();
      const next = mutator(current);
      await writeStore(this.deps.storePath, next);
      this.storeData = next;
    } finally {
      release();
    }
  }

  private async loadMasterKey(): Promise<Buffer> {
    if (this.masterKey) return this.masterKey;
    this.masterKey = await this.deps.masterKeyResolver.load();
    return this.masterKey;
  }
}
