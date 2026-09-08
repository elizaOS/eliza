/**
 * Publishes renderer app-slot records through a durable native pointer ledger.
 * SQLite contains only opaque references; immutable values remain in the OS
 * credential store. A child credential writer surviving its host can create an
 * orphan payload, but cannot overwrite a newer canonical value. All four slots
 * share one transaction, whose synchronous final guards precede pointer COMMIT.
 * This adapter requires explicit legacy migration and never falls back after it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ElizaError } from "@elizaos/core";
import type {
  PlatformSecureStore,
  SecureStoreSecretKind,
} from "./platform-secure-store";
import type {
  RendererSecureCommitBoundary,
  RendererSecureSerialization,
  RendererSecureSlot,
} from "./renderer-secure-store-transactions";

interface Statement {
  get(...params: string[]): unknown;
  run(...params: Array<string | null>): unknown;
}
interface Database {
  exec(sql: string): unknown;
  prepare(sql: string): Statement;
  close(): void;
}
interface Transaction {
  db: Database;
  vault: string;
  active: boolean;
  deadline: number;
  checks: Array<() => void>;
}
const slots: readonly RendererSecureSlot[] = [
  "session.device_auth",
  "session.steward_token",
  "runtime.active_server",
  "runtime.agent_profiles",
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// This is a permanent monotonic initialization tombstone, not a database UUID
// or cryptographic rollback detector. Every initializer writes identical bytes,
// including one whose native request survives its process or deadline.
const INITIALIZED = "eliza-renderer-ledger-initialized:v1";
const schema = `CREATE TABLE IF NOT EXISTS renderer_vaults (vault TEXT PRIMARY KEY NOT NULL, anchor TEXT NOT NULL, migration TEXT NOT NULL CHECK(migration IN ('prepared', 'ready')));
CREATE TABLE IF NOT EXISTS renderer_slots (vault TEXT NOT NULL, slot TEXT NOT NULL, payload TEXT, PRIMARY KEY (vault, slot));`;

function fail(code: string): ElizaError {
  return new ElizaError(
    "Native session storage is unavailable; retry or recover this installation's credential store.",
    { code, severity: "ephemeral" },
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function busy(error: unknown): boolean {
  return (
    object(error) &&
    (error.code === "SQLITE_BUSY" || error.errcode === 5 || error.errno === 5)
  );
}

async function openDatabase(path: string): Promise<Database> {
  if (process.versions.bun) {
    const { Database } = await import("bun:sqlite");
    return new Database(path);
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(path, { timeout: 0, allowExtension: false });
}

/** Use the same canonical state directory as deriveAgentVaultId, never a renderer-selected path. */
export class RendererSecureStoreLedger implements RendererSecureSerialization {
  private readonly path: string;
  private readonly context = new AsyncLocalStorage<Transaction>();

