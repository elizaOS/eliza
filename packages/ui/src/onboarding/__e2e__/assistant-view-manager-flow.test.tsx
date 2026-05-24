// @vitest-environment jsdom

import { ModelType, type ToolDefinition } from "@elizaos/core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeterministicLlmProxyPlugin } from "../../../../test/mocks/helpers/llm-proxy-plugin.ts";
import { DesktopTabBar } from "../../components/desktop/DesktopTabBar";
import { ViewManagerPage } from "../../components/pages/ViewManagerPage";
import { AssistantOverlay } from "../../components/shell/AssistantOverlay";
import { ChatSurface } from "../../components/shell/ChatSurface";
import { HomePill } from "../../components/shell/HomePill";
import type {
  ShellMessage,
  ShellPhase,
} from "../../components/shell/shell-state";
import { DynamicViewLoader } from "../../components/views/DynamicViewLoader";
import type { ViewRegistryEntry } from "../../hooks/useAvailableViews";
import { useAvailableViews } from "../../hooks/useAvailableViews";
import type { DesktopTab } from "../../hooks/useDesktopTabs";
import { useIsDeveloperMode } from "../../state/useDeveloperMode";

vi.mock("../../hooks/useAvailableViews", () => ({
  useAvailableViews: vi.fn(),
}));

vi.mock("../../state/useDeveloperMode", () => ({
  useIsDeveloperMode: vi.fn(),
}));

vi.mock("../../bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: vi.fn(() => true),
}));

vi.mock("../../api/csrf-client", () => ({
  fetchWithCsrf: vi.fn(),
}));

const useAvailableViewsMock = vi.mocked(useAvailableViews);
const useIsDeveloperModeMock = vi.mocked(useIsDeveloperMode);
const runtime = {} as never;
const remoteBundleImport = vi.fn();

function view(
  id: string,
  overrides: Partial<ViewRegistryEntry> = {},
): ViewRegistryEntry {
  return {
    id,
    label: id,
    available: true,
    pluginName: "deterministic-test",
    builtin: false,
    tags: [],
    ...overrides,
  };
}

function viewFromManifest(
  manifest: Record<string, unknown>,
): ViewRegistryEntry {
  const id = String(manifest.id);
  const title = String(manifest.title);
  return view(id, {
    label: title,
    description:
      typeof manifest.description === "string"
        ? manifest.description
        : undefined,
    path: `/apps/${id}`,
    bundleUrl:
      typeof manifest.entrypoint === "string" &&
      manifest.entrypoint.startsWith("/api/")
        ? manifest.entrypoint
        : undefined,
    pluginName:
      manifest.source === "remote-plugin" ? "remote-plugin" : "local-plugin",
    tags: manifest.source === "remote-plugin" ? ["remote"] : ["local"],
    desktopTabEnabled: manifest.placement === "desktop-tab",
  });
}

function tabFromView(entry: ViewRegistryEntry, pinned: boolean): DesktopTab {
  return {
    viewId: entry.id,
    label: entry.label,
    path: entry.path ?? `/apps/${entry.id}`,
    icon: entry.icon,
    pinned,
  };
}

function ModuleOutlet({ views }: { views: ViewRegistryEntry[] }) {
  const [path, setPath] = React.useState(() => window.location.pathname);

  React.useEffect(() => {
    const updatePath = () => setPath(window.location.pathname);
    window.addEventListener("popstate", updatePath);
    return () => window.removeEventListener("popstate", updatePath);
  }, []);

  if (path === "/apps/local-notes") {
    return (
      <section aria-label="Local module outlet">
        Local notes module loaded
      </section>
    );
  }

  const remoteView = views.find(
    (entry) => entry.bundleUrl && (entry.path ?? `/apps/${entry.id}`) === path,
  );
  if (!remoteView?.bundleUrl) return null;

  return (
    <section aria-label="Remote module outlet">
      <DynamicViewLoader
        bundleUrl={remoteView.bundleUrl}
        componentExport={remoteView.componentExport}
        viewId={remoteView.id}
        viewType={remoteView.viewType}
      />
    </section>
  );
}

