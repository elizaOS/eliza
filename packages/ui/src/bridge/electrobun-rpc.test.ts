/**
 * Verifies the electrobun renderer→main bridge helpers against a recording
 * fake installed at window.__ELIZA_ELECTROBUN_RPC__ (jsdom, deterministic,
 * no native host): RPC discovery, request routing + param shaping, the
 * timeout race outcomes, and the event subscribe/unsubscribe lifecycle.
 */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_LAUNCHER_WINDOW_PATH,
  type DynamicViewManifest,
  desktopOpenPath,
  desktopSecureStoreDelete,
  desktopSecureStoreGet,
  desktopSecureStoreSet,
  desktopShowItemInFolder,
  type ElectrobunMessageListener,
  type ElectrobunRendererRpc,
  getDesktopRuntimeMode,
  getElectrobunRendererRpc,
  inspectExistingElizaInstall,
  invokeDesktopBridgeRequest,
  invokeDesktopBridgeRequestWithTimeout,
  migrateDesktopStateDir,
  openDesktopAppWindow,
  openDesktopLauncherWindow,
  pickDesktopWorkspaceFolder,
  registerDynamicView,
  releaseDesktopWorkspaceFolderBookmarks,
  resolveDesktopWorkspaceFolderBookmark,
  scanProviderCredentials,
  setDesktopBottomBarSurfaceState,
  subscribeDesktopBridgeEvent,
  unregisterDynamicView,
} from "./electrobun-rpc";

interface BridgeCall {
  method: string;
  params?: unknown;
}

interface BridgeHarness {
  request: Record<string, (params?: unknown) => Promise<unknown>>;
  calls: BridgeCall[];
  onMessage: ReturnType<typeof vi.fn>;
  offMessage: ReturnType<typeof vi.fn>;
  rpc: ElectrobunRendererRpc;
  /** Register a handler that records its invocation and responds. */
  handle(method: string, respond?: (params?: unknown) => unknown): void;
}

function createBridgeHarness(): BridgeHarness {
  const calls: BridgeCall[] = [];
  const request: Record<string, (params?: unknown) => Promise<unknown>> = {};
  const onMessage = vi.fn();
  const offMessage = vi.fn();
  const rpc: ElectrobunRendererRpc = { request, onMessage, offMessage };
  return {
    request,
    calls,
    onMessage,
    offMessage,
    rpc,
    handle(method, respond) {
      request[method] = async (params?: unknown) => {
        calls.push({ method, params });
        return respond ? respond(params) : undefined;
      };
    },
  };
}

function installOnWindow(rpc: ElectrobunRendererRpc): void {
  (
    window as { __ELIZA_ELECTROBUN_RPC__?: ElectrobunRendererRpc }
  ).__ELIZA_ELECTROBUN_RPC__ = rpc;
}

function uninstallFromWindow(): void {
  delete (window as { __ELIZA_ELECTROBUN_RPC__?: unknown })
    .__ELIZA_ELECTROBUN_RPC__;
}

afterEach(() => {
  uninstallFromWindow();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("getElectrobunRendererRpc", () => {
  it("returns the rpc the host installed on window", () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    expect(getElectrobunRendererRpc()).toBe(harness.rpc);
  });

  it("returns undefined when the window has no bridge installed", () => {
    expect(getElectrobunRendererRpc()).toBeUndefined();
  });

  it("returns undefined when there is no window at all", () => {
    const saved = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = undefined;
    try {
      expect(getElectrobunRendererRpc()).toBeUndefined();
    } finally {
      (globalThis as { window?: unknown }).window = saved;
    }
  });
});

describe("invokeDesktopBridgeRequest", () => {
  it("awaits the registered handler and returns its value", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("credentialsScanProviders", () => ({
      providers: [{ id: "openai", source: "env", cliInstalled: true }],
    }));

    await expect(
      invokeDesktopBridgeRequest<{ providers: unknown[] }>({
        rpcMethod: "credentialsScanProviders",
        ipcChannel: "credentials:scanProviders",
        params: { context: "first-run" },
      }),
    ).resolves.toEqual({
      providers: [{ id: "openai", source: "env", cliInstalled: true }],
    });
  });

  it("passes params to the registered handler", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("secureStoreSet");

    await invokeDesktopBridgeRequest({
      rpcMethod: "secureStoreSet",
      ipcChannel: "secureStore:set",
      params: { kind: "runtime.active_server", value: "http://localhost:3000" },
    });

    expect(harness.calls).toEqual([
      {
        method: "secureStoreSet",
        params: {
          kind: "runtime.active_server",
          value: "http://localhost:3000",
        },
      },
    ]);
  });

  it("returns null when no bridge is installed", async () => {
    await expect(
      invokeDesktopBridgeRequest({ rpcMethod: "anything", ipcChannel: "any" }),
    ).resolves.toBeNull();
  });

  it("returns null when the requested method is not on the bridge", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("otherMethod");

    await expect(
      invokeDesktopBridgeRequest({
        rpcMethod: "missingMethod",
        ipcChannel: "x",
      }),
    ).resolves.toBeNull();
    expect(harness.calls).toEqual([]);
  });

  it("propagates a rejecting handler instead of converting it to null", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("boom", () => {
      throw new Error("native crashed");
    });

    await expect(
      invokeDesktopBridgeRequest({ rpcMethod: "boom", ipcChannel: "x" }),
    ).rejects.toThrow("native crashed");
  });
});

