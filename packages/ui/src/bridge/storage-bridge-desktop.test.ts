/** Exercises the bundled UI bridge and continuation capture in independent realms against desktop RPC and real SQLite. OS credentials, transport timing and non-native session/selection collaborators are isolated fixtures; this is not a full authenticated app journey. */
/// <reference types="bun-types/sqlite" />
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import vm from "node:vm";
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRendererSecureStoreRpc } from "../../../app-core/platforms/electrobun/src/renderer-secure-store-rpc";
import type { PlatformSecureStore } from "../../../app-core/src/security/platform-secure-store";
import type { createCloudContinuationAuthority } from "../first-run/cloud-continuation-authority";
import type { DesktopStorageAuthority } from "./desktop-secure-store-transaction";

type Bridge = {
  createCloudContinuationAuthority: typeof createCloudContinuationAuthority;
  captureStorageMutationAuthority(
    revalidate: () => void,
  ): Promise<DesktopStorageAuthority>;
  initializeStorageBridge(): Promise<void>;
  getStorageValue(key: string): Promise<string | null>;
  setStorageValue(
    key: string,
    value: string,
    options?: { revalidate(): void; nativeAuthority?: DesktopStorageAuthority },
  ): Promise<void>;
  removeStorageValue(
    key: string,
    options: { revalidate(): void; nativeAuthority?: DesktopStorageAuthority },
  ): Promise<void>;
};
type Rpc = ReturnType<typeof createRendererSecureStoreRpc>;
const key = "elizaos:active-server";
const kind = "runtime.active_server";
let bundle: string;
const directories: string[] = [];
const fixtures = {
  "@capacitor/core":
    'export const Capacitor={getPlatform:()=>"web",isNativePlatform:()=>false};',
  "@elizaos/logger":
    "export const logger={error(){},warn(){},info(){},debug(){}};",
  "@elizaos/shared/steward-session-client":
    'export const STEWARD_PENDING_WRITE_KEY="pending:steward",STEWARD_TOKEN_KEY="steward_session_token",STEWARD_SESSION_CHANGE_EVENT="session-change";export function registerStewardTokenPersistence(){};export function registerStewardTokenReader(){};export function registerStewardTokenRemoval(){};export function getStewardTabSessionAuthorityCoordinator(){return {readSnapshot:()=>({}),assertSnapshot(){}}};export class StewardSessionAuthorityError extends Error{}',
  "../config/boot-config":
    'export const getBootConfig=()=>({cloudApiBase:"https://cloud.invalid"});',
  "../state/persistence":
    'export const loadPersistedActiveServer=()=>window.localStorage.getItem("elizaos:active-server");',
  "../state/agent-profiles":
    'export const getActiveProfile=()=>null;export const prepareAgentProfileRegistryDurably=()=>{throw new Error("profile collaborator is outside this capture test")};',
  "../first-run/mobile-runtime-mode":
    'export const MOBILE_RUNTIME_MODE_STORAGE_KEY="eliza:mobile-runtime-mode";',
  "../surface-realm-channel": "export const runAsPrivilegedShell=(fn)=>fn();",
  "./electrobun-runtime": "export const isElectrobunRuntime=()=>true;",
  "@capacitor/preferences": "export const Preferences={};",
  "@elizaos/capacitor-secure-store": "export const ElizaSecureStore={};",
};

