/** Ensures installable/installed launcher catalogs never cross agent bases. */
// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryAppInfo } from "../api";
import { __resetResourceCache } from "./resource-cache";

const mocks = vi.hoisted(() => {
  const authority = {
    value: "https://agent-a.test",
    listeners: new Set<() => void>(),
  };
  return {
    authority,
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
  };
});

vi.mock("../api", () => ({ client: mocks.client }));
vi.mock("../api/client", () => ({ client: mocks.client }));
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
    views: [],
    loading: false,
    error: null,
    refresh: mocks.refreshViews,
  }),
}));

import { useViewCatalog } from "./useViewCatalog";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
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
  __resetResourceCache();
  mocks.authority.value = "https://agent-a.test";
  mocks.authority.listeners.clear();
});

describe("useViewCatalog authority isolation", () => {
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
