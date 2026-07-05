/** Exercises rpc handlers behavior with deterministic app-core test fixtures. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildDynamicViewRpcHandlers,
  buildNotificationRpcHandlers,
  buildWindowRpcHandlers,
} from "./rpc-handler-slices";
import { CHANNEL_TO_RPC_METHOD } from "./rpc-schema";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../../..");

function createDesktopFixture() {
  const desktop = {
    openSettings: vi.fn(),
    openSurfaceWindow: vi.fn(
      async (surface: string, _browse?: string, alwaysOnTop?: boolean) => ({
        id: `${surface}-1`,
        surface,
        title: surface,
        singleton: false,
        alwaysOnTop: alwaysOnTop ?? false,
      }),
    ),
    openAppWindow: vi.fn(
      async (options: {
        slug?: string;
        title: string;
        path: string;
        alwaysOnTop?: boolean;
      }) => ({
        id: "app-1",
        surface: "app" as const,
        singleton: false,
        ...options,
        alwaysOnTop: options.alwaysOnTop ?? false,
      }),
    ),
    setManagedWindowAlwaysOnTop: vi.fn(
      (id: string, flag: boolean) => id === "app-1" && flag === true,
    ),
  };
  return {
    desktop,
    handlers: buildWindowRpcHandlers({
      desktop,
      appName: "Test App",
    }),
  };
}

describe("window RPC handlers", () => {
  it("opens settings with an optional tab hint", async () => {
    const { desktop, handlers } = createDesktopFixture();

    await handlers.desktopOpenSettingsWindow({ tabHint: "voice" });
    await handlers.desktopOpenSettingsWindow(undefined);

    expect(desktop.openSettings).toHaveBeenNthCalledWith(1, "voice");
    expect(desktop.openSettings).toHaveBeenNthCalledWith(2, undefined);
  });

  it("forwards browser surface browse targets and coerces always-on-top", async () => {
    const { desktop, handlers } = createDesktopFixture();

    await expect(
      handlers.desktopOpenSurfaceWindow({
        surface: "browser",
        browse: "https://example.com",
        alwaysOnTop: true,
      }),
    ).resolves.toMatchObject({
      surface: "browser",
      alwaysOnTop: true,
    });

    expect(desktop.openSurfaceWindow).toHaveBeenCalledWith(
      "browser",
      "https://example.com",
      true,
    );
  });

  it("drops browse for non-browser detached surfaces and rejects invalid surfaces", async () => {
    const { desktop, handlers } = createDesktopFixture();

    await expect(
      handlers.desktopOpenSurfaceWindow({
        surface: "chat",
        browse: "https://ignored.example",
        alwaysOnTop: "yes" as never,
      }),
    ).resolves.toMatchObject({
      surface: "chat",
      alwaysOnTop: false,
    });
    await expect(
      handlers.desktopOpenSurfaceWindow({
        surface: "settings" as never,
        browse: "https://ignored.example",
      }),
    ).resolves.toBeNull();

    expect(desktop.openSurfaceWindow).toHaveBeenCalledTimes(1);
    expect(desktop.openSurfaceWindow).toHaveBeenCalledWith(
      "chat",
      undefined,
      false,
    );
  });

  it("normalizes app window slug, title, route path, and always-on-top", async () => {
    const { desktop, handlers } = createDesktopFixture();

    await expect(
      handlers.desktopOpenAppWindow({
        slug: "",
        title: "   ",
        path: " /apps/remote-ledger?mode=edit#row-1 ",
        alwaysOnTop: "true" as never,
      }),
    ).resolves.toMatchObject({
      id: "app-1",
      slug: undefined,
      title: "Test App",
      path: "/apps/remote-ledger?mode=edit#row-1",
      alwaysOnTop: false,
    });
    await handlers.desktopOpenAppWindow({
      slug: "remote-ledger",
      title: " Remote Ledger ",
      path: "/apps/remote-ledger",
      alwaysOnTop: true,
    });

    expect(desktop.openAppWindow).toHaveBeenNthCalledWith(1, {
      slug: undefined,
      title: "Test App",
      path: "/apps/remote-ledger?mode=edit#row-1",
      alwaysOnTop: false,
    });
    expect(desktop.openAppWindow).toHaveBeenNthCalledWith(2, {
      slug: "remote-ledger",
      title: "Remote Ledger",
      path: "/apps/remote-ledger",
      alwaysOnTop: true,
    });
  });

  it.each([
    "https://example.com/app",
    "//example.com/app",
    "   ",
  ])("rejects non-renderer app window paths: %s", async (path) => {
    const { desktop, handlers } = createDesktopFixture();

    await expect(
      handlers.desktopOpenAppWindow({
        title: "Bad Route",
        path,
      }),
    ).rejects.toThrow("desktopOpenAppWindow path must be a renderer route");
    expect(desktop.openAppWindow).not.toHaveBeenCalled();
  });

  it("sets managed app-window always-on-top state through the public RPC handler", async () => {
    const { desktop, handlers } = createDesktopFixture();

    await expect(
      handlers.desktopSetManagedWindowAlwaysOnTop({
        id: "app-1",
        flag: true,
      }),
    ).resolves.toEqual({ success: true });
    await expect(
      handlers.desktopSetManagedWindowAlwaysOnTop({
        id: "missing-window",
        flag: true,
      }),
    ).resolves.toEqual({ success: false });

    expect(desktop.setManagedWindowAlwaysOnTop).toHaveBeenNthCalledWith(
      1,
      "app-1",
      true,
    );
    expect(desktop.setManagedWindowAlwaysOnTop).toHaveBeenNthCalledWith(
      2,
      "missing-window",
      true,
    );
  });
});

describe("notification RPC handlers", () => {
  it("delegates show/close notification requests with exact params", async () => {
    let nextId = 0;
    const desktop = {
      showNotification: vi.fn(async (params) => ({
        id: `notification_${++nextId}`,
        params,
      })),
      closeNotification: vi.fn(async () => undefined),
    };
    const handlers = buildNotificationRpcHandlers({
      desktop,
      fileSystem: {
        existsSync: vi.fn(() => false),
        mkdirSync: vi.fn(),
        writeFileSync: vi.fn(),
      },
      userDataDir: "/tmp/eliza-user-data",
      showNotification: vi.fn(),
    });

    await expect(
      handlers.desktopShowNotification({
        title: "Build finished",
        body: "The desktop build completed.",
        urgency: "critical",
        silent: false,
      }),
    ).resolves.toMatchObject({ id: "notification_1" });
    await expect(
      handlers.desktopShowNotification({
        title: "Low priority",
        body: "No sound.",
        urgency: "low",
        silent: true,
      }),
    ).resolves.toMatchObject({ id: "notification_2" });
    await expect(
      handlers.desktopCloseNotification({ id: "notification_2" }),
    ).resolves.toBeUndefined();

    expect(desktop.showNotification).toHaveBeenNthCalledWith(1, {
      title: "Build finished",
      body: "The desktop build completed.",
      urgency: "critical",
      silent: false,
    });
    expect(desktop.showNotification).toHaveBeenNthCalledWith(2, {
      title: "Low priority",
      body: "No sound.",
      urgency: "low",
      silent: true,
    });
    expect(desktop.closeNotification).toHaveBeenCalledWith({
      id: "notification_2",
    });
  });

  it("routes the background notice through the one-shot marker path", async () => {
    const seen = new Set<string>();
    const fileSystem = {
      existsSync: vi.fn((filePath: string) => seen.has(filePath)),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn((filePath: string) => {
        seen.add(filePath);
      }),
    };
    const showNotification = vi.fn();
    const handlers = buildNotificationRpcHandlers({
      desktop: {
        showNotification: vi.fn(),
        closeNotification: vi.fn(),
      },
      fileSystem,
      userDataDir: "/tmp/eliza-user-data",
      showNotification,
    });

    await expect(handlers.desktopShowBackgroundNotice()).resolves.toEqual({
      shown: true,
    });
    await expect(handlers.desktopShowBackgroundNotice()).resolves.toEqual({
      shown: false,
    });

    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0]?.[0]).toMatchObject({
      title: expect.stringContaining("Still Running"),
      body: expect.stringContaining("running in the background"),
    });
    expect(fileSystem.mkdirSync).toHaveBeenCalledWith("/tmp/eliza-user-data", {
      recursive: true,
    });
    expect(fileSystem.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("keeps renderer notification bridge strings resolvable in the schema", () => {
    expect(CHANNEL_TO_RPC_METHOD["desktop:showNotification"]).toBe(
      "desktopShowNotification",
    );

    for (const relative of [
      "packages/ui/src/state/notifications/notification-store.ts",
      "packages/ui/src/state/useChatLifecycle.ts",
      "packages/app-core/src/runtime/desktop/DesktopTrayRuntime.tsx",
    ]) {
      const source = readFileSync(path.join(REPO_ROOT, relative), "utf8");
      expect(source, relative).toContain(
        'rpcMethod: "desktopShowNotification"',
      );
      expect(source, relative).toContain(
        'ipcChannel: "desktop:showNotification"',
      );
      expect(CHANNEL_TO_RPC_METHOD["desktop:showNotification"]).toBe(
        "desktopShowNotification",
      );
    }
  });
});

describe("dynamic-view RPC handlers", () => {
  it("delegates register, list, open, push, close, unregister, and sessions", async () => {
    const manifest = {
      id: "agent.run.trace",
      title: "Trace",
      source: "agent" as const,
      entrypoint: "trace.html",
      placement: "floating" as const,
    };
    const session = {
      sessionId: "dynamic-view-session-1",
      viewId: manifest.id,
      title: manifest.title,
      placement: manifest.placement,
      status: "open" as const,
      createdAt: "2026-05-23T12:00:00.000Z",
      updatedAt: "2026-05-23T12:00:00.000Z",
    };
    const registry = {
      register: vi.fn(() => manifest),
      unregister: vi.fn(() => true),
      list: vi.fn(() => [manifest]),
    };
    const sessions = {
      open: vi.fn(async () => session),
      close: vi.fn(async () => ({ ...session, status: "closed" as const })),
      push: vi.fn(async () => ({ ok: true as const })),
      list: vi.fn(() => [session]),
    };
    const handlers = buildDynamicViewRpcHandlers({
      registry: registry as never,
      sessions: sessions as never,
    });

    await expect(
      handlers.dynamicViewRegister({ manifest, update: true }),
    ).resolves.toBe(manifest);
    await expect(handlers.dynamicViewList()).resolves.toEqual({
      views: [manifest],
    });
    await expect(
      handlers.dynamicViewOpen({
        viewId: manifest.id,
        title: "Runtime Trace",
      }),
    ).resolves.toBe(session);
    await expect(
      handlers.dynamicViewPush({
        sessionId: session.sessionId,
        event: "trace.updated",
        payload: { step: 2 },
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      handlers.dynamicViewClose({ sessionId: session.sessionId }),
    ).resolves.toMatchObject({ status: "closed" });
    await expect(
      handlers.dynamicViewUnregister({ viewId: manifest.id }),
    ).resolves.toEqual({ removed: true });
    await expect(handlers.dynamicViewSessions()).resolves.toEqual({
      sessions: [session],
    });

    expect(registry.register).toHaveBeenCalledWith(manifest, { update: true });
    expect(registry.unregister).toHaveBeenCalledWith(manifest.id);
    expect(sessions.open).toHaveBeenCalledWith({
      viewId: manifest.id,
      title: "Runtime Trace",
    });
    expect(sessions.push).toHaveBeenCalledWith({
      sessionId: session.sessionId,
      event: "trace.updated",
      payload: { step: 2 },
    });
    expect(sessions.close).toHaveBeenCalledWith({
      sessionId: session.sessionId,
    });
  });
});
