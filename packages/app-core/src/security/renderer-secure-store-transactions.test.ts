/** Exercises native transaction ownership, crash records and two host clients against an injected protected-store boundary; not OS/device acceptance. */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  PlatformSecureStore,
  SecureStoreSecretKind,
} from "./platform-secure-store";
import {
  type RendererSecureCommitBoundary,
  type RendererSecureSerialization,
  RendererSecureStoreTransactions,
} from "./renderer-secure-store-transactions";

const vault = "isolated-native-fixture";
const slot = "runtime.active_server";
let raw: Map<string, string>;
let time: number;
let writes: number;
let failure: "none" | "reject" | "drop" | "lost-reply";
let backend: Pick<PlatformSecureStore, "get" | "set">;
let serialization: RendererSecureSerialization;
let a: RendererSecureStoreTransactions;
let b: RendererSecureStoreTransactions;
const address = (id: string, kind: SecureStoreSecretKind) =>
  JSON.stringify([id, kind]);

beforeEach(() => {
  raw = new Map();
  time = Date.parse("2026-09-08T00:00:00Z");
  writes = 0;
  failure = "none";
  backend = {
    get: async (id, kind) => {
      const value = raw.get(address(id, kind));
      return value === undefined
        ? { ok: false, reason: "not_found" }
        : { ok: true, value };
    },
    set: async (id, kind, value) => {
      writes++;
      if (failure === "reject") return { ok: false, reason: "denied" };
      if (failure !== "drop") raw.set(address(id, kind), value);
      if (failure === "lost-reply")
        throw new Error("Synthetic native reply lost");
      return { ok: true };
    },
  };
  // Models the host serialization port, shared by independent RPC clients.
  // Platform/process locking itself requires separate native adapter tests.
  const queues = new Map<string, Promise<void>>();
  const cancellations = new Set<string>();
  serialization = {
    async run<T>(
      id: string,
      work: (boundary: RendererSecureCommitBoundary) => Promise<T>,
    ) {
      const key = id;
      const predecessor = queues.get(key) ?? Promise.resolve();
      const release = Promise.withResolvers<void>();
      queues.set(key, release.promise);
      await predecessor;
      try {
        const checks: Array<() => void> = [];
        const result = await work({
          beforeCommit: (check) => checks.push(check),
          isCancelled: (slot, operationId) =>
            cancellations.has(JSON.stringify([id, slot, operationId])),
          cancelOperation: (slot, operationId) => {
            cancellations.add(JSON.stringify([id, slot, operationId]));
          },
        });
        for (const check of checks) check();
        return result;
      } finally {
        release.resolve();
      }
    },
  };
  a = new RendererSecureStoreTransactions(backend, serialization, () => time);
  b = new RendererSecureStoreTransactions(backend, serialization, () => time);
});

