import {
  type BrowserWorkspaceWalletState,
  buildBrowserWorkspaceWalletState,
} from "@elizaos/app-steward";
import type {
  BrowserBridgeCompanionPackageStatus,
  BrowserBridgeCompanionStatus,
} from "@elizaos/plugin-browser-bridge";
import {
  Button,
  Input,
  SidebarCollapsedActionButton,
  SidebarContent,
  SidebarPanel,
  SidebarScrollRegion,
  useIntervalWhenDocumentVisible,
  WorkspaceLayout,
} from "@elizaos/ui";
import { ExternalLink, FolderOpen, Plus, RefreshCw, X } from "lucide-react";
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type BrowserWorkspaceSnapshot,
  type BrowserWorkspaceTab,
  client,
} from "../../api";
import { useApp } from "../../state";
import { openExternalUrl } from "../../utils";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { CollapsibleSidebarSection } from "../shared/CollapsibleSidebarSection";
import {
  AppWorkspaceChrome,
  type AppWorkspaceChromeProps,
} from "../workspace/AppWorkspaceChrome.js";
import { getBrowserPageScopeCopy } from "./page-scoped-conversations";
import { useBrowserWorkspaceWalletBridge } from "./useBrowserWorkspaceWalletBridge";

const POLL_INTERVAL_MS = 2_500;
const BROWSER_BRIDGE_POLL_INTERVAL_MS = 4_000;
const BROWSER_WORKSPACE_AGENT_PARTITION = "persist:eliza-browser-agent";
const BROWSER_WORKSPACE_APP_PARTITION = "persist:eliza-browser-app";
const BROWSER_WORKSPACE_COLLAPSED_SECTIONS_STORAGE_KEY =
  "milady:browser-workspace:collapsed-sections";
type TranslateFn = (key: string, vars?: Record<string, unknown>) => string;
type BrowserWorkspaceTabSectionKey = "agent" | "app" | "user";

function readStoredBrowserWorkspaceCollapsedSections(): Set<BrowserWorkspaceTabSectionKey> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(
      BROWSER_WORKSPACE_COLLAPSED_SECTIONS_STORAGE_KEY,
    );
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter(
        (value): value is BrowserWorkspaceTabSectionKey =>
          value === "agent" || value === "app" || value === "user",
      ),
    );
  } catch {
    return new Set();
  }
}

function persistBrowserWorkspaceCollapsedSections(
  sections: Set<BrowserWorkspaceTabSectionKey>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      BROWSER_WORKSPACE_COLLAPSED_SECTIONS_STORAGE_KEY,
      JSON.stringify([...sections]),
    );
  } catch {
    /* ignore sandboxed storage */
  }
}

function resolveBrowserWorkspaceTabSectionKey(
  tab: BrowserWorkspaceTab,
): BrowserWorkspaceTabSectionKey {
  const partition = tab.partition.trim().toLowerCase();
  if (partition === BROWSER_WORKSPACE_AGENT_PARTITION) {
    return "agent";
  }
  if (partition === BROWSER_WORKSPACE_APP_PARTITION) {
    return "app";
  }
  return "user";
}

function resolveBrowserWorkspaceTabPartition(
  sectionKey: BrowserWorkspaceTabSectionKey,
): string | undefined {
  switch (sectionKey) {
    case "agent":
      return BROWSER_WORKSPACE_AGENT_PARTITION;
    case "app":
      return BROWSER_WORKSPACE_APP_PARTITION;
    case "user":
      return undefined;
  }
}

function isBrowserBridgePlugin(plugin: {
  id?: string;
  name?: string;
  npmName?: string;
}): boolean {
  const identifiers = [plugin.id, plugin.name, plugin.npmName]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  return identifiers.some(
    (value) =>
      value === "browser-bridge" ||
      value === "plugin-browser-bridge" ||
      value === "@elizaos/plugin-browser-bridge",
  );
}

function isBrowserWorkspaceSessionMode(
  mode: BrowserWorkspaceSnapshot["mode"],
): boolean {
  return mode === "cloud" || mode === "desktop";
}

function normalizeBrowserWorkspaceInputUrl(
  rawUrl: string,
  t: TranslateFn,
): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (trimmed === "about:blank") return trimmed;

  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(
      t("browserworkspace.InvalidUrl", {
        defaultValue: "Enter a valid http or https URL.",
      }),
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      t("browserworkspace.UnsupportedProtocol", {
        defaultValue: "Only http and https URLs are supported.",
      }),
    );
  }
  return parsed.toString();
}

function readBrowserWorkspaceQueryParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  const rawSearch =
    window.location.search || window.location.hash.split("?")[1] || "";
  const params = new URLSearchParams(
    rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch,
  );
  const value = params.get(name)?.trim();
  return value ? value : null;
}

function inferBrowserWorkspaceTitle(url: string, t: TranslateFn): string {
  if (url === "about:blank") {
    return t("browserworkspace.NewTab", {
      defaultValue: "New tab",
    });
  }
  try {
    return (
      new URL(url).hostname.replace(/^www\./, "") ||
      t("nav.browser", {
        defaultValue: "Browser",
      })
    );
  } catch {
    return t("nav.browser", {
      defaultValue: "Browser",
    });
  }
}

function getBrowserWorkspaceTabKind(
  tab: BrowserWorkspaceTab,
): "internal" | "standard" {
  return tab.kind === "internal" ? "internal" : "standard";
}

function isInternalBrowserWorkspaceTab(tab: BrowserWorkspaceTab): boolean {
  return getBrowserWorkspaceTabKind(tab) === "internal";
}

function isBrowserWorkspaceFrameBlockedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)discord\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function getBrowserWorkspaceTabLabel(
  tab: BrowserWorkspaceTab,
  t: TranslateFn,
): string {
  const trimmedTitle = tab.title.trim();
  if (trimmedTitle && trimmedTitle !== "Browser") return trimmedTitle;
  return inferBrowserWorkspaceTitle(tab.url, t);
}

function getBrowserWorkspaceTabMonogram(label: string): string {
  const alphanumeric = label.trim().replace(/[^a-z0-9]/gi, "");
  return (alphanumeric[0] ?? "B").toUpperCase();
}

function getBrowserWorkspaceTabDescription(
  tab: BrowserWorkspaceTab,
  mode: BrowserWorkspaceSnapshot["mode"],
): string {
  const details: string[] = [];

  if (isInternalBrowserWorkspaceTab(tab)) {
    details.push("Internal");
  }

  if (mode !== "web") {
    if (tab.provider?.trim()) {
      details.push(tab.provider.trim());
    }
    if (tab.status?.trim()) {
      details.push(tab.status.trim());
    }
  }

  details.push(tab.url);
  return details.join(" · ");
}