describe("invokeDesktopBridgeRequestWithTimeout", () => {
  it("returns missing when no bridge is installed", async () => {
    await expect(
      invokeDesktopBridgeRequestWithTimeout({
        rpcMethod: "anything",
        ipcChannel: "any",
        timeoutMs: 50,
      }),
    ).resolves.toEqual({ status: "missing" });
  });

  it("returns missing when the requested method is absent", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);

    await expect(
      invokeDesktopBridgeRequestWithTimeout({
        rpcMethod: "missing",
        ipcChannel: "x",
        timeoutMs: 50,
      }),
    ).resolves.toEqual({ status: "missing" });
  });

  it("returns the resolved value tagged ok", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    const payload = { ok: true, value: "stored" };
    harness.handle("secureStoreGet", () => payload);

    await expect(
      invokeDesktopBridgeRequestWithTimeout({
        rpcMethod: "secureStoreGet",
        ipcChannel: "secureStore:get",
        params: { kind: "session.steward_token" },
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({ status: "ok", value: payload });
  });

  it("preserves the rejection error tagged rejected", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    const failure = new Error("bridge wedged");
    harness.handle("secureStoreGet", () => {
      throw failure;
    });

    await expect(
      invokeDesktopBridgeRequestWithTimeout({
        rpcMethod: "secureStoreGet",
        ipcChannel: "secureStore:get",
        params: { kind: "session.steward_token" },
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({ status: "rejected", error: failure });
  });

  it("returns timeout when the handler never settles", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("wedged", () => new Promise(() => {}));

    await expect(
      invokeDesktopBridgeRequestWithTimeout({
        rpcMethod: "wedged",
        ipcChannel: "test:wedged",
        timeoutMs: 15,
      }),
    ).resolves.toEqual({ status: "timeout" });
  });

  it("still reports ok when the handler finishes faster than the timeout", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle(
      "slowButAlive",
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve("done"), 5);
        }),
    );

    await expect(
      invokeDesktopBridgeRequestWithTimeout({
        rpcMethod: "slowButAlive",
        ipcChannel: "test:slow",
        timeoutMs: 5000,
      }),
    ).resolves.toEqual({ status: "ok", value: "done" });
  });
});

describe("desktopSecureStore helpers", () => {
  it("routes get to secureStoreGet with the kind param", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("secureStoreGet", () => ({ ok: true, value: "v" }));

    await expect(desktopSecureStoreGet("session.device_auth")).resolves.toEqual(
      { ok: true, value: "v" },
    );
    expect(harness.calls).toEqual([
      { method: "secureStoreGet", params: { kind: "session.device_auth" } },
    ]);
  });

  it("routes set to secureStoreSet with kind and value", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("secureStoreSet", () => ({ ok: true }));

    await expect(
      desktopSecureStoreSet("session.steward_token", "tok"),
    ).resolves.toEqual({ ok: true });
    expect(harness.calls).toEqual([
      {
        method: "secureStoreSet",
        params: { kind: "session.steward_token", value: "tok" },
      },
    ]);
  });

  it("routes delete to secureStoreDelete and surfaces deleted", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("secureStoreDelete", () => ({ ok: true, deleted: true }));

    await expect(
      desktopSecureStoreDelete("runtime.agent_profiles"),
    ).resolves.toEqual({ ok: true, deleted: true });
    expect(harness.calls).toEqual([
      {
        method: "secureStoreDelete",
        params: { kind: "runtime.agent_profiles" },
      },
    ]);
  });

  it("return null for all three when the bridge is missing", async () => {
    await expect(
      desktopSecureStoreGet("session.device_auth"),
    ).resolves.toBeNull();
    await expect(
      desktopSecureStoreSet("session.device_auth", "x"),
    ).resolves.toBeNull();
    await expect(
      desktopSecureStoreDelete("session.device_auth"),
    ).resolves.toBeNull();
  });
});