beforeAll(async () => {
  const result = await build({
    stdin: {
      contents:
        'export * from "./storage-bridge";export {createCloudContinuationAuthority} from "../first-run/cloud-continuation-authority";',
      resolveDir: import.meta.dirname,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "bridge",
    platform: "browser",
    plugins: [
      {
        name: "fixture-platform-boundaries",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) =>
            args.path in fixtures
              ? { path: args.path, namespace: "fixture" }
              : undefined,
          );
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            contents: fixtures[args.path as keyof typeof fixtures],
            loader: "js",
          }));
        },
      },
    ],
  });
  bundle = result.outputFiles[0].text;
});
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function setup() {
  const directory = mkdtempSync(
    resolve(tmpdir(), "eliza-renderer-ledger-test-"),
  );
  directories.push(directory);
  const values = new Map<string, string>();
  const store: Pick<PlatformSecureStore, "get" | "set"> = {
    get: async (vault, slot) => {
      const value = values.get(`${vault}:${slot}`);
      return value === undefined
        ? { ok: false, reason: "not_found" }
        : { ok: true, value };
    },
    set: async (vault, slot, value) => {
      values.set(`${vault}:${slot}`, value);
      return { ok: true };
    },
  };
  const rpc = createRendererSecureStoreRpc({
    directory,
    vault: "fixture-renderer-vault",
    store,
  });
  await rpc.secureStoreSet({ kind, value: "original" });
  return rpc;
}