function resolveBrowserWorkspaceSelection(
  tabs: BrowserWorkspaceTab[],
  selectedId: string | null,
): string | null {
  if (selectedId && tabs.some((tab) => tab.id === selectedId)) {
    return selectedId;
  }
  const visibleTab = tabs.find((tab) => tab.visible);
  return visibleTab?.id ?? tabs[0]?.id ?? null;
}

export function BrowserWorkspaceView(): JSX.Element {
  const {
    getStewardPending,
    getStewardStatus,
    setActionNotice,
    t,
    plugins,
    uiTheme,
    walletAddresses,
    walletConfig,
  } = useApp();
  const [workspace, setWorkspace] = useState<BrowserWorkspaceSnapshot>({
    mode: "web",
    tabs: [],
  });
  const [browserWalletState, setBrowserWalletState] =
    useState<BrowserWorkspaceWalletState>(() =>
      buildBrowserWorkspaceWalletState({
        pendingApprovals: 0,
        stewardStatus: null,
        walletAddresses,
        walletConfig,
      }),
    );
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const [locationInput, setLocationInput] = useState("");
  const [locationDirty, setLocationDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [tabSnapshots, setTabSnapshots] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<
    Set<BrowserWorkspaceTabSectionKey>
  >(() => readStoredBrowserWorkspaceCollapsedSections());
  const [browserBridgeAvailable, setBrowserBridgeAvailable] = useState(false);
  const [browserBridgeLoading, setBrowserBridgeLoading] = useState(true);
  const [browserBridgeCompanions, setBrowserBridgeCompanions] = useState<
    BrowserBridgeCompanionStatus[]
  >([]);
  const [browserBridgePackageStatus, setBrowserBridgePackageStatus] =
    useState<BrowserBridgeCompanionPackageStatus | null>(null);
  const initialBrowseUrlRef = useRef<string | null | undefined>(undefined);
  const initialBrowseHandledRef = useRef(false);
  const initialBlankTabHandledRef = useRef(false);
  const iframeRefs = useRef(new Map<string, HTMLIFrameElement | null>());
  const getStewardPendingRef = useRef(getStewardPending);
  const getStewardStatusRef = useRef(getStewardStatus);
  const setActionNoticeRef = useRef(setActionNotice);
  const tRef = useRef(t);
  const walletAddressesRef = useRef(walletAddresses);
  const walletConfigRef = useRef(walletConfig);
  const previousSelectedTabIdRef = useRef<string | null>(null);

  if (typeof initialBrowseUrlRef.current === "undefined") {
    const browseParam = readBrowserWorkspaceQueryParam("browse");
    try {
      initialBrowseUrlRef.current = browseParam
        ? normalizeBrowserWorkspaceInputUrl(browseParam, t)
        : null;
    } catch {
      initialBrowseUrlRef.current = null;
    }
  }

  const selectedTab = useMemo(
    () => workspace.tabs.find((tab) => tab.id === selectedTabId) ?? null,
    [selectedTabId, workspace.tabs],
  );
  const selectedTabSnapshot = selectedTabId
    ? (tabSnapshots[selectedTabId] ?? null)
    : null;
  const selectedTabLiveViewUrl =
    selectedTab?.interactiveLiveViewUrl ?? selectedTab?.liveViewUrl ?? null;
  const selectedTabIsInternal = selectedTab
    ? isInternalBrowserWorkspaceTab(selectedTab)
    : false;
  const newBrowserWorkspaceTabSeedUrl = selectedTabIsInternal
    ? "about:blank"
    : locationInput || "about:blank";
  const groupedTabs = useMemo(
    () =>
      workspace.tabs.reduce<
        Record<BrowserWorkspaceTabSectionKey, BrowserWorkspaceTab[]>
      >(
        (groups, tab) => {
          groups[resolveBrowserWorkspaceTabSectionKey(tab)].push(tab);
          return groups;
        },
        { user: [], agent: [], app: [] },
      ),
    [workspace.tabs],
  );
  const collapsedRailTabs = useMemo(
    () => [...groupedTabs.user, ...groupedTabs.agent, ...groupedTabs.app],
    [groupedTabs],
  );
  const primaryBrowserBridgeCompanion = useMemo(
    () =>
      browserBridgeCompanions.find(
        (companion) => companion.connectionState === "connected",
      ) ??
      browserBridgeCompanions[0] ??
      null,
    [browserBridgeCompanions],
  );
  const browserBridgeConnected =
    primaryBrowserBridgeCompanion?.connectionState === "connected";

  const toggleSidebarSectionCollapsed = useCallback((key: string) => {
    setCollapsedSections((current) => {
      if (key !== "agent" && key !== "app" && key !== "user") {
        return current;
      }
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);
  const browserBridgeSupported = useMemo(
    () => plugins.some((plugin) => isBrowserBridgePlugin(plugin)),
    [plugins],
  );

  useEffect(() => {
    getStewardPendingRef.current = getStewardPending;
    getStewardStatusRef.current = getStewardStatus;
    setActionNoticeRef.current = setActionNotice;
    tRef.current = t;
    walletAddressesRef.current = walletAddresses;
    walletConfigRef.current = walletConfig;
  }, [
    getStewardPending,
    getStewardStatus,
    setActionNotice,
    t,
    walletAddresses,
    walletConfig,
  ]);

  const loadBrowserWalletState = useCallback(async () => {
    try {
      const stewardStatus = await getStewardStatusRef
        .current()
        .catch(() => null);
      const resolvedWalletConfig =
        walletConfigRef.current ??
        (await client.getWalletConfig().catch(() => null));
      const pendingApprovals =
        stewardStatus?.connected === true
          ? (await getStewardPendingRef.current().catch(() => [])).length
          : 0;
      const nextState = buildBrowserWorkspaceWalletState({
        pendingApprovals,
        stewardStatus,
        walletAddresses: walletAddressesRef.current,
        walletConfig: resolvedWalletConfig,
      });
      setBrowserWalletState(nextState);
      return nextState;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextState = buildBrowserWorkspaceWalletState({
        pendingApprovals: 0,
        stewardStatus: {
          available: false,
          configured: false,
          connected: false,
          error: message,
        },
        walletAddresses: walletAddressesRef.current,
        walletConfig: walletConfigRef.current,
      });
      setBrowserWalletState(nextState);
      return nextState;
    }
  }, []);

  const loadBrowserBridgeState = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) {
        setBrowserBridgeLoading(true);
      }
      const [companionsResult, packageResult] = await Promise.allSettled([
        client.fetch<{ companions: BrowserBridgeCompanionStatus[] }>(
          "/api/browser-bridge/companions",
        ),
        client.fetch<{ status: BrowserBridgeCompanionPackageStatus }>(
          "/api/browser-bridge/packages",
        ),
      ]);
      if (companionsResult.status === "fulfilled") {
        setBrowserBridgeCompanions(companionsResult.value.companions);
      } else {
        setBrowserBridgeCompanions([]);
      }
      if (packageResult.status === "fulfilled") {
        setBrowserBridgePackageStatus(packageResult.value.status);
      } else {
        setBrowserBridgePackageStatus(null);
      }
      setBrowserBridgeAvailable(
        companionsResult.status === "fulfilled" ||
          packageResult.status === "fulfilled",
      );
      if (!options?.silent) {
        setBrowserBridgeLoading(false);
      }
    },
    [],
  );

  const loadWorkspace = useCallback(
    async (options?: { preferTabId?: string | null; silent?: boolean }) => {
      if (!options?.silent) {
        setLoading(true);
      }
      try {
        const snapshot = await client.getBrowserWorkspace();
        setWorkspace(snapshot);
        setLoadError(null);
        setSelectedTabId((current) =>
          resolveBrowserWorkspaceSelection(
            snapshot.tabs,
            options?.preferTabId ?? current,
          ),
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : tRef.current("browserworkspace.LoadFailed", {
                defaultValue: "Failed to load browser workspace.",
              });
        setLoadError(message);
      } finally {
        if (!options?.silent) {
          setLoading(false);
        }
      }
    },
    [],
  );

  const runBrowserWorkspaceAction = useCallback(
    async (
      actionKey: string,
      action: () => Promise<void>,
      onErrorMessage?: string,
    ) => {
      setBusyAction(actionKey);
      try {
        await action();
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : (onErrorMessage ??
              tRef.current("browserworkspace.ActionFailed", {
                defaultValue: "Browser action failed.",
              }));
        setActionNoticeRef.current(message, "error", 4_000);
      } finally {
        setBusyAction(null);
      }
    },
    [],
  );

  const loadSelectedBrowserWorkspaceSnapshot = useCallback(
    async (tabId: string, mode: BrowserWorkspaceSnapshot["mode"]) => {
      if (!isBrowserWorkspaceSessionMode(mode)) {
        setSnapshotError(null);
        return;
      }
      try {
        const snapshot = await client.snapshotBrowserWorkspaceTab(tabId);
        setTabSnapshots((current) => {
          if (current[tabId] === snapshot.data) {
            return current;
          }
          return { ...current, [tabId]: snapshot.data };
        });
        setSnapshotError(null);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : tRef.current("browserworkspace.SnapshotFailed", {
                defaultValue: "Failed to load browser session preview.",
              });
        setSnapshotError(message);
      }
    },
    [],
  );

  const openNewBrowserWorkspaceTab = useCallback(
    async (
      rawUrl: string,
      sectionKey: BrowserWorkspaceTabSectionKey = "user",
    ) => {
      const url = normalizeBrowserWorkspaceInputUrl(rawUrl, t);
      if (!url) {
        throw new Error(
          t("browserworkspace.EnterUrlToOpen", {
            defaultValue: "Enter a URL to open.",
          }),
        );
      }
      const request = {
        url,
        title: inferBrowserWorkspaceTitle(url, t),
        partition: resolveBrowserWorkspaceTabPartition(sectionKey),
        show: true,
      };
      const { tab } = await client.openBrowserWorkspaceTab(request);
      await loadWorkspace({ preferTabId: tab.id, silent: true });
      setSelectedTabId(tab.id);
      setLocationInput(tab.url);
      setLocationDirty(false);
    },
    [loadWorkspace, t],
  );

  const activateBrowserWorkspaceTab = useCallback(
    async (tabId: string) => {
      setSelectedTabId(tabId);
      const { tab } = await client.showBrowserWorkspaceTab(tabId);
      await loadWorkspace({ preferTabId: tab.id, silent: true });
    },
    [loadWorkspace],
  );

  const navigateSelectedBrowserWorkspaceTab = useCallback(
    async (rawUrl: string) => {
      if (selectedTab && isInternalBrowserWorkspaceTab(selectedTab)) {
        throw new Error(
          t("browserworkspace.InternalTabUrlManaged", {
            defaultValue: "This internal tab manages its own URL.",
          }),
        );
      }
      const url = normalizeBrowserWorkspaceInputUrl(rawUrl, t);
      if (!url) {
        throw new Error(
          t("browserworkspace.EnterUrlToNavigate", {
            defaultValue: "Enter a URL to navigate.",
          }),
        );
      }
      if (!selectedTabId) {
        await openNewBrowserWorkspaceTab(url);
        return;
      }
      const { tab } = await client.navigateBrowserWorkspaceTab(
        selectedTabId,
        url,
      );
      if (workspace.mode === "web") {
        // React won't re-navigate an existing iframe when only the src
        // attribute changes (same key = same DOM element). Set the src
        // directly via the ref in embedded web mode only.
        const iframe = iframeRefs.current.get(selectedTabId);
        if (iframe && iframe.src !== tab.url) {
          iframe.src = tab.url;
        }
      }
      await loadWorkspace({ preferTabId: tab.id, silent: true });
      setLocationInput(tab.url);
      setLocationDirty(false);
    },
    [
      loadWorkspace,
      openNewBrowserWorkspaceTab,
      selectedTab,
      selectedTabId,
      t,
      workspace.mode,
    ],
  );

  const registerBrowserWorkspaceIframe = useCallback(
    (tabId: string, iframe: HTMLIFrameElement | null) => {
      if (!iframe) {
        iframeRefs.current.delete(tabId);
        return;
      }
      iframeRefs.current.set(tabId, iframe);
    },
    [],
  );

  const { postBrowserWalletReady } = useBrowserWorkspaceWalletBridge({
    iframeRefs,
    workspaceTabs: workspace.mode === "web" ? workspace.tabs : [],
    walletState: browserWalletState,
    loadWalletState: loadBrowserWalletState,
  });

  const closeBrowserWorkspaceTabById = useCallback(
    async (tabId: string) => {
      await client.closeBrowserWorkspaceTab(tabId);
      const snapshot = await client.getBrowserWorkspace();
      const nextId =
        snapshot.tabs.find((tab) => tab.id === selectedTabId)?.id ??
        snapshot.tabs[0]?.id ??
        null;
      if (nextId && nextId !== selectedTabId) {
        await client.showBrowserWorkspaceTab(nextId);
      }
      await loadWorkspace({
        preferTabId: nextId,
        silent: true,
      });
    },
    [loadWorkspace, selectedTabId],
  );

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    persistBrowserWorkspaceCollapsedSections(collapsedSections);
  }, [collapsedSections]);

  useEffect(() => {
    void loadBrowserWalletState();
  }, [loadBrowserWalletState]);

  useEffect(() => {
    if (workspace.mode !== "web" || !browserBridgeSupported) {
      setBrowserBridgeAvailable(false);
      setBrowserBridgeCompanions([]);
      setBrowserBridgePackageStatus(null);
      setBrowserBridgeLoading(false);
      return;
    }
    void loadBrowserBridgeState();
  }, [browserBridgeSupported, loadBrowserBridgeState, workspace.mode]);

  useIntervalWhenDocumentVisible(() => {
    void loadWorkspace({ preferTabId: selectedTabId, silent: true });
  }, POLL_INTERVAL_MS);

  useEffect(() => {
    if (!selectedTabId || !isBrowserWorkspaceSessionMode(workspace.mode)) {
      setSnapshotError(null);
      return;
    }
    void loadSelectedBrowserWorkspaceSnapshot(selectedTabId, workspace.mode);
  }, [loadSelectedBrowserWorkspaceSnapshot, selectedTabId, workspace.mode]);

  useIntervalWhenDocumentVisible(
    () => {
      if (!selectedTabId || !isBrowserWorkspaceSessionMode(workspace.mode)) {
        return;
      }
      void loadSelectedBrowserWorkspaceSnapshot(selectedTabId, workspace.mode);
    },
    POLL_INTERVAL_MS,
    Boolean(selectedTabId) && isBrowserWorkspaceSessionMode(workspace.mode),
  );

  useIntervalWhenDocumentVisible(() => {
    void loadBrowserWalletState();
  }, 5_000);

  useIntervalWhenDocumentVisible(
    () => {
      void loadBrowserBridgeState({ silent: true });
    },
    BROWSER_BRIDGE_POLL_INTERVAL_MS,
    workspace.mode === "web" && browserBridgeSupported,
  );

  useEffect(() => {
    const currentSelectedId = selectedTab?.id ?? null;
    if (currentSelectedId !== previousSelectedTabIdRef.current) {
      previousSelectedTabIdRef.current = currentSelectedId;
      setLocationInput(selectedTab?.url ?? "");
      setLocationDirty(false);
      return;
    }
    if (!locationDirty) {
      setLocationInput(selectedTab?.url ?? "");
    }
  }, [locationDirty, selectedTab?.id, selectedTab?.url]);

  useEffect(() => {
    if (
      !initialBrowseUrlRef.current ||
      initialBrowseHandledRef.current ||
      loading
    ) {
      return;
    }

    initialBrowseHandledRef.current = true;
    const existing = workspace.tabs.find(
      (tab) => tab.url === initialBrowseUrlRef.current,
    );
    if (existing) {
      void runBrowserWorkspaceAction(
        `show:${existing.id}`,
        async () => {
          await activateBrowserWorkspaceTab(existing.id);
        },
        t("browserworkspace.OpenInitialBrowseFailed", {
          defaultValue: "Failed to activate the requested browser tab.",
        }),
      );
      return;
    }

    void runBrowserWorkspaceAction(
      "open:initial-browse",
      async () => {
        await openNewBrowserWorkspaceTab(initialBrowseUrlRef.current ?? "");
      },
      t("browserworkspace.OpenInitialBrowseFailed", {
        defaultValue: "Failed to open the requested browser tab.",
      }),
    );
  }, [
    activateBrowserWorkspaceTab,
    loading,
    openNewBrowserWorkspaceTab,
    runBrowserWorkspaceAction,
    t,
    workspace.tabs,
  ]);

  // When the workspace loads with no tabs (and the ?browse= path isn't going
  // to open one), auto-open the Milady homepage so the user lands on a live
  // page instead of a dead empty state. Runs exactly once per mount.
  useEffect(() => {
    if (initialBlankTabHandledRef.current) return;
    if (loading || loadError) return;
    if (initialBrowseUrlRef.current) return;
    if (workspace.tabs.length > 0) {
      initialBlankTabHandledRef.current = true;
      return;
    }
    initialBlankTabHandledRef.current = true;
    void runBrowserWorkspaceAction(
      "open:initial-home",
      async () => {
        await openNewBrowserWorkspaceTab("https://milady.ai/");
      },
      t("browserworkspace.OpenInitialHomeFailed", {
        defaultValue: "Failed to open the Milady homepage.",
      }),
    );
  }, [
    loadError,
    loading,
    openNewBrowserWorkspaceTab,
    runBrowserWorkspaceAction,
    t,
    workspace.tabs.length,
  ]);

  const reloadSelectedBrowserWorkspaceTab = useCallback(async () => {
    if (!selectedTab) return;
    if (workspace.mode === "web") {
      const iframe = iframeRefs.current.get(selectedTab.id);
      if (iframe) {
        iframe.src = selectedTab.url;
      }
      return;
    }
    await client.navigateBrowserWorkspaceTab(selectedTab.id, selectedTab.url);
  }, [selectedTab, workspace.mode]);

  const installBrowserBridgeExtension = useCallback(async () => {
    await runBrowserWorkspaceAction(
      "browser-bridge:install",
      async () => {
        let nextPackageStatus = browserBridgePackageStatus;
        if (!nextPackageStatus?.chromeBuildPath) {
          const buildResponse = await client.fetch<{
            status: BrowserBridgeCompanionPackageStatus;
          }>("/api/browser-bridge/packages/chrome/build", {
            method: "POST",
          });
          nextPackageStatus = buildResponse.status;
          setBrowserBridgePackageStatus(buildResponse.status);
        }

        const revealResponse = await client.fetch<{
          path: string;
          target: string;
          revealOnly: boolean;
        }>("/api/browser-bridge/packages/open-path", {
          method: "POST",
          body: JSON.stringify({
            target: "chrome_build",
            revealOnly: true,
          }),
        });

        let openedManager = true;
        try {
          await client.fetch(
            "/api/browser-bridge/packages/chrome/open-manager",
            {
              method: "POST",
            },
          );
        } catch {
          openedManager = false;
        }

        setActionNoticeRef.current(
          openedManager
            ? t("browserworkspace.BrowserBridgeChromeReady", {
                defaultValue:
                  "Chrome is ready. Click Load unpacked and choose {{path}}.",
                path: revealResponse.path,
              })
            : t("browserworkspace.BrowserBridgeFolderReady", {
                defaultValue:
                  "The Agent Browser Bridge folder is ready at {{path}}. Open chrome://extensions, click Load unpacked, and choose that folder.",
                path: revealResponse.path,
              }),
          "success",
          6_000,
        );
        await loadBrowserBridgeState({ silent: true });
      },
      t("browserworkspace.InstallBrowserBridgeFailed", {
        defaultValue: "Failed to prepare the Agent Browser Bridge extension.",
      }),
    );
  }, [
    browserBridgePackageStatus,
    loadBrowserBridgeState,
    runBrowserWorkspaceAction,
    t,
  ]);

  const revealBrowserBridgeFolder = useCallback(async () => {
    await runBrowserWorkspaceAction(
      "browser-bridge:reveal-folder",
      async () => {
        const response = await client.fetch<{
          path: string;
          target: string;
          revealOnly: boolean;
        }>("/api/browser-bridge/packages/open-path", {
          method: "POST",
          body: JSON.stringify({
            target: "chrome_build",
            revealOnly: true,
          }),
        });
        setActionNoticeRef.current(
          t("browserworkspace.BrowserBridgeFolderRevealed", {
            defaultValue:
              "Revealed the Agent Browser Bridge folder at {{path}}.",
            path: response.path,
          }),
          "success",
          4_000,
        );
      },
      t("browserworkspace.OpenBrowserBridgeFolderFailed", {
        defaultValue:
          "Failed to reveal the Agent Browser Bridge extension folder.",
      }),
    );
  }, [runBrowserWorkspaceAction, t]);

  const openBrowserBridgeChromeExtensions = useCallback(async () => {
    await runBrowserWorkspaceAction(
      "browser-bridge:open-manager",
      async () => {
        await client.fetch("/api/browser-bridge/packages/chrome/open-manager", {
          method: "POST",
        });
        setActionNoticeRef.current(
          t("browserworkspace.BrowserBridgeOpenedChromeExtensions", {
            defaultValue:
              "Opened Chrome extensions. Click Load unpacked and choose the Agent Browser Bridge folder.",
          }),
          "success",
          4_000,
        );
      },
      t("browserworkspace.OpenBrowserBridgeManagerFailed", {
        defaultValue: "Failed to open Chrome extensions.",
      }),
    );
  }, [runBrowserWorkspaceAction, t]);

  const refreshBrowserBridgeConnection = useCallback(async () => {
    await runBrowserWorkspaceAction(
      "browser-bridge:refresh",
      async () => {
        await loadBrowserBridgeState({ silent: true });
        setActionNoticeRef.current(
          t("browserworkspace.BrowserBridgeRefreshSuccess", {
            defaultValue: "Refreshed Agent Browser Bridge connection status.",
          }),
          "success",
          3_000,
        );
      },
      t("browserworkspace.RefreshBrowserBridgeFailed", {
        defaultValue: "Failed to refresh Agent Browser Bridge status.",
      }),
    );
  }, [loadBrowserBridgeState, runBrowserWorkspaceAction, t]);

  const browserPageScopeCopy = useMemo(
    () =>
      getBrowserPageScopeCopy({
        browserBridgeConnected,
        browserBridgeInstallAvailable: browserBridgeSupported,
        browserLabel: primaryBrowserBridgeCompanion?.browser,
        profileLabel: primaryBrowserBridgeCompanion?.profileLabel,
      }),
    [
      browserBridgeConnected,
      browserBridgeSupported,
      primaryBrowserBridgeCompanion?.browser,
      primaryBrowserBridgeCompanion?.profileLabel,
    ],
  );

  const browserChatActions =
    !browserBridgeSupported || browserBridgeConnected ? null : (
      <>
        <Button
          size="sm"
          disabled={busyAction !== null}
          onClick={() => void installBrowserBridgeExtension()}
        >
          {t("browserworkspace.InstallBrowserBridge", {
            defaultValue: "Install Agent Browser Bridge",
          })}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={
            busyAction !== null || !browserBridgePackageStatus?.chromeBuildPath
          }
          onClick={() => void revealBrowserBridgeFolder()}
        >
          <FolderOpen className="h-4 w-4" />
          {t("browserworkspace.OpenBrowserBridgeFolder", {
            defaultValue: "Open extension folder",
          })}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busyAction !== null}
          onClick={() => void openBrowserBridgeChromeExtensions()}
        >
          {t("browserworkspace.OpenChromeExtensions", {
            defaultValue: "Open Chrome extensions",
          })}
        </Button>
      </>
    );

  const browserPageScopedChatPaneProps = useMemo<
    NonNullable<AppWorkspaceChromeProps["pageScopedChatPaneProps"]>
  >(
    () => ({
      introOverride: {
        title: browserPageScopeCopy.title,
        body: browserPageScopeCopy.body,
        actions: browserChatActions,
      },
      systemAddendumOverride: browserPageScopeCopy.systemAddendum,
      placeholderOverride: browserBridgeConnected
        ? t("browserworkspace.ChatPlaceholderConnected", {
            defaultValue: "Message",
          })
        : t("browserworkspace.ChatPlaceholderInstallBridge", {
            defaultValue: "Message",
          }),
    }),
    [browserBridgeConnected, browserChatActions, browserPageScopeCopy, t],
  );

  const tabsLabel = t("browserworkspace.Tabs", {
    defaultValue: "Tabs",
  });
  const userTabsLabel = t("browserworkspace.UserTabs", {
    defaultValue: "User Tabs",
  });
  const agentTabsLabel = t("browserworkspace.AgentTabs", {
    defaultValue: "Agent Tabs",
  });
  const appTabsLabel = t("browserworkspace.AppTabs", {
    defaultValue: "App Tabs",
  });
  const newTabLabel = t("browserworkspace.NewTab", {
    defaultValue: "New tab",
  });
  const closeTabLabel = t("browserworkspace.CloseTab", {
    defaultValue: "Close tab",
  });
  const goLabel = t("browserworkspace.Go", {
    defaultValue: "Go",
  });

  function renderBrowserWorkspaceTabRow(tab: BrowserWorkspaceTab): JSX.Element {
    const active = tab.id === selectedTabId;
    const tabHasSessionFocus = workspace.mode === "web" ? tab.visible : active;
    const label = getBrowserWorkspaceTabLabel(tab, t);
    const description = getBrowserWorkspaceTabDescription(tab, workspace.mode);
    const tabIsInternal = isInternalBrowserWorkspaceTab(tab);

    return (
      <div key={tab.id} className="group relative">
        <button
          type="button"
          role="tab"
          aria-selected={active}
          aria-current={active ? "page" : undefined}
          title={tab.url}
          onClick={() =>
            void runBrowserWorkspaceAction(`show:${tab.id}`, async () => {
              await activateBrowserWorkspaceTab(tab.id);
            })
          }
          className={`flex w-full min-w-0 items-start gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-1 text-left transition-colors ${
            tabIsInternal ? "pr-1.5" : "pr-7"
          } ${active ? "bg-bg-muted/50 text-txt" : "text-txt hover:bg-bg-muted/50"}`}
        >
          <span className="mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted/70">
            {tabHasSessionFocus ? (
              <>
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full bg-accent shadow-[0_0_4px_var(--accent)]"
                />
                <span className="sr-only">
                  {t("browserworkspace.AgentActive", {
                    defaultValue: "Agent is on this tab",
                  })}
                </span>
              </>
            ) : (
              <span className="text-[10px] font-semibold leading-none">
                {getBrowserWorkspaceTabMonogram(label)}
              </span>
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs-tight font-medium leading-snug">
              {label}
            </span>
            <span className="block truncate text-[11px] leading-snug text-muted/65">
              {description}
            </span>
          </span>
        </button>
        {tabIsInternal ? null : (
          <button
            type="button"
            aria-label={closeTabLabel}
            title={closeTabLabel}
            className="absolute right-0 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-[var(--radius-sm)] text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-bg-muted/50 hover:text-danger"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void runBrowserWorkspaceAction(`close:${tab.id}`, async () => {
                await closeBrowserWorkspaceTabById(tab.id);
              });
            }}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  }

  const browserTabsSidebar = (
    <AppPageSidebar
      testId="browser-workspace-sidebar"
      collapsible
      contentIdentity="browser-workspace-tabs"
      collapseButtonTestId="browser-workspace-sidebar-collapse-toggle"
      expandButtonTestId="browser-workspace-sidebar-expand-toggle"
      collapseButtonAriaLabel={t("browserworkspace.CollapseTabs", {
        defaultValue: "Collapse browser tabs",
      })}
      expandButtonAriaLabel={t("browserworkspace.ExpandTabs", {
        defaultValue: "Expand browser tabs",
      })}
      mobileTitle={
        <SidebarContent.SectionLabel>{tabsLabel}</SidebarContent.SectionLabel>
      }
      collapsedRailAction={
        <SidebarCollapsedActionButton
          aria-label={newTabLabel}
          onClick={() =>
            void runBrowserWorkspaceAction("open:new", async () => {
              await openNewBrowserWorkspaceTab(
                newBrowserWorkspaceTabSeedUrl,
                "user",
              );
            })
          }
        >
          <Plus className="h-4 w-4" />
        </SidebarCollapsedActionButton>
      }
      collapsedRailItems={collapsedRailTabs.map((tab) => {
        const label = getBrowserWorkspaceTabLabel(tab, t);
        const active = tab.id === selectedTabId;
        const tabHasSessionFocus =
          workspace.mode === "web" ? tab.visible : active;
        return (
          <SidebarContent.RailItem
            key={tab.id}
            aria-label={label}
            title={label}
            active={active}
            indicatorTone={tabHasSessionFocus ? "accent" : undefined}
            onClick={() =>
              void runBrowserWorkspaceAction(`show:${tab.id}`, async () => {
                await activateBrowserWorkspaceTab(tab.id);
              })
            }
          >
            {getBrowserWorkspaceTabMonogram(label)}
          </SidebarContent.RailItem>
        );
      })}
      aria-label={tabsLabel}
    >
      <SidebarScrollRegion className="scrollbar-hide px-1 pb-3 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <SidebarPanel className="bg-transparent gap-0 p-0 shadow-none">
          <div className="space-y-3">
            <CollapsibleSidebarSection
              sectionKey="user"
              label={userTabsLabel}
              collapsed={collapsedSections.has("user")}
              onToggleCollapsed={toggleSidebarSectionCollapsed}
              onAdd={() =>
                void runBrowserWorkspaceAction("open:new", async () => {
                  await openNewBrowserWorkspaceTab(
                    newBrowserWorkspaceTabSeedUrl,
                    "user",
                  );
                })
              }
              addLabel={newTabLabel}
              emptyLabel={t("browserworkspace.NoUserTabs", {
                defaultValue: "No user tabs yet.",
              })}
              emptyClassName="pl-3 pr-2 py-1 text-2xs text-muted/70"
              bodyClassName="space-y-0.5 pl-3"
              hoverActionsOnDesktop
              testIdPrefix="browser-tab-section"
            >
              {groupedTabs.user.length > 0 ? (
                <div
                  role="tablist"
                  aria-label={userTabsLabel}
                  className="space-y-1"
                >
                  {groupedTabs.user.map((tab) =>
                    renderBrowserWorkspaceTabRow(tab),
                  )}
                </div>
              ) : null}
            </CollapsibleSidebarSection>

            <CollapsibleSidebarSection
              sectionKey="agent"
              label={agentTabsLabel}
              collapsed={collapsedSections.has("agent")}
              onToggleCollapsed={toggleSidebarSectionCollapsed}
              emptyLabel={t("browserworkspace.NoAgentTabs", {
                defaultValue: "No agent tabs yet.",
              })}
              emptyClassName="pl-3 pr-2 py-1 text-2xs text-muted/70"
              bodyClassName="space-y-0.5 pl-3"
              hoverActionsOnDesktop
              testIdPrefix="browser-tab-section"
            >
              {groupedTabs.agent.length > 0 ? (
                <div
                  role="tablist"
                  aria-label={agentTabsLabel}
                  className="space-y-1"
                >
                  {groupedTabs.agent.map((tab) =>
                    renderBrowserWorkspaceTabRow(tab),
                  )}
                </div>
              ) : null}
            </CollapsibleSidebarSection>

            <CollapsibleSidebarSection
              sectionKey="app"
              label={appTabsLabel}
              collapsed={collapsedSections.has("app")}
              onToggleCollapsed={toggleSidebarSectionCollapsed}
              emptyLabel={t("browserworkspace.NoAppTabs", {
                defaultValue: "No app tabs yet.",
              })}
              emptyClassName="pl-3 pr-2 py-1 text-2xs text-muted/70"
              bodyClassName="space-y-0.5 pl-3"
              hoverActionsOnDesktop
              testIdPrefix="browser-tab-section"
            >
              {groupedTabs.app.length > 0 ? (
                <div
                  role="tablist"
                  aria-label={appTabsLabel}
                  className="space-y-1"
                >
                  {groupedTabs.app.map((tab) =>
                    renderBrowserWorkspaceTabRow(tab),
                  )}
                </div>
              ) : null}
            </CollapsibleSidebarSection>
          </div>
        </SidebarPanel>
      </SidebarScrollRegion>
    </AppPageSidebar>
  );

  const navNode = (
    <div className="flex items-center gap-2 border-b border-border/30 bg-card/20 px-3 py-2">
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        aria-label={t("common.refresh", { defaultValue: "Refresh" })}
        disabled={!selectedTab || busyAction !== null}
        onClick={() =>
          void runBrowserWorkspaceAction("reload:selected", async () => {
            await reloadSelectedBrowserWorkspaceTab();
          })
        }
      >
        <RefreshCw className="h-4 w-4" />
      </Button>
      <Input
        value={locationInput}
        onChange={(event) => {
          setLocationInput(event.target.value);
          setLocationDirty(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void runBrowserWorkspaceAction("navigate:enter", async () => {
              await navigateSelectedBrowserWorkspaceTab(locationInput);
            });
          }
        }}
        placeholder={t("browserworkspace.AddressPlaceholder", {
          defaultValue: selectedTabIsInternal
            ? "Internal tab URL is managed by the app"
            : "Enter a URL",
        })}
        disabled={busyAction !== null || selectedTabIsInternal}
        className="h-8 flex-1 rounded-full border-border/40 bg-card/70 px-4 text-sm text-txt"
      />
      <Button
        variant="outline"
        size="sm"
        className="h-8 shrink-0 px-3"
        aria-label={goLabel}
        disabled={busyAction !== null || locationInput.trim().length === 0}
        onClick={() =>
          void runBrowserWorkspaceAction("navigate:click", async () => {
            await navigateSelectedBrowserWorkspaceTab(locationInput);
          })
        }
      >
        {goLabel}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        aria-label={t("browserworkspace.OpenExternal", {
          defaultValue: "Open external",
        })}
        disabled={!selectedTab || busyAction !== null}
        onClick={() =>
          void runBrowserWorkspaceAction("open:external", async () => {
            if (!selectedTab) return;
            await openExternalUrl(selectedTab.url);
          })
        }
      >
        <ExternalLink className="h-4 w-4" />
      </Button>
    </div>
  );

  const browserSurface = (
    <div className="relative flex-1 min-h-0 overflow-hidden bg-bg">
      {loadError ? (
        <div
          className="absolute left-1/2 top-6 z-20 -translate-x-1/2 rounded-md border border-danger/50 bg-danger/15 px-3 py-1.5 text-xs text-danger"
          role="alert"
        >
          {loadError}
        </div>
      ) : null}

      {workspace.tabs.length === 0 ? (
        <div className="flex h-full items-center justify-center">
          <div className="flex max-w-sm flex-col items-center gap-2 text-center">
            <div className="text-sm font-semibold text-txt">
              {loading
                ? t("browserworkspace.Loading", {
                    defaultValue: "Loading browser workspace",
                  })
                : t("browserworkspace.EmptyTitle", {
                    defaultValue: "No browser tabs yet",
                  })}
            </div>
            <div className="text-xs text-muted">
              {isBrowserWorkspaceSessionMode(workspace.mode)
                ? t("browserworkspace.EmptySessionDescription", {
                    defaultValue:
                      "Open a page to start a real browser session. The preview here follows the session instead of embedding the target site directly.",
                  })
                : t("browserworkspace.EmptyDescription", {
                    defaultValue: "Open a page here to get started.",
                  })}
            </div>
            {!loading && workspace.mode === "web" && browserBridgeSupported ? (
              <div className="mt-3 flex w-full flex-col gap-3 rounded-md border border-border/40 bg-card/35 p-3 text-left">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-txt">
                      {t("browserworkspace.BrowserBridgeTitle", {
                        defaultValue: "Agent Browser Bridge",
                      })}
                    </div>
                    <div className="mt-1 text-xs leading-5 text-muted">
                      {t("browserworkspace.BrowserBridgeDescription", {
                        defaultValue:
                          "The agent can drive your real Chrome tabs with the Agent Browser Bridge extension.",
                      })}
                    </div>
                    <div className="mt-1 truncate text-[11px] text-muted">
                      {browserBridgeConnected
                        ? t("browserworkspace.BrowserBridgeConnected", {
                            defaultValue: "Connected",
                          })
                        : browserBridgeAvailable
                          ? t("browserworkspace.BrowserBridgeAvailable", {
                              defaultValue: "Extension available",
                            })
                          : t("browserworkspace.BrowserBridgeNotConnected", {
                              defaultValue: "Not connected",
                            })}
                      {browserBridgePackageStatus?.chromeBuildPath
                        ? ` - ${browserBridgePackageStatus.chromeBuildPath}`
                        : ""}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    aria-label={t("browserworkspace.RefreshBrowserBridge", {
                      defaultValue: "Refresh Agent Browser Bridge",
                    })}
                    disabled={browserBridgeLoading || busyAction !== null}
                    onClick={() => void refreshBrowserBridgeConnection()}
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={busyAction !== null}
                    onClick={() => void installBrowserBridgeExtension()}
                  >
                    {t("browserworkspace.InstallBrowserBridge", {
                      defaultValue: "Install Agent Browser Bridge",
                    })}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      busyAction !== null ||
                      !browserBridgePackageStatus?.chromeBuildPath
                    }
                    onClick={() => void revealBrowserBridgeFolder()}
                  >
                    <FolderOpen className="h-4 w-4" />
                    {t("browserworkspace.OpenBrowserBridgeFolder", {
                      defaultValue: "Open extension folder",
                    })}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyAction !== null}
                    onClick={() => void openBrowserBridgeChromeExtensions()}
                  >
                    {t("browserworkspace.OpenChromeExtensions", {
                      defaultValue: "Open Chrome extensions",
                    })}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : workspace.mode === "web" ? (
        workspace.tabs.map((tab) => {
          const active = tab.id === selectedTabId;
          const highlighted = tab.visible;
          const frameBlocked = isBrowserWorkspaceFrameBlockedUrl(tab.url);
          const visibilityClass = active
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0";
          if (frameBlocked) {
            return (
              <div
                key={tab.id}
                className={`absolute inset-0 flex h-full w-full items-center justify-center bg-bg px-6 text-center transition-opacity ${visibilityClass}`}
              >
                <div className="flex max-w-md flex-col items-center gap-3">
                  <div className="text-sm font-semibold text-txt">
                    {t("browserworkspace.FrameBlockedTitle", {
                      defaultValue: "Open this site outside the iframe",
                    })}
                  </div>
                  <div className="text-xs leading-5 text-muted">
                    {t("browserworkspace.FrameBlockedDescription", {
                      defaultValue:
                        "Discord blocks embedded browser frames. Use Milady Desktop Browser or a connected browser profile so LifeOps can inspect the page after login.",
                    })}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busyAction !== null}
                    onClick={() =>
                      void runBrowserWorkspaceAction(
                        `open:external:${tab.id}`,
                        async () => {
                          await openExternalUrl(tab.url);
                        },
                      )
                    }
                  >
                    <ExternalLink className="h-4 w-4" />
                    {t("browserworkspace.OpenExternal", {
                      defaultValue: "Open external",
                    })}
                  </Button>
                </div>
              </div>
            );
          }
          return (
            <iframe
              key={tab.id}
              ref={(iframe) => registerBrowserWorkspaceIframe(tab.id, iframe)}
              title={getBrowserWorkspaceTabLabel(tab, t)}
              src={tab.url}
              loading="eager"
              sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
              allow="clipboard-read; clipboard-write"
              referrerPolicy="strict-origin-when-cross-origin"
              // Use bg-bg + colorScheme so the iframe's UA scrollbars and any
              // pre-paint background match the outer app theme instead of
              // flashing white in dark mode. Embedded sites still pick their
              // own theme based on the OS prefers-color-scheme; we can't force
              // that cross-origin without an extension content script.
              className={`absolute inset-0 h-full w-full border-0 bg-bg transition-opacity ${visibilityClass}`}
              style={{ colorScheme: uiTheme }}
              onLoad={() =>
                highlighted
                  ? postBrowserWalletReady(tab, browserWalletState)
                  : undefined
              }
            />
          );
        })
      ) : (
        <div className="flex h-full flex-1 flex-col bg-bg">
          <div className="flex flex-wrap items-center gap-2 border-b border-border/30 bg-card/20 px-3 py-2 text-xs text-muted">
            <span className="rounded-full border border-border/40 bg-card/60 px-2 py-1 font-medium text-txt">
              {workspace.mode === "cloud"
                ? t("browserworkspace.CloudSession", {
                    defaultValue: "Cloud browser session",
                  })
                : t("browserworkspace.DesktopSession", {
                    defaultValue: "Desktop browser session",
                  })}
            </span>
            {selectedTab?.provider ? (
              <span>
                {t("common.provider", {
                  defaultValue: "Provider",
                })}
                {`: ${selectedTab.provider}`}
              </span>
            ) : null}
            {selectedTab?.status ? (
              <span>
                {t("common.status", {
                  defaultValue: "Status",
                })}
                {`: ${selectedTab.status}`}
              </span>
            ) : null}
            {selectedTabLiveViewUrl ? (
              <button
                type="button"
                className="rounded-md border border-border/40 px-2 py-1 text-txt hover:bg-card/60"
                onClick={() =>
                  void runBrowserWorkspaceAction(
                    "open:live-session",
                    async () => {
                      await openExternalUrl(selectedTabLiveViewUrl);
                    },
                  )
                }
              >
                {t("browserworkspace.OpenLiveSession", {
                  defaultValue: "Open live session",
                })}
              </button>
            ) : null}
          </div>

          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-card/15">
            {snapshotError ? (
              <div
                className="absolute left-1/2 top-6 z-20 -translate-x-1/2 rounded-md border border-danger/50 bg-danger/15 px-3 py-1.5 text-xs text-danger"
                role="alert"
              >
                {snapshotError}
              </div>
            ) : null}

            {selectedTabSnapshot ? (
              <img
                alt={
                  selectedTab
                    ? getBrowserWorkspaceTabLabel(selectedTab, t)
                    : t("browserworkspace.SessionPreview", {
                        defaultValue: "Browser session preview",
                      })
                }
                src={`data:image/png;base64,${selectedTabSnapshot}`}
                className="h-full w-full object-contain"
              />
            ) : (
              <div className="flex max-w-sm flex-col items-center gap-2 px-6 text-center">
                <div className="text-sm font-semibold text-txt">
                  {t("browserworkspace.SessionPreviewPending", {
                    defaultValue: "Waiting for browser session preview",
                  })}
                </div>
                <div className="text-xs text-muted">
                  {t("browserworkspace.SessionPreviewPendingDescription", {
                    defaultValue:
                      "The page is running in a real browser session. A fresh preview will appear here as the session updates.",
                  })}
                </div>
              </div>
            )}
          </div>

          {selectedTab ? (
            <div className="border-t border-border/30 bg-card/20 px-3 py-2 text-xs text-muted">
              <div className="truncate font-medium text-txt">
                {getBrowserWorkspaceTabLabel(selectedTab, t)}
              </div>
              <div className="truncate">{selectedTab.url}</div>
              <div className="mt-1">
                {selectedTabIsInternal
                  ? t("browserworkspace.InternalSessionDescription", {
                      defaultValue:
                        "This is an internal app-managed browser session. Use LifeOps actions to steer it; the URL is locked in the Browser view.",
                    })
                  : t("browserworkspace.RealSessionDescription", {
                      defaultValue:
                        "This is a real browser session, not a raw iframe embed. Use chat or browser actions to navigate and interact with sites like Google and Discord.",
                    })}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );

  const mainNode = (
    <WorkspaceLayout
      sidebar={browserTabsSidebar}
      contentHeader={navNode}
      contentHeaderClassName="mb-0"
      headerPlacement="inside"
      contentPadding={false}
      contentClassName="overflow-hidden"
      contentInnerClassName="min-h-0 overflow-hidden"
      mobileSidebarLabel={tabsLabel}
      mobileSidebarTriggerClassName="ml-3 mt-3"
    >
      {browserSurface}
    </WorkspaceLayout>
  );

  return (
    <AppWorkspaceChrome
      testId="browser-workspace-view"
      main={mainNode}
      chatScope="page-browser"
      pageScopedChatPaneProps={browserPageScopedChatPaneProps}
    />
  );
}
