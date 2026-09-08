/** Exercises the renderer RPC handlers against the real native ledger with an isolated in-memory credential backend, not Electrobun or OS-keychain acceptance. */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { deriveAgentVaultId } from "../../../src/security/agent-vault-id";
import type { PlatformSecureStore } from "../../../src/security/platform-secure-store";
import {
  createRendererSecureStoreRpc,
  resolveRendererSecureStoreInstallation,
} from "./renderer-secure-store-rpc";

let directory: string;
let a: ReturnType<typeof createRendererSecureStoreRpc>;
let b: ReturnType<typeof createRendererSecureStoreRpc>;
let nativeCalls: number;
let denyWrites: boolean;
let store: Pick<PlatformSecureStore, "get" | "set">;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "eliza-native-rpc-test-"));
  const values = new Map<string, string>();
  nativeCalls = 0;
  denyWrites = false;
  store = {
    get: async (id, key) => {
      nativeCalls++;
      const value = values.get(JSON.stringify([id, key]));
      return value === undefined
        ? { ok: false, reason: "not_found" }
        : { ok: true, value };
    },
    set: async (id, key, value) => {
      nativeCalls++;
      if (denyWrites) return { ok: false, reason: "denied" };
      values.set(JSON.stringify([id, key]), value);
      return { ok: true };
    },
  };
  const options = { directory, vault: "rpc-fixture", store };
  a = createRendererSecureStoreRpc(options);
  b = createRendererSecureStoreRpc(options);
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

it("retains credentials across restart when the new state directory is under a symlink parent", async () => {
  const realParent = join(directory, "real-parent"),
    linkedParent = join(directory, "linked-parent");
  mkdirSync(realParent);
  symlinkSync(
    realParent,
    linkedParent,
    process.platform === "win32" ? "junction" : "dir",
  );
  const absentLeaf = join(linkedParent, "new-installation");
  const first = createRendererSecureStoreRpc(() =>
    resolveRendererSecureStoreInstallation(absentLeaf, store),
  );
  await first.secureStoreSet({
    kind: "session.steward_token",
    value: "survives-restart",
  });
  const restarted = createRendererSecureStoreRpc(() =>
    resolveRendererSecureStoreInstallation(realpathSync(absentLeaf), store),
  );
  expect(
    await restarted.secureStoreGet({ kind: "session.steward_token" }),
  ).toEqual({ ok: true, value: "survives-restart" });
});

it("resolves installation configuration after bootstrap and pins that same namespace for every request", async () => {
  let selected = join(directory, "before-bootstrap");
  let resolutions = 0;
  const deferred = createRendererSecureStoreRpc(() => {
    resolutions++;
    return { directory: selected, vault: deriveAgentVaultId(selected), store };
  });
  selected = join(directory, "configured-installation");
  await store.set(
    deriveAgentVaultId(selected),
    "session.steward_token",
    "configured-fixture",
  );
  expect(
    await deferred.secureStoreGet({ kind: "session.steward_token" }),
  ).toEqual({ ok: true, value: "configured-fixture" });
  expect(existsSync(join(directory, "before-bootstrap"))).toBe(false);
  selected = join(directory, "unrelated-later-installation");
  expect(
    await deferred.secureStoreGet({ kind: "session.steward_token" }),
  ).toEqual({ ok: true, value: "configured-fixture" });
  expect(resolutions).toBe(1);
  expect(existsSync(selected)).toBe(false);
});

it("propagates failed logical deletion and retains the original renderer credential", async () => {
  const kind = "session.steward_token";
  await a.secureStoreSet({ kind, value: "retained-fixture-token" });
  denyWrites = true;
  await expect(b.secureStoreDelete({ kind })).rejects.toMatchObject({
    code: "NATIVE_LEDGER_UNAVAILABLE",
  });
  denyWrites = false;
  expect(await a.secureStoreGet({ kind })).toEqual({
    ok: true,
    value: "retained-fixture-token",
  });
});

it("keeps ordinary renderer callers in the same ownership boundary as conditional operations", async () => {
  const kind = "runtime.active_server";
  await a.secureStoreSet({ kind, value: "original" });
  const read = await a.secureStoreTransaction({ operation: "read", kind });
  if (read.operation !== "read") throw new Error("Wrong RPC response");
  const prepared = await a.secureStoreTransaction({
    operation: "prepare",
    kind,
    expected: read.snapshot,
    value: "stale-target",
    operationId: randomUUID(),
  });
  if (prepared.operation !== "prepare") throw new Error("Wrong RPC response");
  await b.secureStoreSet({ kind, value: "newer-winner" });
  await expect(
    a.secureStoreTransaction({
      operation: "rollback",
      kind,
      receipt: prepared.receipt,
    }),
  ).rejects.toMatchObject({ code: "NATIVE_STORE_SUPERSEDED" });
  expect(await a.secureStoreGet({ kind })).toEqual({
    ok: true,
    value: "newer-winner",
  });
  await b.secureStoreDelete({ kind });
  expect(await a.secureStoreGet({ kind })).toEqual({
    ok: false,
    reason: "not_found",
  });
});

it("publishes through the RPC transaction and reconciles repeated seal", async () => {
  const kind = "session.steward_token";
  const read = await a.secureStoreTransaction({ operation: "read", kind });
  if (read.operation !== "read") throw new Error("Wrong RPC response");
  const operationId = randomUUID();
  const prepared = await a.secureStoreTransaction({
    operation: "prepare",
    kind,
    expected: read.snapshot,
    value: "fixture-token",
    operationId,
  });
  if (prepared.operation !== "prepare") throw new Error("Wrong RPC response");
  await expect(b.secureStoreGet({ kind })).rejects.toMatchObject({
    code: "NATIVE_STORE_PENDING",
  });
  await a.secureStoreTransaction({
    operation: "commit",
    kind,
    receipt: prepared.receipt,
  });
  const sealed = await a.secureStoreTransaction({
    operation: "seal",
    kind,
    receipt: prepared.receipt,
  });
  expect(
    await b.secureStoreTransaction({
      operation: "seal",
      kind,
      receipt: prepared.receipt,
    }),
  ).toEqual(sealed);
  expect(await b.secureStoreGet({ kind })).toEqual({
    ok: true,
    value: "fixture-token",
  });
  expect(
    await b.secureStoreTransaction({ operation: "lookup", kind, operationId }),
  ).toMatchObject({ operation: "lookup", receipt: { state: "sealed" } });
});

it("rejects disallowed slots and oversized ordinary values before native state is touched", async () => {
  await expect(
    a.secureStoreTransaction({
      operation: "lookup",
      kind: "runtime.active_server",
      operationId: "not-a-uuid",
    }),
  ).rejects.toThrow("identity is invalid");
  await expect(
    a.secureStoreSet({ kind: "wallet.solana_private_key", value: "fixture" }),
  ).rejects.toThrow("not allowed");
  await expect(
    a.secureStoreSet({
      kind: "runtime.active_server",
      value: "x".repeat(262145),
    }),
  ).rejects.toThrow("too large");
  expect(nativeCalls).toBe(0);
});