describe("provider credential scan", () => {
  it("returns the providers reported by the bridge", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("credentialsScanProviders", () => ({
      providers: [
        { id: "anthropic", source: "keychain", cliInstalled: false },
        { id: "openai", source: "env", cliInstalled: true },
      ],
    }));

    expect(await scanProviderCredentials()).toEqual([
      { id: "anthropic", source: "keychain", cliInstalled: false },
      { id: "openai", source: "env", cliInstalled: true },
    ]);
    expect(harness.calls).toEqual([
      {
        method: "credentialsScanProviders",
        params: { context: "first-run" },
      },
    ]);
  });

  it("returns an empty list when the bridge is missing", async () => {
    expect(await scanProviderCredentials()).toEqual([]);
  });

  it("returns an empty list when the result carries no providers field", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("credentialsScanProviders", () => ({}));

    expect(await scanProviderCredentials()).toEqual([]);
  });
});

describe("dynamic view registry helpers", () => {
  const manifest: DynamicViewManifest = {
    id: "notes-panel",
    title: "Notes",
    source: "plugin",
    entrypoint: "https://plugins.test/notes",
    placement: "panel",
  };

  it("registers with update defaulting to false", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("dynamicViewRegister", () => manifest);

    await expect(registerDynamicView(manifest)).resolves.toEqual(manifest);
    expect(harness.calls).toEqual([
      { method: "dynamicViewRegister", params: { manifest, update: false } },
    ]);
  });

  it("forwards update=true only when explicitly requested", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("dynamicViewRegister", () => manifest);

    await registerDynamicView(manifest, { update: true });
    expect(harness.calls).toEqual([
      { method: "dynamicViewRegister", params: { manifest, update: true } },
    ]);

    harness.calls.length = 0;
    await registerDynamicView(manifest, {});
    expect(harness.calls).toEqual([
      { method: "dynamicViewRegister", params: { manifest, update: false } },
    ]);
  });

  it("returns null from register when the bridge is missing", async () => {
    await expect(registerDynamicView(manifest)).resolves.toBeNull();
  });

  it("unregisters by viewId and returns the removed flag", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("dynamicViewUnregister", () => ({ removed: true }));

    await expect(unregisterDynamicView("notes-panel")).resolves.toEqual({
      removed: true,
    });
    expect(harness.calls).toEqual([
      { method: "dynamicViewUnregister", params: { viewId: "notes-panel" } },
    ]);
  });
});

describe("desktop window and path helpers", () => {
  it("opens an app window and coerces alwaysOnTop to a boolean", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("desktopOpenAppWindow", () => ({ id: "win-7" }));

    await expect(
      openDesktopAppWindow({ slug: "chat", title: "Chat", path: "/chat" }),
    ).resolves.toEqual({ id: "win-7" });
    expect(harness.calls).toEqual([
      {
        method: "desktopOpenAppWindow",
        params: {
          slug: "chat",
          title: "Chat",
          path: "/chat",
          alwaysOnTop: false,
        },
      },
    ]);

    harness.calls.length = 0;
    await openDesktopAppWindow({
      slug: "chat",
      title: "Chat",
      path: "/chat",
      alwaysOnTop: true,
    });
    expect(harness.calls[0]?.params).toMatchObject({ alwaysOnTop: true });
  });

  it("summons the launcher at the fixed views route", async () => {
    expect(DESKTOP_LAUNCHER_WINDOW_PATH).toBe("/views");
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("desktopOpenAppWindow", () => ({ id: "launcher-1" }));

    await expect(openDesktopLauncherWindow()).resolves.toEqual({
      id: "launcher-1",
    });
    expect(harness.calls).toEqual([
      {
        method: "desktopOpenAppWindow",
        params: {
          slug: "launcher",
          title: "Launcher",
          path: "/views",
          alwaysOnTop: false,
        },
      },
    ]);
  });

  it("opens a path and passes it through untouched", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("desktopOpenPath");

    await expect(desktopOpenPath("/tmp/report.pdf")).resolves.toBeUndefined();
    expect(harness.calls).toEqual([
      { method: "desktopOpenPath", params: { path: "/tmp/report.pdf" } },
    ]);
  });

  it("shows an item in folder with the given path", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("desktopShowItemInFolder");

    await expect(
      desktopShowItemInFolder("/downloads/a.png"),
    ).resolves.toBeUndefined();
    expect(harness.calls).toEqual([
      {
        method: "desktopShowItemInFolder",
        params: { path: "/downloads/a.png" },
      },
    ]);
  });

  it("sets the bottom bar surface state verbatim", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("desktopSetBottomBarSurfaceState");

    await expect(
      setDesktopBottomBarSurfaceState("OPEN_HALF_OR_OVER"),
    ).resolves.toBeUndefined();
    expect(harness.calls).toEqual([
      {
        method: "desktopSetBottomBarSurfaceState",
        params: { state: "OPEN_HALF_OR_OVER" },
      },
    ]);
  });
});

