/** Exercises real SQLite pointer transactions with an injected credential backend; no user's keychain or database is accessed. */
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlatformSecureStore } from "./platform-secure-store";
import { RendererSecureStoreLedger } from "./renderer-secure-store-ledger";
import { RendererSecureStoreTransactions } from "./renderer-secure-store-transactions";

const vault = "isolated-ledger-fixture";
const slot = "runtime.active_server";
let directory: string;
let protectedValues: Map<string, string>;
let native: Pick<PlatformSecureStore, "get" | "set">;
let ledger: RendererSecureStoreLedger;
let a: RendererSecureStoreTransactions;
let b: RendererSecureStoreTransactions;
let now: number;
const address = (id: string, key: string) => JSON.stringify([id, key]);

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "eliza-native-ledger-test-"));
  protectedValues = new Map([[address(vault, slot), "legacy-target"]]);
  now = Date.parse("2026-09-08T00:00:00Z");
  native = {
    get: async (id, key) => {
      const value = protectedValues.get(address(id, key));
      return value === undefined
        ? { ok: false, reason: "not_found" }
        : { ok: true, value };
    },
    set: async (id, key, value) => {
      protectedValues.set(address(id, key), value);
      return { ok: true };
    },
  };
  ledger = new RendererSecureStoreLedger(directory, native);
  await ledger.migrateLegacy(vault);
  a = new RendererSecureStoreTransactions(ledger.store, ledger, () => now);
  const otherLedger = new RendererSecureStoreLedger(directory, native);
  b = new RendererSecureStoreTransactions(
    otherLedger.store,
    otherLedger,
    () => now,
  );
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("native immutable payload ledger", () => {
  it("keeps a newer migrated vault usable after an older initializer writes its marker late", async () => {
    const alternate = "late-migration-fixture";
    const first = new RendererSecureStoreLedger(directory, native, 40);
    const release = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    const set = native.set;
    let held = false;
    native.set = async (id, key, value) => {
      if (!held && id === `${alternate}:renderer-ledger-anchor`) {
        held = true;
        await release.promise;
        const result = await set(id, key, value);
        settled.resolve();
        return result;
      }
      return set(id, key, value);
    };
    await expect(first.migrateLegacy(alternate)).rejects.toMatchObject({
      code: "NATIVE_LEDGER_TIMEOUT",
    });
    await ledger.migrateLegacy(alternate);
    const winner = await a.write(alternate, slot, "newer-migration-winner");
    release.resolve();
    await settled.promise;
    expect(await b.read(alternate, slot)).toEqual(winner);
  });

  it("resumes a prepared migration after a lost marker reply without rereading raw credentials", async () => {
    const alternate = "migration-restart-fixture";
    protectedValues.set(address(alternate, slot), "captured-legacy");
    const set = native.set;
    native.set = async (id, key, value) => {
      const result = await set(id, key, value);
      if (id === `${alternate}:renderer-ledger-anchor`)
        throw new Error("Synthetic lost marker reply");
      return result;
    };
    await expect(ledger.migrateLegacy(alternate)).rejects.toThrow(
      "Synthetic lost marker reply",
    );
    native.set = set;
    protectedValues.set(address(alternate, slot), "changed-old-raw-value");
    const restarted = new RendererSecureStoreLedger(directory, native);
    await restarted.migrateLegacy(alternate);
    expect(
      (
        await new RendererSecureStoreTransactions(
          restarted.store,
          restarted,
        ).read(alternate, slot)
      ).value,
    ).toBe("captured-legacy");
  });

  it("migrates once and never reloads an old raw credential", async () => {
    expect((await a.read(vault, slot)).value).toBe("legacy-target");
    await a.write(vault, slot, "current-target");
    protectedValues.set(address(vault, slot), "late-old-raw-write");
    await ledger.migrateLegacy(vault);
    expect((await b.read(vault, slot)).value).toBe("current-target");
    const bytes = readFileSync(
      join(directory, "renderer-native-authority", "authority.sqlite"),
    );
    expect(bytes.includes(Buffer.from("current-target"))).toBe(false);
    expect(bytes.includes(Buffer.from("legacy-target"))).toBe(false);
    expect(
      statSync(join(directory, "renderer-native-authority", "authority.sqlite"))
        .mode & 0o077,
    ).toBe(0);
  });

  it("serializes independent host owners and preserves the newer acknowledged target", async () => {
    const expected = await a.read(vault, slot);
    const receipt = await a.prepare(
      vault,
      slot,
      expected,
      "old-proposal",
      randomUUID(),
    );
    const winner = await b.write(vault, slot, "newer-target");
    await expect(a.rollback(vault, slot, receipt)).rejects.toMatchObject({
      code: "NATIVE_STORE_SUPERSEDED",
    });
    expect(await a.read(vault, slot)).toEqual(winner);
  });

  it("rolls back pointer publication when native persistence outlasts the proposal", async () => {
    const receipt = await a.prepare(
      vault,
      slot,
      await a.read(vault, slot),
      "expired-target",
      randomUUID(),
    );
    await a.commit(vault, slot, receipt);
    const set = native.set;
    native.set = async (id, key, value) => {
      const result = await set(id, key, value);
      if (value.includes('"state":"sealed"')) now += 60_001;
      return result;
    };
    await expect(a.seal(vault, slot, receipt)).rejects.toMatchObject({
      code: "NATIVE_STORE_SUPERSEDED",
    });
    expect((await b.read(vault, slot)).value).toBe("legacy-target");
    // A protected orphan is not authoritative merely because its native write completed.
    expect(
      [...protectedValues.values()].some((value) =>
        value.includes('"state":"sealed"'),
      ),
    ).toBe(true);
  });

  it("retains canonical pointers after a failed transaction and native reconstruction", async () => {
    const before = await a.read(vault, slot);
    await expect(
      ledger.run(vault, async (boundary) => {
        await ledger.store.set(vault, slot, "unpublished-secret");
        boundary.beforeCommit(() => {
          throw new Error("Synthetic final refusal");
        });
      }),
    ).rejects.toThrow("Synthetic final refusal");
    expect(await b.read(vault, slot)).toEqual(before);
  });

  it("does not resurrect raw data if the initialized ledger is lost", async () => {
    await a.write(vault, slot, null);
    unlinkSync(
      join(directory, "renderer-native-authority", "authority.sqlite"),
    );
    const restarted = new RendererSecureStoreLedger(directory, native);
    await expect(restarted.migrateLegacy(vault)).rejects.toMatchObject({
      code: "NATIVE_LEDGER_RECOVERY_REQUIRED",
    });
    const reader = new RendererSecureStoreTransactions(
      restarted.store,
      restarted,
    );
    await expect(reader.read(vault, slot)).rejects.toMatchObject({
      code: "NATIVE_LEDGER_MIGRATION_REQUIRED",
    });
  });

  it("requires the transaction context and rejects cross-vault raw calls", async () => {
    await expect(ledger.store.get(vault, slot)).rejects.toMatchObject({
      code: "NATIVE_LEDGER_OUTSIDE_TRANSACTION",
    });
    await expect(
      ledger.run(vault, () => ledger.store.get("another-vault", slot)),
    ).rejects.toMatchObject({ code: "NATIVE_LEDGER_OUTSIDE_TRANSACTION" });
  });

  it("bounds waiting for another owner without blocking its native callback", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holding = ledger.run(vault, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const contender = new RendererSecureStoreLedger(directory, native, 40);
    try {
      await expect(
        contender.run(vault, async () => undefined),
      ).rejects.toMatchObject({ code: "NATIVE_LEDGER_TIMEOUT" });
    } finally {
      release.resolve();
      await holding;
    }
    expect((await b.read(vault, slot)).value).toBe("legacy-target");
  });

  it("keeps a late timed-out native writer orphaned after a new winner publishes", async () => {
    const shortLedger = new RendererSecureStoreLedger(directory, native, 40);
    const writer = new RendererSecureStoreTransactions(
      shortLedger.store,
      shortLedger,
      () => now,
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    const set = native.set;
    let first = true;
    native.set = async (id, key, value) => {
      if (first && id.includes(":renderer-payload:")) {
        first = false;
        entered.resolve();
        await release.promise;
        const result = await set(id, key, value);
        settled.resolve();
        return result;
      }
      return set(id, key, value);
    };
    const rejected = expect(
      writer.write(vault, slot, "late-orphan"),
    ).rejects.toMatchObject({ code: "NATIVE_LEDGER_TIMEOUT" });
    await entered.promise;
    await rejected;
    const winner = await b.write(vault, slot, "newer-target");
    release.resolve();
    await settled.promise;
    expect(await a.read(vault, slot)).toEqual(winner);
  });
});