  constructor(
    stateDirectory: string,
    private readonly protectedStore: Pick<PlatformSecureStore, "get" | "set">,
    private readonly timeoutMs = 30_000,
  ) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 60_000
    )
      throw fail("NATIVE_LEDGER_INVALID_INPUT");
    // The dedicated directory inherits the host's canonical state root, while
    // its own permissions prevent another OS user from replacing the database.
    const directory = join(
      realpathSync(resolve(stateDirectory)),
      "renderer-native-authority",
    );
    mkdirSync(directory, { mode: 0o700, recursive: true });
    const metadata = lstatSync(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    )
      throw fail("NATIVE_LEDGER_UNSAFE_PATH");
    this.path = join(realpathSync(directory), "authority.sqlite");
    const fd = openSync(
      this.path,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (process.platform !== "win32" &&
          ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
      )
        throw fail("NATIVE_LEDGER_UNSAFE_PATH");
    } finally {
      closeSync(fd);
    }
  }

  private transaction(vault: string): Transaction {
    const transaction = this.context.getStore();
    if (!transaction?.active || transaction.vault !== vault)
      throw fail("NATIVE_LEDGER_OUTSIDE_TRANSACTION");
    if (performance.now() >= transaction.deadline)
      throw fail("NATIVE_LEDGER_TIMEOUT");
    return transaction;
  }

  private async native<T>(vault: string, work: () => Promise<T>): Promise<T> {
    const transaction = this.transaction(vault);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(fail("NATIVE_LEDGER_TIMEOUT")),
            Math.max(1, transaction.deadline - performance.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private anchorVault(vault: string): string {
    return `${vault}:renderer-ledger-anchor`;
  }
  private payloadVault(vault: string, payload: string): string {
    return `${vault}:renderer-payload:${payload}`;
  }

  private async transact<T>(
    vault: string,
    work: (boundary: RendererSecureCommitBoundary) => Promise<T>,
  ): Promise<T> {
    if (!vault || this.context.getStore()?.active)
      throw fail("NATIVE_LEDGER_INVALID_INPUT");
    const deadline = performance.now() + this.timeoutMs;
    const db = await openDatabase(this.path);
    let locked = false;
    try {
      db.exec("PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL;");
      while (!locked) {
        try {
          db.exec("BEGIN IMMEDIATE");
          locked = true;
        } catch (error) {
          // error-policy:J4 expected contention is bounded and yields to native callbacks.
          if (!busy(error)) throw error;
          if (performance.now() >= deadline)
            throw fail("NATIVE_LEDGER_TIMEOUT");
          await delay(10);
        }
      }
      db.exec(schema);
      const transaction: Transaction = {
        db,
        vault,
        deadline,
        active: true,
        checks: [],
      };
      try {
        const result = await this.context.run(transaction, () =>
          work({
            beforeCommit: (check) => {
              this.transaction(vault).checks.push(check);
            },
          }),
        );
        if (performance.now() >= deadline) throw fail("NATIVE_LEDGER_TIMEOUT");
        for (const check of transaction.checks) check();
        // No asynchronous work between final authority/lifetime checks and the
        // durable pointer commit. Late immutable native writes cannot publish.
        db.exec("COMMIT");
        locked = false;
        return result;
      } finally {
        transaction.active = false;
      }
    } finally {
      try {
        if (locked) db.exec("ROLLBACK");
      } finally {
        db.close();
      }
    }
  }

  /**
   * One explicit migration under the same native lock as all future access.
   * A missing ledger after an anchor was written is recovery-required, never
   * permission to resurrect a historical raw credential. No raw values deleted.
   */
  async migrateLegacy(vault: string): Promise<void> {
    await this.transact(vault, async () => {
      const { db } = this.transaction(vault);
      const row = db
        .prepare(
          "SELECT anchor, migration FROM renderer_vaults WHERE vault = ?",
        )
        .get(vault);
      if (object(row)) {
        if (
          row.anchor !== INITIALIZED ||
          (row.migration !== "prepared" && row.migration !== "ready")
        )
          throw fail("NATIVE_LEDGER_RECOVERY_REQUIRED");
        return;
      }
      const nativeAnchor = await this.native(vault, () =>
        this.protectedStore.get(this.anchorVault(vault), "session.device_auth"),
      );
      if (nativeAnchor.ok || nativeAnchor.reason !== "not_found")
        throw fail("NATIVE_LEDGER_RECOVERY_REQUIRED");
      for (const slot of slots) {
        const legacy = await this.native(vault, () =>
          this.protectedStore.get(vault, slot),
        );
        if (!legacy.ok && legacy.reason !== "not_found")
          throw fail("NATIVE_LEDGER_UNAVAILABLE");
        const payload = legacy.ok
          ? await this.stage(vault, slot, legacy.value)
          : null;
        db.prepare(
          "INSERT INTO renderer_slots (vault, slot, payload) VALUES (?, ?, ?)",
        ).run(vault, slot, payload);
      }
      // Commit the migration intent before dispatching its marker write. A
      // restarted initializer resumes these exact payloads, never stale raw data.
      db.prepare(
        "INSERT INTO renderer_vaults (vault, anchor, migration) VALUES (?, ?, 'prepared')",
      ).run(vault, INITIALIZED);
    });
    await this.transact(vault, async () => {
      const { db } = this.transaction(vault);
      const row = db
        .prepare(
          "SELECT anchor, migration FROM renderer_vaults WHERE vault = ?",
        )
        .get(vault);
      if (
        !object(row) ||
        row.anchor !== INITIALIZED ||
        (row.migration !== "prepared" && row.migration !== "ready")
      )
        throw fail("NATIVE_LEDGER_RECOVERY_REQUIRED");
      const marker = await this.native(vault, () =>
        this.protectedStore.get(this.anchorVault(vault), "session.device_auth"),
      );
      if (marker.ok && marker.value !== INITIALIZED)
        throw fail("NATIVE_LEDGER_RECOVERY_REQUIRED");
      if (!marker.ok) {
        if (marker.reason !== "not_found" || row.migration !== "prepared")
          throw fail("NATIVE_LEDGER_RECOVERY_REQUIRED");
        const written = await this.native(vault, () =>
          this.protectedStore.set(
            this.anchorVault(vault),
            "session.device_auth",
            INITIALIZED,
          ),
        );
        if (!written.ok) throw fail("NATIVE_LEDGER_UNAVAILABLE");
      }
      const verified = await this.native(vault, () =>
        this.protectedStore.get(this.anchorVault(vault), "session.device_auth"),
      );
      if (!verified.ok || verified.value !== INITIALIZED)
        throw fail("NATIVE_LEDGER_UNVERIFIED");
      db.prepare(
        "UPDATE renderer_vaults SET migration = 'ready' WHERE vault = ?",
      ).run(vault);
    });
  }

  run<T>(
    vault: string,
    work: (boundary: RendererSecureCommitBoundary) => Promise<T>,
  ): Promise<T> {
    return this.transact(vault, async (boundary) => {
      const { db } = this.transaction(vault);
      const row = db
        .prepare(
          "SELECT anchor, migration FROM renderer_vaults WHERE vault = ?",
        )
        .get(vault);
      if (
        !object(row) ||
        row.anchor !== INITIALIZED ||
        row.migration !== "ready"
      )
        throw fail("NATIVE_LEDGER_MIGRATION_REQUIRED");
      const anchor = await this.native(vault, () =>
        this.protectedStore.get(this.anchorVault(vault), "session.device_auth"),
      );
      if (!anchor.ok || anchor.value !== row.anchor)
        throw fail("NATIVE_LEDGER_RECOVERY_REQUIRED");
      return work(boundary);
    });
  }

  private pointer(vault: string, slot: SecureStoreSecretKind): string | null {
    if (!slots.includes(slot as RendererSecureSlot))
      throw fail("NATIVE_LEDGER_INVALID_INPUT");
    const { db } = this.transaction(vault);
    const row = db
      .prepare(
        "SELECT payload FROM renderer_slots WHERE vault = ? AND slot = ?",
      )
      .get(vault, slot);
    if (
      !object(row) ||
      (row.payload !== null &&
        (typeof row.payload !== "string" || !uuid.test(row.payload)))
    )
      throw fail("NATIVE_LEDGER_CORRUPT");
    return row.payload as string | null;
  }

  private async stage(
    vault: string,
    slot: SecureStoreSecretKind,
    value: string,
  ): Promise<string> {
    const payload = randomUUID();
    const id = this.payloadVault(vault, payload);
    const written = await this.native(vault, () =>
      this.protectedStore.set(id, slot, value),
    );
    if (!written.ok) throw fail("NATIVE_LEDGER_UNAVAILABLE");
    const verified = await this.native(vault, () =>
      this.protectedStore.get(id, slot),
    );
    if (!verified.ok || verified.value !== value)
      throw fail("NATIVE_LEDGER_UNVERIFIED");
    return payload;
  }

  readonly store: Pick<PlatformSecureStore, "get" | "set"> = {
    get: async (vault, slot) => {
      const payload = this.pointer(vault, slot);
      if (payload === null) return { ok: false, reason: "not_found" };
      const value = await this.native(vault, () =>
        this.protectedStore.get(this.payloadVault(vault, payload), slot),
      );
      if (!value.ok) throw fail("NATIVE_LEDGER_UNAVAILABLE");
      return value;
    },
    set: async (vault, slot, value) => {
      this.pointer(vault, slot);
      const payload = await this.stage(vault, slot, value);
      this.transaction(vault)
        .db.prepare(
          "UPDATE renderer_slots SET payload = ? WHERE vault = ? AND slot = ?",
        )
        .run(payload, vault, slot);
      return { ok: true };
    },
  };
}