function AssistantViewManagerHarness() {
  const llmProxy = React.useMemo(() => createDeterministicLlmProxyPlugin(), []);
  const [phase, setPhase] = React.useState<ShellPhase>("idle");
  const [messages, setMessages] = React.useState<ShellMessage[]>([]);
  const [views, setViews] = React.useState<ViewRegistryEntry[]>([
    view("local-notes", {
      label: "Local Notes",
      path: "/apps/local-notes",
      builtin: true,
      pluginName: "core",
      tags: ["local"],
    }),
  ]);
  const [tabs, setTabs] = React.useState<DesktopTab[]>([]);
  const [activeViewId, setActiveViewId] = React.useState<string | null>(null);

  useAvailableViewsMock.mockReturnValue({
    views,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });

  React.useEffect(() => {
    const handleNavigateView = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | {
            action?: string;
            viewId?: string;
            viewPath?: string;
            viewLabel?: string;
          }
        | undefined;
      if (detail?.action !== "pin-tab" || !detail.viewId) return;
      const entry = views.find((candidate) => candidate.id === detail.viewId);
      const tabView = entry ?? {
        id: detail.viewId,
        label: detail.viewLabel ?? detail.viewId,
        path: detail.viewPath ?? `/apps/${detail.viewId}`,
        available: true,
        pluginName: "event",
        builtin: false,
      };
      setTabs((current) => [
        ...current.filter((tab) => tab.viewId !== tabView.id),
        tabFromView(tabView, true),
      ]);
      setActiveViewId(tabView.id);
    };
    window.addEventListener("eliza:navigate:view", handleNavigateView);
    return () =>
      window.removeEventListener("eliza:navigate:view", handleNavigateView);
  }, [views]);

  async function send(text: string) {
    const tools: ToolDefinition[] = [
      { name: "HANDLE_RESPONSE" },
      {
        name: "DYNAMIC_VIEW_REGISTER",
        description: "Create or update a dynamic view",
        parameters: {
          type: "object",
          properties: {
            manifest: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                source: { type: "string" },
                entrypoint: { type: "string" },
                placement: { type: "string" },
                description: { type: "string" },
              },
            },
            update: { type: "boolean" },
          },
        },
      },
      {
        name: "DYNAMIC_VIEW_UNREGISTER",
        description: "Delete or remove a dynamic view",
        parameters: {
          type: "object",
          properties: {
            viewId: { type: "string" },
          },
        },
      },
    ];

    const responseRaw = await llmProxy.models?.[ModelType.RESPONSE_HANDLER]?.(
      runtime,
      {
        messages: [{ role: "user", content: text }],
        tools,
      },
    );
    const response = JSON.parse(String(responseRaw));
    const responseArgs = response.toolCalls[0].arguments;

    const plannerRaw = await llmProxy.models?.[ModelType.ACTION_PLANNER]?.(
      runtime,
      {
        messages: [{ role: "user", content: text }],
        tools,
      },
    );
    const planned = JSON.parse(String(plannerRaw));
    const plannedToolName = String(planned.toolCalls[0].name);
    const plannedArgs = planned.toolCalls[0].arguments;

    setMessages((current) => [
      ...current,
      {
        id: `user-${current.length}`,
        role: "user",
        content: text,
        createdAt: 1,
      },
      {
        id: `assistant-${current.length}`,
        role: "assistant",
        content: String(responseArgs.replyText),
        createdAt: 2,
      },
    ]);

    if (plannedToolName === "DYNAMIC_VIEW_UNREGISTER") {
      const viewId = String(plannedArgs.viewId);
      setViews((current) => current.filter((entry) => entry.id !== viewId));
      setTabs((current) => current.filter((tab) => tab.viewId !== viewId));
      if (activeViewId === viewId) setActiveViewId(null);
      return;
    }

    const nextView = viewFromManifest(plannedArgs.manifest);
    setViews((current) => [
      ...current.filter((entry) => entry.id !== nextView.id),
      nextView,
    ]);
    if (nextView.desktopTabEnabled) {
      setTabs((current) => [
        ...current.filter((tab) => tab.viewId !== nextView.id),
        tabFromView(nextView, true),
      ]);
      setActiveViewId(nextView.id);
    }
  }

  function openTab(viewId: string) {
    const tab = tabs.find((entry) => entry.viewId === viewId);
    if (!tab) return;
    setActiveViewId(viewId);
    window.history.pushState(null, "", tab.path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  function closeTab(viewId: string) {
    setTabs((current) => current.filter((tab) => tab.viewId !== viewId));
    if (activeViewId === viewId) setActiveViewId(null);
  }

  return (
    <>
      <HomePill
        phase={phase}
        onOpen={() => setPhase("summoned")}
        onClose={() => setPhase("idle")}
      />
      <AssistantOverlay phase={phase} onClose={() => setPhase("idle")}>
        <ChatSurface messages={messages} onSend={send} canSend={true} />
      </AssistantOverlay>
      <DesktopTabBar
        tabs={tabs}
        activeViewId={activeViewId}
        onTabClick={openTab}
        onTabClose={closeTab}
        onOpenViewManager={() => window.history.pushState(null, "", "/views")}
      />
      <ViewManagerPage />
      <ModuleOutlet views={views} />
    </>
  );
}

describe("assistant + view manager application flow", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/views");
    useIsDeveloperModeMock.mockReturnValue(false);
    remoteBundleImport.mockReset();
    remoteBundleImport.mockImplementation(async () => ({
      default: function RemoteLedgerModule() {
        return (
          <div data-view-state='{"viewId":"remote-ledger","loaded":true}'>
            Remote ledger remote module loaded
          </div>
        );
      },
    }));
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = remoteBundleImport;
  });

  afterEach(() => {
    delete window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__;
    cleanup();
    vi.clearAllMocks();
  });

  it("creates a remote view from the real chat input, renders it in the manager, switches tabs, and closes it", async () => {
    render(<AssistantViewManagerHarness />);

    expect(screen.getByText("Local Notes")).toBeTruthy();
    expect(screen.queryByText("Remote Ledger")).toBeNull();

    fireEvent.click(screen.getByText("Local Notes"));
    await waitFor(() => {
      expect(screen.getByLabelText("Local module outlet").textContent).toBe(
        "Local notes module loaded",
      );
    });
    act(() => {
      window.history.pushState(null, "", "/views");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    fireEvent.click(screen.getByTestId("shell-home-pill"));
    const input = screen.getByLabelText(/message eliza/i);
    async function sendChat(text: string) {
      fireEvent.change(input, { target: { value: text } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /send message/i }));
      });
    }

    await sendChat("Create a new remote ledger view and pin it as a tab");

    await waitFor(() => {
      expect(screen.getByText("On it.")).toBeTruthy();
      expect(
        screen.getAllByText("Remote Ledger").length,
      ).toBeGreaterThanOrEqual(2);
    });

    const remoteCards = screen.getAllByText("Remote Ledger");
    expect(remoteCards.length).toBeGreaterThanOrEqual(2);
    const tablist = screen.getByRole("tablist", {
      name: "Desktop view tabs",
    });
    const remoteTab = within(tablist).getByRole("button", {
      name: "Remote Ledger",
    });
    expect(remoteTab).toBeTruthy();

    fireEvent.click(remoteTab);
    expect(window.location.pathname).toBe("/apps/remote-ledger");
    await screen.findByText("Remote ledger remote module loaded");
    expect(remoteBundleImport).toHaveBeenCalledWith(
      "/api/views/remote-ledger/bundle.js",
    );

    fireEvent.click(
      within(tablist).getByRole("button", { name: "Close Remote Ledger" }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("tablist")).toBeNull();
    });
    expect(screen.getAllByText("Remote Ledger").length).toBe(1);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Pin Remote Ledger as desktop tab",
      }),
    );
    const repinnedTablist = await screen.findByRole("tablist", {
      name: "Desktop view tabs",
    });
    expect(
      within(repinnedTablist).getByRole("button", {
        name: "Remote Ledger",
      }),
    ).toBeTruthy();
    fireEvent.click(
      within(repinnedTablist).getByRole("button", {
        name: "Close Remote Ledger",
      }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("tablist")).toBeNull();
    });

    await sendChat(
      "Edit the remote ledger view title to Remote Ledger Updated and pin it as a tab",
    );
    await waitFor(() => {
      expect(screen.getByRole("tablist")).toBeTruthy();
    });
    const updatedTablist = screen.getByRole("tablist", {
      name: "Desktop view tabs",
    });
    expect(
      within(updatedTablist).getByRole("button", {
        name: "Remote Ledger Updated",
      }),
    ).toBeTruthy();
    expect(screen.getAllByText("Remote Ledger Updated").length).toBe(2);
    expect(screen.queryByText("Remote Ledger")).toBeNull();

    await sendChat("Delete the stale remote ledger dynamic view");
    await waitFor(() => {
      expect(screen.queryByRole("tablist")).toBeNull();
      expect(screen.queryByText("Remote Ledger")).toBeNull();
    });
    expect(screen.getAllByText("Local Notes").length).toBeGreaterThan(0);
  });
});
