/** Exercises a coordinator created before bridge registration through real desktop receipt publication. Only RPC transport and OS credential storage are simulated; the native ledger uses an isolated temporary database. */
// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureStoredStewardTokenScope,
  getStewardTabSessionAuthorityCoordinator,
  readStoredStewardToken,
  replaceStoredStewardTokenIfCurrent,
  resetStewardTabSessionAuthorityCoordinatorForTests,
  STEWARD_PENDING_WRITE_KEY,
  STEWARD_TOKEN_KEY,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import type { RendererSecureTransactionRequest } from "@elizaos/shared/types";
import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";
import { createRendererSecureStoreRpc } from "../../../app-core/platforms/electrobun/src/renderer-secure-store-rpc";
import type { PlatformSecureStore } from "../../../app-core/src/security/platform-secure-store";

const transport = vi.hoisted(() => ({
  request: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "web", isNativePlatform: () => false },
}));
vi.mock("./electrobun-runtime", () => ({ isElectrobunRuntime: () => true }));
vi.mock("./electrobun-rpc", () => ({
  desktopSecureStoreTransaction: transport.request,
  desktopSecureStoreGet: transport.get,
  desktopSecureStoreSet: transport.set,
  desktopSecureStoreDelete: transport.remove,
}));
vi.mock("../surface-realm-channel", () => ({
  runAsPrivilegedShell: (operation: () => unknown) => operation(),
}));

it("replaces a desktop session before proxy initialization without superseding its early-created coordinator", async () => {
  const dom = new JSDOM("", { url: "http://localhost/" });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("localStorage", dom.window.localStorage);
  vi.stubGlobal("sessionStorage", dom.window.sessionStorage);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
  const directory = mkdtempSync(join(tmpdir(), "eliza-session-reader-test-"));
  const values = new Map<string, string>();
  const store: Pick<PlatformSecureStore, "get" | "set"> = {
    get: async (vault, kind) => {
      const value = values.get(JSON.stringify([vault, kind]));
      return value === undefined
        ? { ok: false, reason: "not_found" }
        : { ok: true, value };
    },
    set: async (vault, kind, value) => {
      values.set(JSON.stringify([vault, kind]), value);
      return { ok: true };
    },
  };
  const host = createRendererSecureStoreRpc({
    directory,
    vault: "isolated-session-reader",
    store,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let holdPrepare = false;
  transport.request.mockImplementation(
    async (params: RendererSecureTransactionRequest) => {
      if (holdPrepare && params.operation === "prepare") {
        entered.resolve();
        await release.promise;
      }
      return host.secureStoreTransaction(params);
    },
  );
  transport.get.mockImplementation((kind: string) =>
    host.secureStoreGet({ kind }),
  );
  transport.set.mockImplementation((kind: string, value: string) =>
    host.secureStoreSet({ kind, value }),
  );
  transport.remove.mockImplementation((kind: string) =>
    host.secureStoreDelete({ kind }),
  );

  localStorage.clear();
  sessionStorage.clear();
  resetStewardTabSessionAuthorityCoordinatorForTests();
  configureStoredStewardTokenScope("https://api-staging.eliza.app/api/v1");
  const coordinator = getStewardTabSessionAuthorityCoordinator();
  expect(coordinator.readSnapshot().token).toBeNull();
  let replacement: Promise<boolean> | undefined;
  try {
    const bridge = await import("./storage-bridge");
    expect(bridge.isStorageBridgeInitialized()).toBe(false);
    await writeStoredStewardToken("previous-fixture-owner");
    expect(coordinator.readSnapshot().token).toBe("previous-fixture-owner");
    holdPrepare = true;
    replacement = replaceStoredStewardTokenIfCurrent(
      "previous-fixture-owner",
      "renewed-fixture-owner",
      { expected: coordinator.readSnapshot() },
    );
    await Promise.race([
      entered.promise,
      replacement.then(() => {
        throw new Error(
          "Replacement settled before reaching the held native operation",
        );
      }),
    ]);
    expect(localStorage.getItem(STEWARD_PENDING_WRITE_KEY)).not.toBeNull();
    expect(readStoredStewardToken()).toBeNull();
    expect(coordinator.readSnapshot().token).toBeNull();
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    release.resolve();
    expect(await replacement).toBe(true);
    expect(readStoredStewardToken()).toBe("renewed-fixture-owner");
    expect(coordinator.readSnapshot().token).toBe("renewed-fixture-owner");
    expect(localStorage.getItem(STEWARD_PENDING_WRITE_KEY)).toBeNull();
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    expect(bridge.isStorageBridgeInitialized()).toBe(false);
    const stored = await host.secureStoreGet({ kind: "session.steward_token" });
    expect(stored.ok).toBe(true);
    if (!stored.ok) throw new Error("Expected a durable session record");
    expect(JSON.parse(stored.value)).toMatchObject({
      token: "renewed-fixture-owner",
      scope: "eliza-cloud:staging",
    });
  } finally {
    release.resolve();
    // error-policy:J6 settle the owned fixture before removing its temporary ledger.
    await replacement?.catch(() => undefined);
    resetStewardTabSessionAuthorityCoordinatorForTests();
    localStorage.clear();
    sessionStorage.clear();
    rmSync(directory, { recursive: true, force: true });
    dom.window.close();
    vi.unstubAllGlobals();
  }
});