describe("workspace folder and runtime-mode helpers", () => {
  it("picks a workspace folder, sending empty params when no options", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("desktopPickWorkspaceFolder", () => ({
      canceled: false,
      path: "/work/eliza",
      bookmark: "bm-1",
    }));

    await expect(pickDesktopWorkspaceFolder()).resolves.toEqual({
      canceled: false,
      path: "/work/eliza",
      bookmark: "bm-1",
    });
    expect(harness.calls).toEqual([
      { method: "desktopPickWorkspaceFolder", params: {} },
    ]);
  });

  it("forwards picker options as params", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("desktopPickWorkspaceFolder", () => ({
      canceled: true,
      path: "",
      bookmark: null,
    }));

    await pickDesktopWorkspaceFolder({
      defaultPath: "/work",
      promptTitle: "Choose project",
    });
    expect(harness.calls).toEqual([
      {
        method: "desktopPickWorkspaceFolder",
        params: { defaultPath: "/work", promptTitle: "Choose project" },
      },
    ]);
  });

  it("inspects the existing install with no params", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("agentInspectExistingInstall", () => ({
      found: true,
      path: "/eliza",
    }));

    await expect(inspectExistingElizaInstall()).resolves.toEqual({
      found: true,
      path: "/eliza",
    });
    expect(harness.calls).toEqual([
      { method: "agentInspectExistingInstall", params: undefined },
    ]);
  });

  it("migrates the state dir from the given source path", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("agentMigrateStateDir", () => ({
      ok: true,
      migrated: true,
      fromPath: "/old",
      toPath: "/new",
    }));

    await expect(migrateDesktopStateDir("/old")).resolves.toEqual({
      ok: true,
      migrated: true,
      fromPath: "/old",
      toPath: "/new",
    });
    expect(harness.calls).toEqual([
      { method: "agentMigrateStateDir", params: { fromPath: "/old" } },
    ]);
  });

  it("resolves a workspace bookmark and releases all bookmarks", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("desktopResolveWorkspaceFolderBookmark", () => ({
      ok: true,
      path: "/work/eliza",
    }));
    harness.handle("desktopReleaseWorkspaceFolderBookmarks", () => ({
      ok: true,
    }));

    await expect(
      resolveDesktopWorkspaceFolderBookmark("bm-9"),
    ).resolves.toEqual({ ok: true, path: "/work/eliza" });
    await expect(releaseDesktopWorkspaceFolderBookmarks()).resolves.toEqual({
      ok: true,
    });
    expect(harness.calls).toEqual([
      {
        method: "desktopResolveWorkspaceFolderBookmark",
        params: { bookmark: "bm-9" },
      },
      { method: "desktopReleaseWorkspaceFolderBookmarks", params: undefined },
    ]);
  });

  it("reads the runtime mode from the bridge", async () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);
    harness.handle("desktopGetRuntimeMode", () => ({
      mode: "external",
      externalApiBase: "https://api.example.com",
      externalApiSource: "settings",
    }));

    await expect(getDesktopRuntimeMode()).resolves.toEqual({
      mode: "external",
      externalApiBase: "https://api.example.com",
      externalApiSource: "settings",
    });
    expect(harness.calls).toEqual([
      { method: "desktopGetRuntimeMode", params: undefined },
    ]);
  });

  it("returns null for these helpers when the bridge is missing", async () => {
    await expect(pickDesktopWorkspaceFolder()).resolves.toBeNull();
    await expect(inspectExistingElizaInstall()).resolves.toBeNull();
    await expect(migrateDesktopStateDir("/old")).resolves.toBeNull();
    await expect(getDesktopRuntimeMode()).resolves.toBeNull();
  });
});

describe("subscribeDesktopBridgeEvent", () => {
  it("delivers host messages to the listener until unsubscribed", () => {
    const harness = createBridgeHarness();
    installOnWindow(harness.rpc);

    const received: unknown[] = [];
    const listener: ElectrobunMessageListener = (payload) => {
      received.push(payload);
    };
    const unsubscribe = subscribeDesktopBridgeEvent({
      rpcMessage: "agent:event",
      ipcChannel: "agent:event",
      listener,
    });

    expect(harness.onMessage).toHaveBeenCalledOnce();
    const [name, registered] = harness.onMessage.mock.calls[0] as [
      string,
      ElectrobunMessageListener,
    ];
    expect(name).toBe("agent:event");

    registered?.({ type: "tick" });
    expect(received).toEqual([{ type: "tick" }]);

    unsubscribe();
    expect(harness.offMessage).toHaveBeenCalledOnce();
    expect(harness.offMessage.mock.calls[0]).toEqual(["agent:event", listener]);
  });

  it("returns a safe noop subscription when no bridge exists", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeDesktopBridgeEvent({
      rpcMessage: "agent:event",
      ipcChannel: "agent:event",
      listener: (payload) => {
        received.push(payload);
      },
    });

    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
    expect(received).toEqual([]);
  });
});
