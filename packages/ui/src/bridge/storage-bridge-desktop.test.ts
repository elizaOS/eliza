/** Exercises bundled storage and the real Steward session client in independent realms against desktop RPC and SQLite. Continuation-only cases isolate session/selection collaborators; OS credentials and IPC timing are fixtures throughout, not installed-app or live-provider acceptance. */
/// <reference types="bun-types/sqlite" />
import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import vm from "node:vm";
import type * as StewardSession from "@elizaos/shared/steward-session-client";
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRendererSecureStoreRpc } from "../../../app-core/platforms/electrobun/src/renderer-secure-store-rpc";
import type { PlatformSecureStore } from "../../../app-core/src/security/platform-secure-store";
import type { createCloudContinuationAuthority } from "../first-run/cloud-continuation-authority";
import type { DesktopStorageAuthority } from "./desktop-secure-store-transaction";

type Bridge = {
  writeStoredStewardToken: typeof StewardSession.writeStoredStewardToken;
  readStoredStewardToken: typeof StewardSession.readStoredStewardToken;
  configureStoredStewardTokenScope: typeof StewardSession.configureStoredStewardTokenScope;
  createCloudContinuationAuthority: typeof createCloudContinuationAuthority;
  captureStorageMutationAuthority(
    revalidate: () => void,
  ): Promise<DesktopStorageAuthority>;
  initializeStorageBridge(): Promise<void>;
  isStorageRecoveryRequired(): boolean;
  subscribeStorageRecovery(listener: () => void): () => void;
  getStorageValue(key: string): Promise<string | null>;
  setStorageValue(
    key: string,
    value: string,
    options?: {
      revalidate?(): void;
      nativeAuthority?: DesktopStorageAuthority;
      signal?: AbortSignal;
    },
  ): Promise<void>;
  removeStorageValue(
    key: string,
    options: {
      revalidate(): void;
      nativeAuthority?: DesktopStorageAuthority;
      signal?: AbortSignal;
    },
  ): Promise<void>;
};
type Rpc = ReturnType<typeof createRendererSecureStoreRpc>;
const key = "elizaos:active-server";
const kind = "runtime.active_server";
let bundle: string;
let sessionBundle: string;
const directories: string[] = [];
const fixtures = {
  "@capacitor/core":
    'export const Capacitor={getPlatform:()=>"web",isNativePlatform:()=>false};',
  "@elizaos/logger":
    "export const logger={error(){},warn(){},info(){},debug(){}};",
  "@elizaos/shared/steward-session-client":
    'export const STEWARD_PENDING_WRITE_KEY="pending:steward",STEWARD_TOKEN_KEY="steward_session_token",STEWARD_TOKEN_SCOPE_KEY="steward_session_token_scope",STEWARD_SESSION_CHANGE_EVENT="session-change";export function registerStewardTokenPersistence(){};export function registerStewardTokenReader(){};export function registerStewardTokenRemoval(){};export function getStewardTokenDeploymentScope(){return null};export function writeStoredStewardToken(){throw new Error("real session client required")};export function getStewardTabSessionAuthorityCoordinator(){return {readSnapshot:()=>({}),assertSnapshot(){}}};export class StewardSessionAuthorityError extends Error{}',
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
  for (const realSession of [false, true]) {
    const result = await build({
      stdin: {
        contents:
          'export * from "./storage-bridge";export {createCloudContinuationAuthority} from "../first-run/cloud-continuation-authority";' +
          (realSession
            ? 'export {writeStoredStewardToken,readStoredStewardToken,configureStoredStewardTokenScope} from "@elizaos/shared/steward-session-client";'
            : ""),
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
              args.path in fixtures &&
              !(
                realSession &&
                args.path === "@elizaos/shared/steward-session-client"
              )
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
    if (realSession) sessionBundle = result.outputFiles[0].text;
    else bundle = result.outputFiles[0].text;
  }
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

async function setup(afterProtectedSet: (value: string) => void = () => {}) {
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
      afterProtectedSet(value);
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
  realSession = false,
  sharedStorageData?: Map<string, string>,
) {
  // Native IPC enters from a separate async root, not the credential writer's
  // AsyncLocalStorage transaction context (even when a test delivers it inline).
  const transportContext = new AsyncResource("isolated-renderer-ipc");
  // Same-origin windows share storage; other partitions only share the host vault.
  const data = sharedStorageData ?? new Map<string, string>();
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
          const result = await transportContext.runInAsyncScope(() =>
            (method as (params: Record<string, unknown>) => Promise<unknown>)(
              params,
            ),
          );
          await afterCall(
            name === "secureStoreTransaction" ? String(params.operation) : name,
          );
          return result;
        },
      ]),
  );
  const localStorage = new Storage();
  const events = new EventTarget();
  const context = vm.createContext({
    window: {
      localStorage,
      __ELIZA_ELECTROBUN_RPC__: { request },
      location: new URL("http://127.0.0.1:42138/"),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    },
    AbortController,
    CustomEvent,
    URL,
    crypto: { randomUUID },
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(realSession ? sessionBundle : bundle, context);
  if (realSession)
    (context.bridge as Bridge).configureStoredStewardTokenScope(
      "https://api-staging.eliza.app",
    );
  return {
    bridge: context.bridge as Bridge,
    localStorage,
    rawGetItem: localStorage.getItem.bind(localStorage),
  };
}

function scopedToken(token: string, scope = "eliza-cloud:staging") {
  return JSON.stringify({ schema: "eliza.steward-token/v1", token, scope });
}

describe("desktop renderer conditional persistence", () => {
  it.each([false, true])(
    "recovers the latest caller-owned write after consecutive local failures (%s)",
    async (failSecondAcknowledgement) => {
      const rpc = await setup();
      const a = realm(rpc, undefined, true, true);
      await a.bridge.initializeStorageBridge();
      const pendingKey = `eliza:protected-storage-pending:${key}`;
      const remove = a.localStorage.removeItem.bind(a.localStorage);
      let refuseAcknowledgement = true;
      Object.defineProperty(a.localStorage, "removeItem", {
        value: (target: string) => {
          if (target === pendingKey && refuseAcknowledgement)
            throw new Error("local acknowledgement unavailable");
          remove(target);
        },
      });
      await expect(
        a.bridge.setStorageValue(key, "first-owned", {
          revalidate() {},
        }),
      ).rejects.toThrow();
      refuseAcknowledgement = failSecondAcknowledgement;
      const second = a.bridge.setStorageValue(key, "second-owned", {
        revalidate() {},
      });
      if (failSecondAcknowledgement) await expect(second).rejects.toThrow();
      else await second;
      refuseAcknowledgement = false;
      await a.bridge.initializeStorageBridge();
      expect(a.bridge.isStorageRecoveryRequired()).toBe(false);
      expect(a.localStorage.getItem(key)).toBe("second-owned");
      expect(a.localStorage.getItem(pendingKey)).toBeNull();
    },
  );

  it.each([
    [key, "retained"],
    [key, "acknowledged-elsewhere"],
    [key, "replaced"],
    ["steward_session_token", "retained"],
    ["steward_session_token", "acknowledged-elsewhere"],
    ["steward_session_token", "replaced"],
  ])(
    "retains cold recovery ownership for %s (%s)",
    async (storageKey, scenario) => {
      const rpc = await setup();
      const sharedStorage = new Map<string, string>();
      const a = realm(rpc, undefined, true, true, sharedStorage);
      await a.bridge.initializeStorageBridge();
      const isToken = storageKey === "steward_session_token";
      const pendingKey = isToken
        ? "eliza:steward-token-pending-write"
        : `eliza:protected-storage-pending:${storageKey}`;
      const remove = a.localStorage.removeItem.bind(a.localStorage);
      let refuseAcknowledgement = true;
      Object.defineProperty(a.localStorage, "removeItem", {
        value: (target: string) => {
          if (target === pendingKey && refuseAcknowledgement)
            throw new Error("local acknowledgement unavailable");
          remove(target);
        },
      });
      await expect(
        a.bridge.setStorageValue(storageKey, "owned-value", {
          revalidate() {},
        }),
      ).rejects.toThrow();
      let loseInspection = true;
      const b = realm(
        rpc,
        async (operation) => {
          if (operation === "inspect" && loseInspection) {
            loseInspection = false;
            throw new Error("cold inspection acknowledgement unavailable");
          }
        },
        true,
        true,
        sharedStorage,
      );
      await b.bridge.initializeStorageBridge();
      expect(b.bridge.isStorageRecoveryRequired()).toBe(true);
      expect(b.localStorage.getItem(storageKey)).toBeNull();
      if (scenario !== "retained") {
        refuseAcknowledgement = false;
        await a.bridge.initializeStorageBridge();
        expect(a.bridge.isStorageRecoveryRequired()).toBe(false);
        expect(a.localStorage.getItem(storageKey)).toBe("owned-value");
        expect(b.localStorage.getItem(pendingKey)).toBeNull();
        if (scenario === "replaced") {
          refuseAcknowledgement = true;
          await expect(
            a.bridge.setStorageValue(storageKey, "newer-value", {
              revalidate() {},
            }),
          ).rejects.toThrow();
        } else {
          await rpc.secureStoreSet({
            kind: isToken ? "session.steward_token" : kind,
            value: isToken ? scopedToken("newer-value") : "newer-value",
          });
        }
      }
      await b.bridge.initializeStorageBridge();
      expect(b.bridge.isStorageRecoveryRequired()).toBe(
        scenario !== "retained",
      );
      expect(b.localStorage.getItem(storageKey)).toBe(
        scenario === "retained" ? "owned-value" : null,
      );
    },
  );

  it("retries a marker-free cold native read failure", async () => {
    const rpc = await setup();
    let failRead = true;
    const a = realm(rpc, async (operation) => {
      if (operation === "secureStoreGet" && failRead) {
        failRead = false;
        throw new Error("cold read acknowledgement unavailable");
      }
    });
    await a.bridge.initializeStorageBridge();
    expect(a.bridge.isStorageRecoveryRequired()).toBe(true);
    await a.bridge.initializeStorageBridge();
    expect(a.bridge.isStorageRecoveryRequired()).toBe(false);
    expect(a.localStorage.getItem(key)).toBe("original");
  });

  it.each([
    ["steward_session_token", "owned"],
    ["steward_session_token", "superseded"],
    ["steward_session_token", "lost-inspection"],
    ["steward_session_token", "missing-marker"],
    [key, "owned"],
    [key, "superseded"],
    [key, "lost-inspection"],
    [key, "missing-marker"],
  ])(
    "retries interrupted %s hydration in the mounted renderer (%s)",
    async (storageKey, scenario) => {
      const rpc = await setup();
      await rpc.secureStoreSet({
        kind: "session.device_auth",
        value: "observed-device",
      });
      const operations: string[] = [];
      let loseInspection = false;
      const a = realm(
        rpc,
        async (operation) => {
          operations.push(operation);
          if (operation === "inspect" && loseInspection) {
            loseInspection = false;
            throw new Error("inspection acknowledgement unavailable");
          }
        },
        true,
        true,
      );
      await a.bridge.initializeStorageBridge();
      const isToken = storageKey === "steward_session_token";
      const slot = isToken ? "session.steward_token" : kind;
      const pendingKey = isToken
        ? "eliza:steward-token-pending-write"
        : `eliza:protected-storage-pending:${storageKey}`;
      const remove = a.localStorage.removeItem.bind(a.localStorage);
      let failLocalAcknowledgement = true;
      Object.defineProperty(a.localStorage, "removeItem", {
        value: (target: string) => {
          if (target === pendingKey && failLocalAcknowledgement)
            throw new Error("local acknowledgement unavailable");
          remove(target);
        },
      });
      await expect(
        a.bridge.setStorageValue(storageKey, "owned-result", {
          revalidate() {},
        }),
      ).rejects.toThrow();
      const marker = a.localStorage.getItem(pendingKey);
      if (marker === null) throw new Error("Missing interrupted operation");
      expect(a.bridge.isStorageRecoveryRequired()).toBe(true);
      expect(a.localStorage.getItem(storageKey)).toBeNull();
      failLocalAcknowledgement = false;
      if (scenario === "missing-marker") a.localStorage.removeItem(pendingKey);
      // A retry must not silently refresh other observed account/selection
      // mirrors while reconciling this interrupted operation.
      await rpc.secureStoreSet({
        kind: "session.device_auth",
        value: "newer-device",
      });
      if (scenario === "superseded")
        await rpc.secureStoreSet({
          kind: slot,
          value: isToken ? scopedToken("newer-result") : "newer-result",
        });
      operations.length = 0;
      loseInspection = scenario === "lost-inspection";
      await a.bridge.initializeStorageBridge();
      if (scenario === "lost-inspection") {
        expect(a.localStorage.getItem(storageKey)).toBeNull();
        expect(a.localStorage.getItem(pendingKey)).toBe(marker);
        await a.bridge.initializeStorageBridge();
      }
      expect(a.localStorage.getItem(storageKey)).toBe(
        scenario === "superseded" || scenario === "missing-marker"
          ? null
          : "owned-result",
      );
      expect(a.localStorage.getItem(pendingKey)).toBe(
        scenario === "superseded" ? marker : null,
      );
      expect(a.bridge.isStorageRecoveryRequired()).toBe(
        scenario === "superseded" || scenario === "missing-marker",
      );
      expect(a.localStorage.getItem("eliza.device.auth")).toBe(
        "observed-device",
      );
      if (scenario === "missing-marker") expect(operations).toEqual([]);
      else expect(operations).toContain("inspect");
      expect(
        operations.every((operation) =>
          ["inspect", "read"].includes(operation),
        ),
      ).toBe(true);
      expect(await rpc.secureStoreGet({ kind: slot })).toEqual({
        ok: true,
        value: isToken
          ? scopedToken(
              scenario === "superseded" ? "newer-result" : "owned-result",
            )
          : scenario === "superseded"
            ? "newer-result"
            : "owned-result",
      });
      if (isToken) expect(a.rawGetItem(storageKey)).toBeNull();
    },
  );

  it.each([
    "same-scope",
    "different-scope",
    "newer-owner",
    "lost-inspection",
    "scope-changes",
    "conflicting-markers",
  ])(
    "recovers only owned token authority on restart (%s)",
    async (scenario) => {
      const rpc = await setup();
      const a = realm(rpc, undefined, true, true);
      await a.bridge.initializeStorageBridge();
      const pendingKey = "eliza:steward-token-pending-write";
      const remove = a.localStorage.removeItem.bind(a.localStorage);
      Object.defineProperty(a.localStorage, "removeItem", {
        value: (key: string) => {
          if (key === pendingKey)
            throw new Error("local acknowledgement unavailable");
          remove(key);
        },
      });
      await expect(
        a.bridge.writeStoredStewardToken("sealed-token"),
      ).rejects.toThrow();
      const marker = a.localStorage.getItem(pendingKey);
      if (marker === null) throw new Error("Missing recovery identity");
      if (scenario === "newer-owner")
        await rpc.secureStoreSet({
          kind: "session.steward_token",
          value: scopedToken("other-session"),
        });
      let failInspection = scenario === "lost-inspection";
      const operations: string[] = [];
      const b = realm(
        rpc,
        async (operation) => {
          operations.push(operation);
          if (operation === "inspect" && scenario === "scope-changes")
            b.bridge.configureStoredStewardTokenScope("https://api.eliza.app");
          if (operation === "inspect" && failInspection) {
            failInspection = false;
            throw new Error("lost inspection reply");
          }
        },
        true,
        true,
      );
      b.localStorage.setItem(pendingKey, marker);
      if (scenario === "conflicting-markers")
        b.localStorage.setItem(
          "eliza:protected-storage-pending:steward_session_token",
          randomUUID(),
        );
      if (scenario === "different-scope")
        b.bridge.configureStoredStewardTokenScope("https://api.eliza.app");
      await b.bridge.initializeStorageBridge();
      if (scenario === "lost-inspection") {
        expect(b.bridge.readStoredStewardToken()).toBeNull();
        expect(b.localStorage.getItem(pendingKey)).toBe(marker);
        await b.bridge.initializeStorageBridge();
      }
      expect(b.bridge.readStoredStewardToken()).toBe(
        scenario === "same-scope" || scenario === "lost-inspection"
          ? "sealed-token"
          : null,
      );
      expect(b.rawGetItem("steward_session_token")).toBeNull();
      expect(b.localStorage.getItem(pendingKey)).toBe(
        ["newer-owner", "scope-changes", "conflicting-markers"].includes(
          scenario,
        )
          ? marker
          : null,
      );
      expect(
        operations.every((operation) =>
          ["inspect", "read", "secureStoreGet"].includes(operation),
        ),
      ).toBe(true);
      expect(
        await rpc.secureStoreGet({ kind: "session.steward_token" }),
      ).toEqual({
        ok: true,
        value: scopedToken(
          scenario === "newer-owner" ? "other-session" : "sealed-token",
        ),
      });
    },
  );

  it("restores the owned rollback result after cancellation and a renderer restart", async () => {
    const controller = new AbortController();
    const rpc = await setup();
    await rpc.secureStoreSet({
      kind: "session.steward_token",
      value: scopedToken("predecessor"),
    });
    const a = realm(
      rpc,
      async (operation) => {
        if (operation === "commit") controller.abort();
      },
      true,
      true,
    );
    await a.bridge.initializeStorageBridge();
    a.localStorage.setItem(
      "steward_session_token_scope",
      "eliza-cloud:staging",
    );
    await expect(
      a.bridge.writeStoredStewardToken("cancelled-token", {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    const pendingKey = "eliza:steward-token-pending-write";
    const operationId = a.localStorage.getItem(pendingKey);
    if (operationId === null) throw new Error("Missing recovery identity");
    const b = realm(rpc, undefined, true, true);
    b.localStorage.setItem(pendingKey, operationId);
    await b.bridge.initializeStorageBridge();
    expect(b.bridge.readStoredStewardToken()).toBe("predecessor");
    expect(b.localStorage.getItem(pendingKey)).toBeNull();
    expect(await rpc.secureStoreGet({ kind: "session.steward_token" })).toEqual(
      { ok: true, value: scopedToken("predecessor") },
    );
  });

  it.each(["steward_session_token", key])(
    "retains the native operation identity for recovery of interrupted %s publication",
    async (storageKey) => {
      const rpc = await setup();
      const isToken = storageKey === "steward_session_token";
      const pendingKey = isToken
        ? "eliza:steward-token-pending-write"
        : `eliza:protected-storage-pending:${storageKey}`;
      const a = realm(rpc, undefined, true, true);
      await a.bridge.initializeStorageBridge();
      const remove = a.localStorage.removeItem.bind(a.localStorage);
      Object.defineProperty(a.localStorage, "removeItem", {
        value: (target: string) => {
          if (target === pendingKey)
            throw new Error("renderer acknowledgement unavailable");
          remove(target);
        },
      });
      await expect(
        a.bridge.setStorageValue(storageKey, "owned-candidate", {
          revalidate() {},
        }),
      ).rejects.toThrow();
      const operationId = a.localStorage.getItem(pendingKey);
      expect(operationId).not.toBeNull();
      if (operationId === null) throw new Error("interruption marker missing");
      // A restarted renderer has only this non-secret marker. It must identify
      // the native receipt, not an unrelated renderer-only UUID.
      const lookup = await rpc.secureStoreTransaction({
        operation: "lookup",
        kind: isToken ? "session.steward_token" : kind,
        operationId,
      });
      expect(lookup).toMatchObject({
        operation: "lookup",
        receipt: { operationId, state: "sealed" },
      });
      const restarted = realm(rpc, undefined, true, true);
      restarted.localStorage.setItem(pendingKey, operationId);
      restarted.localStorage.setItem(
        "steward_session_token_scope",
        "eliza-cloud:production",
      );
      await restarted.bridge.initializeStorageBridge();
      expect(restarted.localStorage.getItem(pendingKey)).toBeNull();
      expect(restarted.localStorage.getItem(storageKey)).toBe(
        "owned-candidate",
      );
      if (isToken) {
        expect(restarted.bridge.readStoredStewardToken()).toBe(
          "owned-candidate",
        );
        expect(restarted.rawGetItem(storageKey)).toBeNull();
      }
    },
  );

  it("routes awaited legacy token writes through canonical native publication without plaintext persistence", async () => {
    const rpc = await setup();
    const a = realm(rpc, undefined, true, true);
    await a.bridge.initializeStorageBridge();
    await a.bridge.setStorageValue("steward_session_token", "awaited-token");
    expect(a.rawGetItem("steward_session_token")).toBeNull();
    expect(a.localStorage.getItem("steward_session_token")).toBe(
      "awaited-token",
    );
    expect(a.bridge.readStoredStewardToken()).toBe("awaited-token");
    expect(await a.bridge.getStorageValue("steward_session_token")).toBe(
      "awaited-token",
    );
    expect(await rpc.secureStoreGet({ kind: "session.steward_token" })).toEqual(
      {
        ok: true,
        value: scopedToken("awaited-token"),
      },
    );
  });

  it("does not publish a token when the native transaction boundary rejects an awaited write", async () => {
    const rpc = await setup();
    const a = realm(rpc, undefined, false, true);
    await a.bridge.initializeStorageBridge();
    await expect(
      a.bridge.setStorageValue("steward_session_token", "refused-token"),
    ).rejects.toThrow();
    expect(a.rawGetItem("steward_session_token")).toBeNull();
    expect(a.bridge.readStoredStewardToken()).toBeNull();
    expect(await rpc.secureStoreGet({ kind: "session.steward_token" })).toEqual(
      {
        ok: false,
        reason: "not_found",
      },
    );
  });

  it("withholds synchronous legacy token writes until native acknowledgement", async () => {
    const rpc = await setup();
    const entered = deferred();
    const released = deferred();
    const a = realm(
      rpc,
      async (operation) => {
        if (operation === "commit") {
          entered.resolve();
          await released.promise;
        }
      },
      true,
      true,
    );
    await a.bridge.initializeStorageBridge();
    a.localStorage.setItem("steward_session_token", "synchronous-token");
    await entered.promise;
    try {
      expect(a.rawGetItem("steward_session_token")).toBeNull();
      expect(a.bridge.readStoredStewardToken()).toBeNull();
    } finally {
      released.resolve();
    }
    await expect
      .poll(() => a.bridge.readStoredStewardToken())
      .toBe("synchronous-token");
    expect(await rpc.secureStoreGet({ kind: "session.steward_token" })).toEqual(
      {
        ok: true,
        value: scopedToken("synchronous-token"),
      },
    );
  });

  it("preserves the caller's native capture when canonical token persistence starts after another selection", async () => {
    const rpc = await setup();
    const a = realm(rpc, undefined, true, true);
    await a.bridge.initializeStorageBridge();
    const nativeAuthority = await a.bridge.captureStorageMutationAuthority(
      () => {},
    );
    await rpc.secureStoreSet({ kind, value: "newer-selection" });
    // Hydration must not silently replace the earlier workflow's baseline.
    expect(await a.bridge.getStorageValue(key)).toBe("newer-selection");
    await expect(
      a.bridge.setStorageValue("steward_session_token", "stale-token", {
        nativeAuthority,
      }),
    ).rejects.toThrow();
    expect(a.bridge.readStoredStewardToken()).toBeNull();
    expect(await rpc.secureStoreGet({ kind: "session.steward_token" })).toEqual(
      {
        ok: false,
        reason: "not_found",
      },
    );
  });

  it("advances the caller's native capture only for its acknowledged token publication", async () => {
    const rpc = await setup();
    const a = realm(rpc, undefined, true, true);
    await a.bridge.initializeStorageBridge();
    const nativeAuthority = await a.bridge.captureStorageMutationAuthority(
      () => {},
    );
    await a.bridge.setStorageValue("steward_session_token", "owned-token", {
      nativeAuthority,
    });
    await nativeAuthority.assertCurrent();
    await a.bridge.setStorageValue(key, "owned-selection", {
      nativeAuthority,
      revalidate() {},
    });
    await nativeAuthority.assertCurrent();
    expect(a.bridge.readStoredStewardToken()).toBe("owned-token");
  });

  it("cancels the actual Steward client during native seal persistence without publishing a session", async () => {
    const controller = new AbortController();
    let armed = false;
    const rpc = await setup((value) => {
      if (armed && value.includes('"state":"sealed"')) controller.abort();
    });
    await rpc.secureStoreSet({
      kind: "session.steward_token",
      value: "previous-session",
    });
    const a = realm(rpc, undefined, true, true);
    await a.bridge.initializeStorageBridge();
    armed = true;
    await expect(
      a.bridge.writeStoredStewardToken("cancelled-session", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "StewardSessionAuthorityError" });
    expect(await rpc.secureStoreGet({ kind: "session.steward_token" })).toEqual(
      { ok: true, value: "previous-session" },
    );
    expect(a.bridge.readStoredStewardToken()).toBeNull();
  });

  it.each(["seal", "lookup"])(
    "does not undo a published Steward session after cancellation during %s acknowledgement recovery",
    async (cancelAt) => {
      const controller = new AbortController();
      const rpc = await setup();
      let lost = false;
      const a = realm(
        rpc,
        async (operation) => {
          if (operation === "seal" && cancelAt === "lookup" && !lost) {
            lost = true;
            throw new Error("lost seal reply");
          }
          if (operation === cancelAt) controller.abort();
        },
        true,
        true,
      );
      await a.bridge.initializeStorageBridge();
      await expect(
        a.bridge.writeStoredStewardToken("published-session", {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "StewardSessionAuthorityError" });
      expect(
        await rpc.secureStoreGet({ kind: "session.steward_token" }),
      ).toEqual({ ok: true, value: scopedToken("published-session") });
      expect(a.bridge.readStoredStewardToken()).toBeNull();
    },
  );

  it("keeps the Steward mirror unavailable while native publication is provisional", async () => {
    const rpc = await setup();
    await rpc.secureStoreSet({
      kind: "session.steward_token",
      value: "predecessor",
    });
    const entered = deferred();
    const released = deferred();
    const a = realm(
      rpc,
      async (operation) => {
        if (operation === "commit") {
          entered.resolve();
          await released.promise;
        }
      },
      true,
      true,
    );
    await a.bridge.initializeStorageBridge();
    const write = a.bridge.writeStoredStewardToken("verified-successor");
    await entered.promise;
    try {
      expect(a.bridge.readStoredStewardToken()).toBeNull();
    } finally {
      released.resolve();
    }
    await write;
    expect(a.bridge.readStoredStewardToken()).toBe("verified-successor");
  });

  it("quarantines a sealed Steward token when local scope publication fails instead of restoring native history", async () => {
    const rpc = await setup();
    const a = realm(rpc, undefined, true, true);
    await a.bridge.initializeStorageBridge();
    a.bridge.configureStoredStewardTokenScope("https://api.eliza.app");
    await a.bridge.writeStoredStewardToken("production-session");
    const b = realm(rpc, undefined, true, true);
    b.bridge.configureStoredStewardTokenScope("https://api.eliza.app");
    b.localStorage.setItem(
      "steward_session_token_scope",
      "eliza-cloud:production",
    );
    await b.bridge.initializeStorageBridge();
    expect(b.bridge.readStoredStewardToken()).toBe("production-session");
    a.bridge.configureStoredStewardTokenScope("https://api-staging.eliza.app");
    const set = a.localStorage.setItem.bind(a.localStorage);
    Object.defineProperty(a.localStorage, "setItem", {
      value: (key: string, value: string) => {
        if (
          key === "steward_session_token_scope" &&
          value === "eliza-cloud:staging"
        )
          throw new Error("scope unavailable");
        set(key, value);
      },
    });
    await expect(
      a.bridge.writeStoredStewardToken("staging-session"),
    ).rejects.toMatchObject({ name: "StewardTokenPersistenceError" });
    expect(a.bridge.readStoredStewardToken()).toBeNull();
    expect(await a.bridge.getStorageValue("steward_session_token")).toBeNull();
    expect(await rpc.secureStoreGet({ kind: "session.steward_token" })).toEqual(
      { ok: true, value: scopedToken("staging-session") },
    );
    expect(a.localStorage.getItem("steward_session_token_scope")).toBe(
      "eliza-cloud:production",
    );
    expect(await b.bridge.getStorageValue("steward_session_token")).toBeNull();
    expect(b.bridge.readStoredStewardToken()).toBeNull();
    const reloaded = realm(rpc, undefined, true, true);
    reloaded.bridge.configureStoredStewardTokenScope("https://api.eliza.app");
    reloaded.localStorage.setItem(
      "steward_session_token_scope",
      "eliza-cloud:production",
    );
    await reloaded.bridge.initializeStorageBridge();
    expect(reloaded.localStorage.getItem("steward_session_token")).toBeNull();
    expect(reloaded.bridge.readStoredStewardToken()).toBeNull();
  });

  it("publishes the actual Steward client token and configured scope after native acknowledgement", async () => {
    const rpc = await setup();
    const a = realm(rpc, undefined, true, true);
    await a.bridge.initializeStorageBridge();
    a.bridge.configureStoredStewardTokenScope("https://api-staging.eliza.app");
    await a.bridge.writeStoredStewardToken("owned-steward-token");
    expect(a.bridge.readStoredStewardToken()).toBe("owned-steward-token");
    expect(await rpc.secureStoreGet({ kind: "session.steward_token" })).toEqual(
      { ok: true, value: scopedToken("owned-steward-token") },
    );
    expect(a.localStorage.getItem("steward_session_token_scope")).toBe(
      "eliza-cloud:staging",
    );
  });

  it("does not restore an old Steward token over another context after cancellation", async () => {
    const rpc = await setup();
    await rpc.secureStoreSet({
      kind: "session.steward_token",
      value: "predecessor",
    });
    const entered = deferred();
    const released = deferred();
    let held = false;
    const controller = new AbortController();
    const a = realm(
      rpc,
      async (operation) => {
        if (
          !held &&
          (operation === "secureStoreSet" || operation === "commit")
        ) {
          held = true;
          entered.resolve();
          await released.promise;
        }
      },
      true,
      true,
    );
    await a.bridge.initializeStorageBridge();
    const result = a.bridge
      .writeStoredStewardToken("abandoned", { signal: controller.signal })
      .then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      );
    await entered.promise;
    try {
      // An independently acknowledged host writer wins before A's cancellation.
      await rpc.secureStoreSet({
        kind: "session.steward_token",
        value: scopedToken("newer-owner"),
      });
      controller.abort();
    } finally {
      released.resolve();
    }
    expect((await result).ok).toBe(false);
    expect(await rpc.secureStoreGet({ kind: "session.steward_token" })).toEqual(
      { ok: true, value: scopedToken("newer-owner") },
    );
    expect(a.bridge.readStoredStewardToken()).toBeNull();
  });
  it("does not infer an environment for an existing unscoped desktop token", async () => {
    const rpc = await setup();
    await rpc.secureStoreSet({
      kind: "session.steward_token",
      value: "legacy-unscoped",
    });
    const a = realm(rpc, undefined, true, true);
    a.localStorage.setItem(
      "steward_session_token_scope",
      "eliza-cloud:staging",
    );
    await a.bridge.initializeStorageBridge();
    expect(a.bridge.readStoredStewardToken()).toBeNull();
    expect(await a.bridge.getStorageValue("steward_session_token")).toBeNull();
    expect(a.localStorage.getItem("steward_session_token")).toBeNull();
    expect(await rpc.secureStoreGet({ kind: "session.steward_token" })).toEqual(
      { ok: true, value: "legacy-unscoped" },
    );
  });

  it("rejects a Steward write when its already-observed native token is stale", async () => {
    const rpc = await setup();
    await rpc.secureStoreSet({
      kind: "session.steward_token",
      value: "observed-owner",
    });
    const a = realm(rpc, undefined, true, true);
    await a.bridge.initializeStorageBridge();
    await rpc.secureStoreSet({
      kind: "session.steward_token",
      value: "different-owner",
    });
    await expect(
      a.bridge.writeStoredStewardToken("stale-login"),
    ).rejects.toThrow();
    expect(await rpc.secureStoreGet({ kind: "session.steward_token" })).toEqual(
      { ok: true, value: "different-owner" },
    );
  });
  it.each(["prepare", "seal"])(
    "reconciles cancellation arriving during lost-%s acknowledgement lookup",
    async (lostOperation) => {
      const controller = new AbortController();
      const rpc = await setup();
      let lost = false;
      const a = realm(rpc, async (operation) => {
        if (operation === lostOperation && !lost) {
          lost = true;
          throw new Error("lost operation reply");
        }
        if (operation === "lookup") controller.abort();
      });
      await a.bridge.initializeStorageBridge();
      await expect(
        a.bridge.setStorageValue(key, "operation-value", {
          revalidate() {},
          signal: controller.signal,
        }),
      ).rejects.toMatchObject(
        lostOperation === "seal"
          ? { code: "NATIVE_STORE_ALREADY_PUBLISHED" }
          : { name: "AbortError" },
      );
      expect(await rpc.secureStoreGet({ kind })).toEqual({
        ok: true,
        value: lostOperation === "seal" ? "operation-value" : "original",
      });
      expect(a.localStorage.getItem(key)).toBeNull();
    },
  );

  it("keeps an unacknowledged cancellation unavailable instead of reporting success", async () => {
    const controller = new AbortController();
    const rpc = await setup();
    const a = realm(rpc, async (operation) => {
      if (operation === "commit") controller.abort();
      if (operation === "cancel") throw new Error("lost cancellation reply");
    });
    await a.bridge.initializeStorageBridge();
    await expect(
      a.bridge.setStorageValue(key, "cancelled-value", {
        revalidate() {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "NATIVE_STORE_TRANSPORT_UNAVAILABLE" });
    expect(await rpc.secureStoreGet({ kind })).toEqual({
      ok: true,
      value: "original",
    });
    expect(a.localStorage.getItem(key)).toBeNull();
  });
  it("sends cancellation to the host while seal is awaiting native payload persistence", async () => {
    const controller = new AbortController();
    const rpc = await setup((value) => {
      if (value.includes('"state":"sealed"')) controller.abort();
    });
    const a = realm(rpc);
    await a.bridge.initializeStorageBridge();
    const nativeAuthority = await a.bridge.captureStorageMutationAuthority(
      () => {},
    );
    await expect(
      a.bridge.setStorageValue(key, "cancelled-during-native-write", {
        revalidate() {},
        nativeAuthority,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await rpc.secureStoreGet({ kind })).toEqual({
      ok: true,
      value: "original",
    });
    expect(a.localStorage.getItem(key)).toBeNull();
  });

  it("reports already-published cancellation without undoing the acknowledged native value", async () => {
    const controller = new AbortController();
    const rpc = await setup();
    const a = realm(rpc, async (operation) => {
      if (operation === "seal") controller.abort();
    });
    await a.bridge.initializeStorageBridge();
    await expect(
      a.bridge.setStorageValue(key, "already-published", {
        revalidate() {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "NATIVE_STORE_ALREADY_PUBLISHED" });
    expect(await rpc.secureStoreGet({ kind })).toEqual({
      ok: true,
      value: "already-published",
    });
  });
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
