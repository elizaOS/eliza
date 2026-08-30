/** Ensures installable/installed launcher catalogs never cross agent bases. */
// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryAppInfo } from "../api";
import { __resetResourceCache, invalidate } from "./resource-cache";

const mocks = vi.hoisted(() => {
  const authority = {
    value: "https://agent-a.test",
    listeners: new Set<() => void>(),
  };
  return {
    authority,
    appShellRoutesSupported: { value: true },
    client: {
      getBaseUrl: vi.fn(() => authority.value),
      onBaseUrlChange: vi.fn((onChange: () => void) => {
        authority.listeners.add(onChange);
        return () => authority.listeners.delete(onChange);
      }),
      listInstalledApps: vi.fn(),
      launchApp: vi.fn(),
    },
    loadAppsCatalog: vi.fn(),
    refreshViews: vi.fn(),
    routableViews: {
      views: [] as Array<Record<string, unknown>>,
      loading: false,
      error: null as Error | null,
    },
  };
});

vi.mock("../api", () => ({ client: mocks.client }));
vi.mock("../api/client", () => ({ client: mocks.client }));
vi.mock("../api/app-shell-capabilities", () => ({
  supportsFullAppShellRoutes: () => mocks.appShellRoutesSupported.value,
}));
vi.mock("../components/apps/load-apps-catalog", () => ({
  loadAppsCatalog: mocks.loadAppsCatalog,
}));
vi.mock("../platform/platform-guards", () => ({
  getActiveViewModality: () => "gui",
}));
vi.mock("../state/useViewKinds", () => ({
  useEnabledViewKinds: () => ({ developer: true, preview: true }),
}));
vi.mock("./useAvailableViews", () => ({
  useRoutableViews: () => ({
    ...mocks.routableViews,
    refresh: mocks.refreshViews,
  }),
}));