describe("native app-slot conditional ownership", () => {
  it.each([60_001, -10_000])(
    "refuses seal when its lifetime expires during peer reads (%s)",
    async (elapsed) => {
      const expected = await a.write(vault, slot, "original");
      const receipt = await a.prepare(
        vault,
        slot,
        expected,
        "expired-candidate",
        randomUUID(),
      );
      await a.commit(vault, slot, receipt);
      const get = backend.get;
      let advanced = false;
      backend.get = async (id, key) => {
        const result = await get(id, key);
        if (!advanced && key === "session.steward_token") {
          advanced = true;
          time += elapsed;
        }
        return result;
      };
      const before = writes;
      await expect(a.seal(vault, slot, receipt)).rejects.toMatchObject({
        code: "NATIVE_STORE_SUPERSEDED",
      });
      expect(writes).toBe(before);
      expect((await b.read(vault, slot)).value).toBe("original");
    },
  );

  it("keeps the vault lock through the final native read and publication acknowledgement", async () => {
    const expected = await a.write(vault, slot, "original");
    const receipt = await a.prepare(
      vault,
      slot,
      expected,
      "selected",
      randomUUID(),
    );
    await a.commit(vault, slot, receipt);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const get = backend.get;
    let held = false;
    backend.get = async (id, key) => {
      const result = await get(id, key);
      if (!held && id === vault && key === "session.steward_token") {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    const publication = a.seal(vault, slot, receipt);
    await entered.promise;
    const before = writes;
    const superseding = b.write(vault, "session.steward_token", "new-account");
    await Promise.resolve();
    expect(writes).toBe(before);
    release.resolve();
    expect((await publication).value).toBe("selected");
    await superseding;
    expect((await b.read(vault, "session.steward_token")).value).toBe(
      "new-account",
    );
  });

  it("gates other app slots while a proposal is pending but permits an explicit newer writer", async () => {
    const expected = await a.write(vault, slot, "original");
    const receipt = await a.prepare(
      vault,
      slot,
      expected,
      "proposal",
      randomUUID(),
    );
    await expect(b.read(vault, "session.steward_token")).rejects.toMatchObject({
      code: "NATIVE_STORE_PENDING",
    });
    await b.write(vault, "session.steward_token", "new-account");
    await a.commit(vault, slot, receipt);
    await expect(a.seal(vault, slot, receipt)).rejects.toMatchObject({
      code: "NATIVE_STORE_SUPERSEDED",
    });
    await a.rollback(vault, slot, receipt);
    expect((await b.read(vault, "session.steward_token")).value).toBe(
      "new-account",
    );
  });

  it("does not let another vault invalidate the captured account", async () => {
    const expected = await a.write(vault, slot, "original");
    const receipt = await a.prepare(
      vault,
      slot,
      expected,
      "selected",
      randomUUID(),
    );
    await b.write(
      "separate-runtime-vault",
      "session.steward_token",
      "other-account",
    );
    await a.commit(vault, slot, receipt);
    expect((await a.seal(vault, slot, receipt)).value).toBe("selected");
  });

  it("keeps captured authority immutable while waiting for the native host", async () => {
    const expected = await a.write(vault, slot, "original");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holding = serialization.run(vault, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const preparation = a.prepare(
      vault,
      slot,
      expected,
      "selected",
      randomUUID(),
    );
    expected.authority["session.steward_token"] = "0".repeat(64);
    expected.value = "changed-caller-object";
    release.resolve();
    await holding;
    const receipt = await preparation;
    await a.commit(vault, slot, receipt);
    expect((await a.seal(vault, slot, receipt)).value).toBe("selected");
  });

  it.each([
    "session.device_auth",
    "session.steward_token",
    "runtime.agent_profiles",
  ] as const)(
    "rejects publication after another context changes %s",
    async (peer) => {
      await a.write(vault, peer, "account-A");
      const expected = await a.write(vault, slot, "original-target");
      const receipt = await a.prepare(
        vault,
        slot,
        expected,
        "stale-target",
        randomUUID(),
      );
      await a.commit(vault, slot, receipt);
      await b.write(vault, peer, "account-B");
      const before = writes;
      await expect(a.seal(vault, slot, receipt)).rejects.toMatchObject({
        code: "NATIVE_STORE_SUPERSEDED",
      });
      expect(writes).toBe(before);
      await a.rollback(vault, slot, receipt);
      expect((await b.read(vault, peer)).value).toBe("account-B");
      expect((await b.read(vault, slot)).value).toBe("original-target");
    },
  );

  it.each(["same-value", "delete-recreate"])(
    "rejects cross-slot %s ABA captured before prepare",
    async (kind) => {
      await a.write(vault, "session.steward_token", "account-A");
      const expected = await a.write(vault, slot, "original-target");
      if (kind === "delete-recreate")
        await b.write(vault, "session.steward_token", null);
      await b.write(vault, "session.steward_token", "account-A");
      const before = writes;
      await expect(
        a.prepare(vault, slot, expected, "stale-target", randomUUID()),
      ).rejects.toMatchObject({ code: "NATIVE_STORE_SUPERSEDED" });
      expect(writes).toBe(before);
      expect((await b.read(vault, slot)).value).toBe("original-target");
    },
  );

  it.each(["\n", "\u0000", '"', "\\", "😀"])(
    "keeps accepted near-limit %j payloads readable through compensation",
    async (character) => {
      const value = character.repeat(
        Math.floor(262144 / Buffer.byteLength(character, "utf8")),
      );
      const expected = await a.write(vault, slot, value);
      const receipt = await a.prepare(
        vault,
        slot,
        expected,
        value,
        randomUUID(),
      );
      await a.commit(vault, slot, receipt);
      await a.rollback(vault, slot, receipt);
      expect((await b.read(vault, slot)).value).toBe(value);
      const before = raw.get(address(vault, slot));
      await expect(
        a.write(vault, slot, value + character),
      ).rejects.toMatchObject({ code: "NATIVE_STORE_INVALID_INPUT" });
      expect(raw.get(address(vault, slot))).toBe(before);
    },
  );

  it.each(["reject", "drop", "lost-reply"] as const)(
    "preserves committed rollback quarantine through %s and reconstruction",
    async (mode) => {
      const expected = await a.write(vault, slot, "original");
      const receipt = await a.prepare(
        vault,
        slot,
        expected,
        "cancelled-candidate",
        randomUUID(),
      );
      await a.commit(vault, slot, receipt);
      failure = mode;
      await expect(a.rollback(vault, slot, receipt)).rejects.toBeInstanceOf(
        Error,
      );
      failure = "none";
      const restarted = new RendererSecureStoreTransactions(
        backend,
        serialization,
        () => time,
      );
      if (mode === "lost-reply")
        expect((await restarted.read(vault, slot)).value).toBe("original");
      else
        await expect(restarted.read(vault, slot)).rejects.toMatchObject({
          code: "NATIVE_STORE_PENDING",
        });
      await restarted.rollback(vault, slot, receipt);
      expect((await restarted.read(vault, slot)).value).toBe("original");
    },
  );

  it("migrates a legacy payload without exposing the record envelope", async () => {
    raw.set(address(vault, slot), "original-local");
    const expected = await a.read(vault, slot);
    const receipt = await a.prepare(
      vault,
      slot,
      expected,
      "cloud-target",
      randomUUID(),
    );
    await expect(b.read(vault, slot)).rejects.toMatchObject({
      code: "NATIVE_STORE_PENDING",
    });
    await a.commit(vault, slot, receipt);
    await a.seal(vault, slot, receipt);
    expect((await b.read(vault, slot)).value).toBe("cloud-target");
    expect(raw.get(address(vault, slot))).not.toBe("cloud-target");
  });

  it.each([false, true])(
    "never compensates over a newer context (old committed: %s)",
    async (committed) => {
      const expected = await a.write(vault, slot, "original-local");
      // A's native work is complete but its renderer may not have received the reply.
      const receipt = await a.prepare(
        vault,
        slot,
        expected,
        null,
        randomUUID(),
      );
      if (committed) await a.commit(vault, slot, receipt);
      const winner = await b.write(vault, slot, "newer-target");
      await expect(a.rollback(vault, slot, receipt)).rejects.toMatchObject({
        code: "NATIVE_STORE_SUPERSEDED",
      });
      expect(await b.read(vault, slot)).toEqual(winner);
    },
  );

  it.each(["same-value", "delete-recreate"])(
    "fences ABA after %s",
    async (kind) => {
      const expected = await a.write(vault, slot, "original-local");
      const receipt = await a.prepare(
        vault,
        slot,
        expected,
        "cloud-target",
        randomUUID(),
      );
      await a.commit(vault, slot, receipt);
      if (kind === "delete-recreate") await b.write(vault, slot, null);
      const winner = await b.write(vault, slot, "cloud-target");
      await expect(a.rollback(vault, slot, receipt)).rejects.toMatchObject({
        code: "NATIVE_STORE_SUPERSEDED",
      });
      await expect(a.commit(vault, slot, receipt)).rejects.toMatchObject({
        code: "NATIVE_STORE_SUPERSEDED",
      });
      expect(await b.read(vault, slot)).toEqual(winner);
    },
  );

  it("rejects a stale selection before dispatch and serializes simultaneous preparations", async () => {
    const expected = await a.write(vault, slot, "original-local");
    const results = await Promise.allSettled([
      a.prepare(vault, slot, expected, "target-A", randomUUID()),
      b.prepare(vault, slot, expected, "target-B", randomUUID()),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const winner = await b.write(vault, slot, "target-B");
    const before = writes;
    await expect(
      a.prepare(vault, slot, expected, "stale", randomUUID()),
    ).rejects.toMatchObject({ code: "NATIVE_STORE_SUPERSEDED" });
    expect(writes).toBe(before);
    expect(await a.read(vault, slot)).toEqual(winner);
  });

  it.each([null, "prior-target"])(
    "rolls back only its own mutation, preserving prior %s",
    async (previous) => {
      const expected = await a.write(vault, slot, previous);
      const receipt = await a.prepare(
        vault,
        slot,
        expected,
        "proposal",
        randomUUID(),
      );
      await a.commit(vault, slot, receipt);
      await a.rollback(vault, slot, receipt);
      const restored = await a.read(vault, slot);
      expect(restored.value).toBe(previous);
      expect(restored.revision).not.toBe(expected.revision);
      await a.rollback(vault, slot, receipt);
      expect(await b.read(vault, slot)).toEqual(restored);
      await expect(a.commit(vault, slot, receipt)).rejects.toMatchObject({
        code: "NATIVE_STORE_SUPERSEDED",
      });
    },
  );

  it("keeps deletion revisions across reconstruction and rejects stale absent snapshots", async () => {
    const absent = await a.read(vault, slot);
    await b.write(vault, slot, "temporary");
    const deleted = await b.write(vault, slot, null);
    const restarted = new RendererSecureStoreTransactions(
      backend,
      serialization,
      () => time,
    );
    expect(await restarted.read(vault, slot)).toEqual(deleted);
    await expect(
      restarted.prepare(vault, slot, absent, "stale", randomUUID()),
    ).rejects.toMatchObject({ code: "NATIVE_STORE_SUPERSEDED" });
  });

  it.each(["pending", "committed"] as const)(
    "recovers a lost %s reply without replaying a different operation",
    async (stage) => {
      const expected = await a.write(vault, slot, "original");
      const operationId = randomUUID();
      if (stage === "pending") failure = "lost-reply";
      if (stage === "pending")
        await expect(
          a.prepare(vault, slot, expected, "next", operationId),
        ).rejects.toThrow("reply lost");
      else {
        const receipt = await a.prepare(
          vault,
          slot,
          expected,
          "next",
          operationId,
        );
        failure = "lost-reply";
        await expect(a.commit(vault, slot, receipt)).rejects.toThrow(
          "reply lost",
        );
      }
      failure = "none";
      const restarted = new RendererSecureStoreTransactions(
        backend,
        serialization,
        () => time,
      );
      const receipt = await restarted.lookup(vault, slot, operationId);
      expect(receipt?.state).toBe(stage);
      if (!receipt) throw new Error("Missing operation receipt");
      const before = writes;
      expect(
        await restarted.prepare(vault, slot, expected, "next", operationId),
      ).toEqual(receipt);
      expect(writes).toBe(before);
      await expect(
        restarted.prepare(vault, slot, expected, "different", operationId),
      ).rejects.toMatchObject({ code: "NATIVE_STORE_INVALID_INPUT" });
      await restarted.rollback(vault, slot, receipt);
      expect((await restarted.read(vault, slot)).value).toBe("original");
    },
  );

  it.each([60_001, -10_000])(
    "retires crashed pending state after clock change %s without promoting it",
    async (elapsed) => {
      const expected = await a.write(vault, slot, "original");
      const receipt = await a.prepare(
        vault,
        slot,
        expected,
        "unacknowledged",
        randomUUID(),
      );
      const restarted = new RendererSecureStoreTransactions(
        backend,
        serialization,
        () => time,
      );
      await expect(restarted.read(vault, slot)).rejects.toMatchObject({
        code: "NATIVE_STORE_PENDING",
      });
      time += elapsed;
      const recovered = await restarted.read(vault, slot);
      expect(recovered.value).toBe("original");
      await expect(a.commit(vault, slot, receipt)).rejects.toMatchObject({
        code: "NATIVE_STORE_SUPERSEDED",
      });
      await a.rollback(vault, slot, receipt);
      expect(await restarted.read(vault, slot)).toEqual(recovered);
    },
  );

  it.each(["reject", "drop"] as const)(
    "does not publish after native %s and preserves failed compensation quarantine",
    async (mode) => {
      const expected = await a.write(vault, slot, "original");
      failure = mode;
      await expect(
        a.prepare(vault, slot, expected, "next", randomUUID()),
      ).rejects.toBeInstanceOf(Error);
      failure = "none";
      expect(await a.read(vault, slot)).toEqual(expected);
      const receipt = await a.prepare(
        vault,
        slot,
        expected,
        "next",
        randomUUID(),
      );
      failure = mode;
      await expect(a.rollback(vault, slot, receipt)).rejects.toBeInstanceOf(
        Error,
      );
      failure = "none";
      await expect(b.read(vault, slot)).rejects.toMatchObject({
        code: "NATIVE_STORE_PENDING",
      });
      await a.rollback(vault, slot, receipt);
      expect((await b.read(vault, slot)).value).toBe("original");
    },
  );

  it("rejects cross-slot and cross-vault receipts without touching either value", async () => {
    const expected = await a.write(vault, slot, "original");
    const receipt = await a.prepare(vault, slot, expected, null, randomUUID());
    await expect(
      a.rollback("other-vault", slot, receipt),
    ).rejects.toMatchObject({ code: "NATIVE_STORE_SUPERSEDED" });
    await expect(
      a.commit(vault, "runtime.agent_profiles", receipt),
    ).rejects.toMatchObject({ code: "NATIVE_STORE_SUPERSEDED" });
    await a.rollback(vault, slot, receipt);
    expect((await a.read(vault, slot)).value).toBe("original");
  });

  it("fails closed on malformed or future record formats without overwriting them", async () => {
    for (const value of [
      "eliza-native-slot:1\n{",
      "eliza-native-slot:2\n{}",
      "eliza-native-slot:1\n{}",
    ]) {
      raw.set(address(vault, slot), value);
      await expect(a.read(vault, slot)).rejects.toMatchObject({
        code: "NATIVE_STORE_CORRUPT",
      });
      expect(raw.get(address(vault, slot))).toBe(value);
    }
  });

  it.each(["none", "lost-reply"] as const)(
    "publishes only at seal and reconciles its %s without undo",
    async (mode) => {
      const expected = await a.write(vault, slot, "original");
      const receipt = await a.prepare(
        vault,
        slot,
        expected,
        "final-target",
        randomUUID(),
      );
      await a.commit(vault, slot, receipt);
      await expect(b.read(vault, slot)).rejects.toMatchObject({
        code: "NATIVE_STORE_PENDING",
      });
      failure = mode;
      if (mode === "lost-reply")
        await expect(a.seal(vault, slot, receipt)).rejects.toThrow(
          "reply lost",
        );
      else await a.seal(vault, slot, receipt);
      failure = "none";
      const restarted = new RendererSecureStoreTransactions(
        backend,
        serialization,
        () => time,
      );
      expect(
        (await restarted.lookup(vault, slot, receipt.operationId))?.state,
      ).toBe("sealed");
      const published = await restarted.read(vault, slot);
      expect(published.value).toBe("final-target");
      expect(published.revision).not.toBe(receipt.revision);
      await expect(a.rollback(vault, slot, receipt)).rejects.toMatchObject({
        code: "NATIVE_STORE_SUPERSEDED",
      });
      const before = writes;
      expect(await a.seal(vault, slot, receipt)).toEqual(published);
      expect(writes).toBe(before);
      expect(raw.get(address(vault, slot))).not.toContain("original");
    },
  );

  it.each(["reject", "drop"] as const)(
    "keeps failed seal %s unavailable and recovers after restart",
    async (mode) => {
      const expected = await a.write(vault, slot, "original");
      const receipt = await a.prepare(
        vault,
        slot,
        expected,
        "unpublished",
        randomUUID(),
      );
      await a.commit(vault, slot, receipt);
      failure = mode;
      await expect(a.seal(vault, slot, receipt)).rejects.toBeInstanceOf(Error);
      failure = "none";
      await expect(b.read(vault, slot)).rejects.toMatchObject({
        code: "NATIVE_STORE_PENDING",
      });
      time += 60_001;
      const restarted = new RendererSecureStoreTransactions(
        backend,
        serialization,
        () => time,
      );
      expect((await restarted.read(vault, slot)).value).toBe("original");
      await expect(a.seal(vault, slot, receipt)).rejects.toMatchObject({
        code: "NATIVE_STORE_SUPERSEDED",
      });
    },
  );
});