function realm(
  rpc: Rpc,
  afterCall: (operation: string) => Promise<void> = async () => undefined,
  transactions = true,
) {
  // Different origins/partitions have independent localStorage but share a host vault.
  const data = new Map<string, string>();
  class Storage {
    getItem(key: string) {
      return data.get(key) ?? null;
    }
    setItem(key: string, value: string) {
      data.set(key, String(value));
    }
    removeItem(key: string) {
      data.delete(key);
    }
  }
  const request = Object.fromEntries(
    Object.entries(rpc)
      .filter(([name]) => transactions || name !== "secureStoreTransaction")
      .map(([name, method]) => [
        name,
        async (params: Record<string, unknown>) => {
          const result = await (
            method as (params: Record<string, unknown>) => Promise<unknown>
          )(params);
          await afterCall(
            name === "secureStoreTransaction" ? String(params.operation) : name,
          );
          return result;
        },
      ]),
  );
  const localStorage = new Storage();
  const context = vm.createContext({
    window: {
      localStorage,
      __ELIZA_ELECTROBUN_RPC__: { request },
      addEventListener() {},
      removeEventListener() {},
    },
    AbortController,
    crypto: { randomUUID },
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(bundle, context);
  return { bridge: context.bridge as Bridge, localStorage };
}

describe("desktop renderer conditional persistence", () => {
  it("carries actual continuation capture into its later guarded target publication", async () => {
    const rpc = await setup();
    const a = realm(rpc);
    await a.bridge.initializeStorageBridge();
    const authority = await a.bridge.createCloudContinuationAuthority({
      getBaseUrl: () => "https://cloud.invalid",
      getAuthorityRevision: () => 0,
      getRestAuthToken: () => "fixture-token",
      onAuthorityChange: () => () => {},
    });
    try {
      await rpc.secureStoreSet({
        kind: "session.device_auth",
        value: "different-account",
      });
      await expect(
        a.bridge.setStorageValue(
          key,
          "old-continuation",
          authority.storageOptions,
        ),
      ).rejects.toThrow();
      expect(await rpc.secureStoreGet({ kind })).toEqual({
        ok: true,
        value: "original",
      });
    } finally {
      authority.dispose();
    }
  });
  it("rejects capture when the renderer mirror was already superseded", async () => {
    const rpc = await setup();
    const a = realm(rpc);
    await a.bridge.initializeStorageBridge();
    await rpc.secureStoreSet({ kind, value: "newer-before-capture" });
    await expect(
      a.bridge.captureStorageMutationAuthority(() => {}),
    ).rejects.toThrow();
    expect(await rpc.secureStoreGet({ kind })).toEqual({
      ok: true,
      value: "newer-before-capture",
    });
  });

  it("rejects an account transition during multi-slot capture", async () => {
    const rpc = await setup();
    let reads = 0;
    const a = realm(rpc, async (operation) => {
      if (operation === "read" && ++reads === 2)
        await rpc.secureStoreSet({
          kind: "session.device_auth",
          value: "during-capture",
        });
    });
    await a.bridge.initializeStorageBridge();
    await expect(
      a.bridge.captureStorageMutationAuthority(() => {}),
    ).rejects.toThrow();
    expect(await rpc.secureStoreGet({ kind })).toEqual({
      ok: true,
      value: "original",
    });
  });

  it("advances only its own acknowledged slots across a multi-step workflow", async () => {
    const rpc = await setup();
    const a = realm(rpc);
    await a.bridge.initializeStorageBridge();
    const nativeAuthority = await a.bridge.captureStorageMutationAuthority(
      () => {},
    );
    const options = { revalidate() {}, nativeAuthority };
    await a.bridge.setStorageValue(
      "elizaos:agent-profiles",
      "owned-profiles",
      options,
    );
    await a.bridge.removeStorageValue(key, options);
    await nativeAuthority.assertCurrent();
    await a.bridge.setStorageValue(key, "owned-target", options);
    await nativeAuthority.assertCurrent();
    expect(await rpc.secureStoreGet({ kind })).toEqual({
      ok: true,
      value: "owned-target",
    });
    await rpc.secureStoreSet({
      kind: "runtime.agent_profiles",
      value: "another-workflow",
    });
    await expect(nativeAuthority.assertCurrent()).rejects.toThrow();
    await expect(a.bridge.removeStorageValue(key, options)).rejects.toThrow();
    expect(await rpc.secureStoreGet({ kind })).toEqual({
      ok: true,
      value: "owned-target",
    });
  });

  it("rejects another writer's ABA even when its final value matches the captured value", async () => {
    const rpc = await setup();
    const a = realm(rpc);
    await a.bridge.initializeStorageBridge();
    const nativeAuthority = await a.bridge.captureStorageMutationAuthority(
      () => {},
    );
    await rpc.secureStoreSet({ kind, value: "intermediate" });
    await rpc.secureStoreSet({ kind, value: "original" });
    await expect(
      a.bridge.removeStorageValue(key, { revalidate() {}, nativeAuthority }),
    ).rejects.toThrow();
    expect(await rpc.secureStoreGet({ kind })).toEqual({
      ok: true,
      value: "original",
    });
  });

  it("rejects an old workflow after another realm changes the account before its first native write", async () => {
    const rpc = await setup();
    const a = realm(rpc);
    const b = realm(rpc);
    await a.bridge.initializeStorageBridge();
    await b.bridge.initializeStorageBridge();
    const capturedSelection = a.localStorage.getItem(key);
    const nativeAuthority = await a.bridge.captureStorageMutationAuthority(
      () => {},
    );
    await b.bridge.setStorageValue(
      "eliza.device.auth",
      "account-in-other-realm",
    );
    await expect(
      a.bridge.setStorageValue(key, "old-workflow-target", {
        nativeAuthority,
        revalidate() {
          if (a.localStorage.getItem(key) !== capturedSelection)
            throw new Error("selection changed");
        },
      }),
    ).rejects.toThrow();
    expect(await rpc.secureStoreGet({ kind })).toEqual({
      ok: true,
      value: "original",
    });
  });
  it.each([false, true])(
    "does not adopt another account's authority while reconciling its own seal acknowledgement (lost reply: %s)",
    async (lost) => {
      const rpc = await setup();
      let changed = false;
      const a = realm(rpc, async (operation) => {
        if (operation === "seal" && !changed) {
          changed = true;
          await rpc.secureStoreSet({
            kind: "session.device_auth",
            value: "account-after-seal",
          });
          if (lost) throw new Error("lost seal reply");
        }
      });
      await a.bridge.initializeStorageBridge();
      await expect(
        a.bridge.setStorageValue(key, "old-account-target", {
          revalidate() {},
        }),
      ).rejects.toThrow();
      expect(a.localStorage.getItem(key)).toBeNull();
      expect(await rpc.secureStoreGet({ kind: "session.device_auth" })).toEqual(
        {
          ok: true,
          value: "account-after-seal",
        },
      );
    },
  );
  it("lets the real caller validate its captured selection while its own write is quarantined", async () => {
    const rpc = await setup();
    const a = realm(rpc);
    await a.bridge.initializeStorageBridge();
    const expected = a.localStorage.getItem(key);
    await a.bridge.setStorageValue(key, "new-target", {
      revalidate() {
        if (a.localStorage.getItem(key) !== expected)
          throw new Error("selection changed");
      },
    });
    expect(a.localStorage.getItem(key)).toBe("new-target");
    expect(await rpc.secureStoreGet({ kind })).toEqual({
      ok: true,
      value: "new-target",
    });
  });

  it("does not republish A's stale seal acknowledgement after B has selected another target", async () => {
    const rpc = await setup();
    const entered = deferred(),
      release = deferred();
    const a = realm(rpc, async (operation) => {
      if (operation === "seal") {
        entered.resolve();
        await release.promise;
      }
    });
    const b = realm(rpc);
    await a.bridge.initializeStorageBridge();
    await b.bridge.initializeStorageBridge();
    const old = a.bridge
      .setStorageValue(key, "sealed-A", { revalidate() {} })
      .then(
        () => "success",
        () => "superseded",
      );
    await entered.promise;
    await b.bridge.setStorageValue(key, "winner-B");
    release.resolve();
    expect(await old).toBe("superseded");
    expect(a.localStorage.getItem(key)).toBeNull();
    expect(await rpc.secureStoreGet({ kind })).toEqual({
      ok: true,
      value: "winner-B",
    });
  });
  it("keeps the other realm's acknowledged selection when the old deletion is cancelled after native acknowledgement", async () => {
    const rpc = await setup();
    const entered = deferred(),
      release = deferred();
    let armed = false,
      cancelled = false;
    const a = realm(rpc, async (operation) => {
      if (
        armed &&
        (operation === "commit" || operation === "secureStoreDelete")
      ) {
        entered.resolve();
        await release.promise;
      }
    });
    const b = realm(rpc);
    await a.bridge.initializeStorageBridge();
    await b.bridge.initializeStorageBridge();
    armed = true;
    const old = a.bridge
      .removeStorageValue(key, {
        revalidate() {
          if (cancelled) throw new Error("cancelled");
        },
      })
      .then(
        () => "success",
        () => "cancelled",
      );
    await entered.promise;
    await b.bridge.setStorageValue(key, "newer-window");
    cancelled = true;
    release.resolve();
    expect(await old).toBe("cancelled");
    expect(await rpc.secureStoreGet({ kind })).toEqual({
      ok: true,
      value: "newer-window",
    });
    expect(b.localStorage.getItem(key)).toBe("newer-window");
  });

  it("restores its own unsealed proposal on cancellation without publishing it", async () => {
    const rpc = await setup();
    let cancelled = false,
      armed = false;
    const a = realm(rpc, async (operation) => {
      if (armed && (operation === "commit" || operation === "secureStoreSet"))
        cancelled = true;
    });
    await a.bridge.initializeStorageBridge();
    armed = true;
    await expect(
      a.bridge.setStorageValue(key, "cancelled-value", {
        revalidate() {
          if (cancelled) throw new Error("cancelled");
        },
      }),
    ).rejects.toThrow();
    expect(await rpc.secureStoreGet({ kind })).toEqual({
      ok: true,
      value: "original",
    });
    expect(a.localStorage.getItem(key)).not.toBe("cancelled-value");
  });

  it("does not use an unconditional legacy write when transaction RPC is unavailable", async () => {
    const rpc = await setup();
    const a = realm(rpc, undefined, false);
    await a.bridge.initializeStorageBridge();
    await expect(
      a.bridge.setStorageValue(key, "unsafe-fallback", { revalidate() {} }),
    ).rejects.toThrow();
    expect(await rpc.secureStoreGet({ kind })).toEqual({
      ok: true,
      value: "original",
    });
  });

  it.each(["prepare", "commit"])(
    "reconciles a lost %s reply and releases only its own proposal",
    async (lost) => {
      const rpc = await setup();
      const a = realm(rpc, async (operation) => {
        if (operation === lost) throw new Error("lost transport reply");
      });
      await a.bridge.initializeStorageBridge();
      await expect(
        a.bridge.setStorageValue(key, "unacknowledged", { revalidate() {} }),
      ).rejects.toThrow();
      expect(await rpc.secureStoreGet({ kind })).toEqual({
        ok: true,
        value: "original",
      });
    },
  );

  it("reconciles one lost seal acknowledgement without undoing the published value", async () => {
    const rpc = await setup();
    let lost = false;
    const a = realm(rpc, async (operation) => {
      if (operation === "seal" && !lost) {
        lost = true;
        throw new Error("lost seal reply");
      }
    });
    await a.bridge.initializeStorageBridge();
    const nativeAuthority = await a.bridge.captureStorageMutationAuthority(
      () => {},
    );
    await a.bridge.setStorageValue(key, "published", {
      revalidate() {},
      nativeAuthority,
    });
    await nativeAuthority.assertCurrent();
    expect(lost).toBe(true);
    expect(await rpc.secureStoreGet({ kind })).toEqual({
      ok: true,
      value: "published",
    });
    expect(a.localStorage.getItem(key)).toBe("published");
  });

  it("does not roll back a newer writer after cancellation during the seal reply", async () => {
    const rpc = await setup();
    const entered = deferred(),
      release = deferred();
    let cancelled = false;
    const a = realm(rpc, async (operation) => {
      if (operation === "seal") {
        entered.resolve();
        await release.promise;
      }
    });
    const b = realm(rpc);
    await a.bridge.initializeStorageBridge();
    await b.bridge.initializeStorageBridge();
    const old = a.bridge
      .setStorageValue(key, "sealed-A", {
        revalidate() {
          if (cancelled) throw new Error("cancelled");
        },
      })
      .then(
        () => "success",
        () => "cancelled",
      );
    await entered.promise;
    await b.bridge.setStorageValue(key, "winner-B");
    cancelled = true;
    release.resolve();
    expect(await old).toBe("cancelled");
    expect(await rpc.secureStoreGet({ kind })).toEqual({
      ok: true,
      value: "winner-B",
    });
    expect(a.localStorage.getItem(key)).toBeNull();
    expect(b.localStorage.getItem(key)).toBe("winner-B");
  });

  it("rejects changed native account authority before sealing a target proposal", async () => {
    const rpc = await setup();
    const a = realm(rpc, async (operation) => {
      if (operation === "commit")
        await rpc.secureStoreSet({
          kind: "session.device_auth",
          value: "new-account-authority",
        });
    });
    await a.bridge.initializeStorageBridge();
    await expect(
      a.bridge.setStorageValue(key, "stale-target", { revalidate() {} }),
    ).rejects.toThrow();
    expect(await rpc.secureStoreGet({ kind })).toEqual({
      ok: true,
      value: "original",
    });
    expect(await rpc.secureStoreGet({ kind: "session.device_auth" })).toEqual({
      ok: true,
      value: "new-account-authority",
    });
  });

  it("publishes a guarded deletion as a native tombstone across a fresh renderer", async () => {
    const rpc = await setup();
    const a = realm(rpc);
    await a.bridge.initializeStorageBridge();
    await a.bridge.removeStorageValue(key, { revalidate() {} });
    const b = realm(rpc);
    await b.bridge.initializeStorageBridge();
    expect(await rpc.secureStoreGet({ kind })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(b.localStorage.getItem(key)).toBeNull();
    expect(await b.bridge.getStorageValue(key)).toBeNull();
  });
});