import { getActiveAgentAuthority } from "./useActiveAgentAuthority";
import {
  __resetViewCatalogSourceStateForTests,
  useViewCatalog,
} from "./useViewCatalog";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function catalogApp(name: string): RegistryAppInfo {
  return {
    name,
    displayName: name,
    description: `${name} catalog entry`,
    category: "other",
    launchType: "page",
    launchUrl: null,
    icon: null,
    heroImage: null,
    capabilities: [],
    stars: 0,
    repository: "",
    latestVersion: null,
    supports: { v0: false, v1: false, v2: true },
    npm: { package: name, v0Version: null, v1Version: null, v2Version: "1" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetViewCatalogSourceStateForTests();
  mocks.loadAppsCatalog.mockReset();
  mocks.client.listInstalledApps.mockReset();
  mocks.client.launchApp.mockReset();
  __resetResourceCache();
  mocks.authority.value = "https://agent-a.test";
  mocks.appShellRoutesSupported.value = true;
  mocks.authority.listeners.clear();
  mocks.routableViews.views = [];
  mocks.routableViews.loading = false;
  mocks.routableViews.error = null;
});

describe("useViewCatalog authority isolation", () => {
  it("settles to an honest empty launcher when app-shell sources are unsupported", () => {
    mocks.appShellRoutesSupported.value = false;

    const { result } = renderHook(() => useViewCatalog());

    expect(result.current.entries).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mocks.loadAppsCatalog).not.toHaveBeenCalled();
    expect(mocks.client.listInstalledApps).not.toHaveBeenCalled();

    act(() => result.current.refresh());
    expect(mocks.refreshViews).toHaveBeenCalledTimes(1);
    expect(mocks.loadAppsCatalog).not.toHaveBeenCalled();
    expect(mocks.client.listInstalledApps).not.toHaveBeenCalled();
  });

  it("surfaces the views error when unsupported app-shell sources are disabled", () => {
    mocks.appShellRoutesSupported.value = false;
    mocks.routableViews.error = new Error("views unavailable");

    const { result } = renderHook(() => useViewCatalog());

    expect(result.current.entries).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error?.message).toBe("views unavailable");
    expect(mocks.loadAppsCatalog).not.toHaveBeenCalled();
    expect(mocks.client.listInstalledApps).not.toHaveBeenCalled();

    act(() => result.current.refresh());
    expect(mocks.refreshViews).toHaveBeenCalledTimes(1);
    expect(mocks.loadAppsCatalog).not.toHaveBeenCalled();
    expect(mocks.client.listInstalledApps).not.toHaveBeenCalled();
  });

  it("degrades a failed optional catalog without marking healthy views broken", async () => {
    mocks.routableViews.views = [
      {
        id: "notes",
        label: "Notes",
        path: "/notes",
        available: true,
        builtin: true,
        pluginName: "@elizaos/builtin",
        viewType: "gui",
        viewKind: "release",
      },
    ];
    mocks.loadAppsCatalog.mockRejectedValue(new Error("catalog unavailable"));
    mocks.client.listInstalledApps.mockResolvedValue([]);

    const { result } = renderHook(() => useViewCatalog());
    await waitFor(() => expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(1));

    expect(result.current.entries.map((entry) => entry.id)).toEqual(["notes"]);
    expect(result.current.error).toBeNull();

    act(() => result.current.refresh());
    await waitFor(() => expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(2));
    expect(mocks.client.listInstalledApps).toHaveBeenCalledTimes(1);
    expect(mocks.refreshViews).not.toHaveBeenCalled();
  });

  it("uses one delayed catalog retry without refetching healthy sources", async () => {
    vi.useFakeTimers();
    try {
      mocks.loadAppsCatalog
        .mockRejectedValueOnce(new Error("catalog temporarily unavailable"))
        .mockResolvedValueOnce([catalogApp("recovered-app")]);
      mocks.client.listInstalledApps.mockResolvedValue([]);

      const { result } = renderHook(() => useViewCatalog());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.error?.message).toBe(
        "catalog temporarily unavailable",
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(499);
      });
      expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(1);
      expect(mocks.client.listInstalledApps).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(result.current.entries.map((entry) => entry.id)).toEqual([
        "recovered-app",
      ]);
      expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(2);
      expect(mocks.client.listInstalledApps).toHaveBeenCalledTimes(1);
      expect(mocks.refreshViews).not.toHaveBeenCalled();
      expect(result.current.error).toBeNull();

      mocks.loadAppsCatalog
        .mockRejectedValueOnce(new Error("later catalog outage"))
        .mockResolvedValueOnce([catalogApp("recovered-again")]);
      act(() => {
        invalidate(`view-catalog:apps:${getActiveAgentAuthority()}`);
        result.current.refresh();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(499);
      });
      expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(3);
      expect(mocks.client.listInstalledApps).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(result.current.entries.map((entry) => entry.id)).toEqual([
        "recovered-again",
      ]);
      expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(4);
      expect(mocks.client.listInstalledApps).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses one delayed installed-app retry without refetching the catalog", async () => {
    vi.useFakeTimers();
    try {
      mocks.loadAppsCatalog.mockResolvedValue([catalogApp("catalog-app")]);
      mocks.client.listInstalledApps
        .mockRejectedValueOnce(
          new Error("installed apps temporarily unavailable"),
        )
        .mockResolvedValueOnce([]);

      const { result } = renderHook(() => useViewCatalog());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.entries.map((entry) => entry.id)).toEqual([
        "catalog-app",
      ]);
      expect(result.current.error).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(499);
      });
      expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(1);
      expect(mocks.client.listInstalledApps).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(1);
      expect(mocks.client.listInstalledApps).toHaveBeenCalledTimes(2);
      expect(mocks.refreshViews).not.toHaveBeenCalled();
      expect(result.current.error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a departed authority's pending optional-source retry", async () => {
    vi.useFakeTimers();
    try {
      mocks.loadAppsCatalog
        .mockRejectedValueOnce(new Error("agent A catalog unavailable"))
        .mockResolvedValueOnce([catalogApp("agent-b-app")]);
      mocks.client.listInstalledApps.mockResolvedValue([]);

      const { result } = renderHook(() => useViewCatalog());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.error?.message).toBe("agent A catalog unavailable");

      act(() => {
        mocks.authority.value = "https://agent-b.test";
        for (const onChange of mocks.authority.listeners) onChange();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.entries.map((entry) => entry.id)).toEqual([
        "agent-b-app",
      ]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(2);
      expect(mocks.client.listInstalledApps).toHaveBeenCalledTimes(2);
      expect(mocks.refreshViews).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not spend a new authority's retry budget on an inherited error", async () => {
    vi.useFakeTimers();
    try {
      const agentACatalog = deferred<RegistryAppInfo[]>();
      const agentBCatalog = deferred<RegistryAppInfo[]>();
      mocks.loadAppsCatalog
        .mockReturnValueOnce(agentACatalog.promise)
        .mockReturnValueOnce(agentBCatalog.promise);
      mocks.client.listInstalledApps.mockResolvedValue([]);

      const { result } = renderHook(() => useViewCatalog());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(1);

      act(() => {
        mocks.authority.value = "https://agent-b.test";
        for (const onChange of mocks.authority.listeners) onChange();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(2);

      mocks.loadAppsCatalog
        .mockRejectedValueOnce(new Error("later agent B outage"))
        .mockResolvedValueOnce([catalogApp("agent-b-recovered")]);
      await act(async () => {
        agentACatalog.reject(new Error("late agent A rejection"));
        await Promise.resolve();
      });
      expect(result.current.error).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(750);
      });
      expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(2);
      expect(mocks.client.listInstalledApps).toHaveBeenCalledTimes(2);

      await act(async () => {
        agentBCatalog.resolve([catalogApp("agent-b-initial")]);
        await Promise.resolve();
      });
      expect(result.current.entries.map((entry) => entry.id)).toEqual([
        "agent-b-initial",
      ]);

      act(() => {
        invalidate(`view-catalog:apps:${getActiveAgentAuthority()}`);
        result.current.refresh();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.error?.message).toBe("later agent B outage");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(499);
      });
      expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(3);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(4);
      expect(mocks.client.listInstalledApps).toHaveBeenCalledTimes(3);
      expect(result.current.entries.map((entry) => entry.id)).toEqual([
        "agent-b-recovered",
      ]);
      expect(result.current.error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a source failure fatal when no usable launcher entry remains", async () => {
    mocks.loadAppsCatalog.mockRejectedValue(new Error("catalog unavailable"));
    mocks.client.listInstalledApps.mockResolvedValue([]);

    const { result } = renderHook(() => useViewCatalog());
    await waitFor(() => expect(result.current.error).not.toBeNull());

    expect(result.current.entries).toEqual([]);
    expect(result.current.error?.message).toBe("catalog unavailable");
  });

  it("shares failure settlement and exactly one retry across a remount", async () => {
    vi.useFakeTimers();
    try {
      const sharedCatalog = deferred<RegistryAppInfo[]>();
      mocks.loadAppsCatalog
        .mockReturnValueOnce(sharedCatalog.promise)
        .mockResolvedValueOnce([catalogApp("recovered-app")]);
      mocks.client.listInstalledApps.mockResolvedValue([]);

      const first = renderHook(() => useViewCatalog());
      const survivor = renderHook(() => useViewCatalog());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(1);
      expect(mocks.client.listInstalledApps).toHaveBeenCalledTimes(1);

      first.unmount();
      await act(async () => {
        sharedCatalog.reject(new Error("shared catalog unavailable"));
        await Promise.resolve();
      });
      expect(survivor.result.current.loading).toBe(false);
      expect(survivor.result.current.error?.message).toBe(
        "shared catalog unavailable",
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(2);
      expect(mocks.client.listInstalledApps).toHaveBeenCalledTimes(1);
      expect(survivor.result.current.entries.map((entry) => entry.id)).toEqual([
        "recovered-app",
      ]);
      expect(survivor.result.current.error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes persistent partial degradation and retries only that source", async () => {
    vi.useFakeTimers();
    try {
      mocks.routableViews.views = [
        {
          id: "notes",
          label: "Notes",
          path: "/notes",
          available: true,
          builtin: true,
          pluginName: "@elizaos/builtin",
          viewType: "gui",
          viewKind: "release",
        },
      ];
      mocks.loadAppsCatalog.mockRejectedValue(new Error("catalog unavailable"));
      mocks.client.listInstalledApps.mockResolvedValue([]);

      const { result } = renderHook(() => useViewCatalog());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(2);
      expect(result.current.entries.map((entry) => entry.id)).toEqual([
        "notes",
      ]);
      expect(result.current.error?.message).toBe("catalog unavailable");

      act(() => result.current.refresh());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(3);
      expect(mocks.client.listInstalledApps).toHaveBeenCalledTimes(1);
      expect(mocks.refreshViews).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears old entries on switch and ignores superseded catalog responses", async () => {
    const agentBCatalog = deferred<RegistryAppInfo[]>();
    const agentBInstalled = deferred<Array<{ name: string }>>();
    const agentCCatalog = deferred<RegistryAppInfo[]>();
    const agentCInstalled = deferred<Array<{ name: string }>>();
    mocks.loadAppsCatalog
      .mockResolvedValueOnce([catalogApp("agent-a-app")])
      .mockReturnValueOnce(agentBCatalog.promise)
      .mockReturnValueOnce(agentCCatalog.promise);
    mocks.client.listInstalledApps
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(agentBInstalled.promise)
      .mockReturnValueOnce(agentCInstalled.promise);

    const { result } = renderHook(() => useViewCatalog());
    await waitFor(() =>
      expect(result.current.entries.map((entry) => entry.id)).toEqual([
        "agent-a-app",
      ]),
    );

    act(() => {
      mocks.authority.value = "https://agent-b.test";
      for (const onChange of mocks.authority.listeners) onChange();
    });
    expect(result.current.entries).toEqual([]);
    await waitFor(() => expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(2));

    act(() => {
      mocks.authority.value = "https://agent-c.test";
      for (const onChange of mocks.authority.listeners) onChange();
    });
    expect(result.current.entries).toEqual([]);
    await waitFor(() => expect(mocks.loadAppsCatalog).toHaveBeenCalledTimes(3));

    agentCCatalog.resolve([catalogApp("agent-c-app")]);
    agentCInstalled.resolve([]);
    await waitFor(() =>
      expect(result.current.entries.map((entry) => entry.id)).toEqual([
        "agent-c-app",
      ]),
    );

    agentBCatalog.resolve([catalogApp("stale-agent-b-app")]);
    agentBInstalled.resolve([]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      "agent-c-app",
    ]);
  });

  it("does not hand an old authority's in-flight launch to navigation", async () => {
    const launch = deferred<unknown>();
    mocks.loadAppsCatalog
      .mockResolvedValueOnce([catalogApp("agent-a-app")])
      .mockResolvedValueOnce([]);
    mocks.client.listInstalledApps.mockResolvedValue([]);
    mocks.client.launchApp.mockReturnValueOnce(launch.promise);
    const { result } = renderHook(() => useViewCatalog());
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    const entry = result.current.entries[0];
    if (!entry) throw new Error("expected catalog entry");

    let pendingLaunch!: ReturnType<typeof result.current.get>;
    await act(async () => {
      pendingLaunch = result.current.get(entry);
      await Promise.resolve();
    });
    act(() => {
      mocks.authority.value = "https://agent-b.test";
      for (const onChange of mocks.authority.listeners) onChange();
    });

    await act(async () => {
      launch.resolve({ runId: "old-agent-run" });
      expect(await pendingLaunch).toBeNull();
    });
    expect(mocks.refreshViews).not.toHaveBeenCalled();
  });
});
