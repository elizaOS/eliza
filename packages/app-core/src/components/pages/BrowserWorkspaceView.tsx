import {
  type BrowserWorkspaceWalletState,
  buildBrowserWorkspaceWalletState,
} from "@elizaos/app-steward/browser-workspace-wallet";
import type {
  LifeOpsBrowserCompanionPackageStatus,
  LifeOpsBrowserCompanionStatus,
} from "@elizaos/shared/contracts/lifeops";
import { Button, Input } from "@elizaos/ui";
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
import { AppWorkspaceChrome } from "../workspace/AppWorkspaceChrome.js";
import { getBrowserPageScopeCopy } from "./page-scoped-conversations.js";
import { PageScopedChatPane } from "./PageScopedChatPane.js";
import { useBrowserWorkspaceWalletBridge } from "./useBrowserWorkspaceWalletBridge";

const POLL_INTERVAL_MS = 2_500;
const LIFEOPS_BROWSER_POLL_INTERVAL_MS = 4_000;
type TranslateFn = (key: string, vars?: Record<string, unknown>) => string;

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
      t("browserworkspace.Browser", {
        defaultValue: "Browser",
      })
    );
  } catch {
    return t("browserworkspace.Browser", {
      defaultValue: "Browser",
    });
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
  const [lifeOpsBrowserAvailable, setLifeOpsBrowserAvailable] = useState(false);
  const [lifeOpsBrowserLoading, setLifeOpsBrowserLoading] = useState(true);
  const [lifeOpsBrowserCompanions, setLifeOpsBrowserCompanions] = useState<
    LifeOpsBrowserCompanionStatus[]
  >([]);
  const [lifeOpsBrowserPackageStatus, setLifeOpsBrowserPackageStatus] =
    useState<LifeOpsBrowserCompanionPackageStatus | null>(null);
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
  const primaryLifeOpsBrowserCompanion = useMemo(
    () =>
      lifeOpsBrowserCompanions.find(
        (companion) => companion.connectionState === "connected",
      ) ??
      lifeOpsBrowserCompanions[0] ??
      null,
    [lifeOpsBrowserCompanions],
  );
  const lifeOpsBrowserConnected =
    primaryLifeOpsBrowserCompanion?.connectionState === "connected";

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

  const loadLifeOpsBrowserState = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) {
        setLifeOpsBrowserLoading(true);
      }
      const [companionsResult, packageResult] = await Promise.allSettled([
        client.fetch<{ companions: LifeOpsBrowserCompanionStatus[] }>(
          "/api/lifeops/browser/companions",
        ),
        client.fetch<{ status: LifeOpsBrowserCompanionPackageStatus }>(
          "/api/lifeops/browser/packages",
        ),
      ]);
      if (companionsResult.status === "fulfilled") {
        setLifeOpsBrowserCompanions(companionsResult.value.companions);
      } else {
        setLifeOpsBrowserCompanions([]);
      }
      if (packageResult.status === "fulfilled") {
        setLifeOpsBrowserPackageStatus(packageResult.value.status);
      } else {
        setLifeOpsBrowserPackageStatus(null);
      }
      setLifeOpsBrowserAvailable(
        companionsResult.status === "fulfilled" ||
          packageResult.status === "fulfilled",
      );
      if (!options?.silent) {
        setLifeOpsBrowserLoading(false);
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
    async (rawUrl: string) => {
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

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    void loadBrowserWalletState();
  }, [loadBrowserWalletState]);

  useEffect(() => {
    if (workspace.mode !== "web") {
      setLifeOpsBrowserLoading(false);
      return;
    }
    void loadLifeOpsBrowserState();
  }, [loadLifeOpsBrowserState, workspace.mode]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadWorkspace({ preferTabId: selectedTabId, silent: true });
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadWorkspace, selectedTabId]);

  useEffect(() => {
    if (!selectedTabId || !isBrowserWorkspaceSessionMode(workspace.mode)) {
      setSnapshotError(null);
      return;
    }
    void loadSelectedBrowserWorkspaceSnapshot(selectedTabId, workspace.mode);
  }, [loadSelectedBrowserWorkspaceSnapshot, selectedTabId, workspace.mode]);

  useEffect(() => {
    if (!selectedTabId || !isBrowserWorkspaceSessionMode(workspace.mode)) {
      return;
    }
    const timer = window.setInterval(() => {
      void loadSelectedBrowserWorkspaceSnapshot(selectedTabId, workspace.mode);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadSelectedBrowserWorkspaceSnapshot, selectedTabId, workspace.mode]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadBrowserWalletState();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [loadBrowserWalletState]);

  useEffect(() => {
    if (workspace.mode !== "web") {
      return;
    }
    const timer = window.setInterval(() => {
      void loadLifeOpsBrowserState({ silent: true });
    }, LIFEOPS_BROWSER_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadLifeOpsBrowserState, workspace.mode]);

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

  const installLifeOpsBrowserExtension = useCallback(async () => {
    await runBrowserWorkspaceAction(
      "lifeops-browser:install",
      async () => {
        let nextPackageStatus = lifeOpsBrowserPackageStatus;
        if (!nextPackageStatus?.chromeBuildPath) {
          const buildResponse = await client.fetch<{
            status: LifeOpsBrowserCompanionPackageStatus;
          }>("/api/lifeops/browser/packages/chrome/build", {
            method: "POST",
          });
          nextPackageStatus = buildResponse.status;
          setLifeOpsBrowserPackageStatus(buildResponse.status);
        }

        const revealResponse = await client.fetch<{
          path: string;
          target: string;
          revealOnly: boolean;
        }>("/api/lifeops/browser/packages/open-path", {
          method: "POST",
          body: JSON.stringify({
            target: "chrome_build",
            revealOnly: true,
          }),
        });

        let openedManager = true;
        try {
          await client.fetch(
            "/api/lifeops/browser/packages/chrome/open-manager",
            {
              method: "POST",
            },
          );
        } catch {
          openedManager = false;
        }

        setActionNoticeRef.current(
          openedManager
            ? t("browserworkspace.LifeOpsChromeReady", {
                defaultValue:
                  "Chrome is ready. Click Load unpacked and choose {{path}}.",
                path: revealResponse.path,
              })
            : t("browserworkspace.LifeOpsFolderReady", {
                defaultValue:
                  "The LifeOps Browser folder is ready at {{path}}. Open chrome://extensions, click Load unpacked, and choose that folder.",
                path: revealResponse.path,
              }),
          "success",
          6_000,
        );
        await loadLifeOpsBrowserState({ silent: true });
      },
      t("browserworkspace.InstallLifeOpsBrowserFailed", {
        defaultValue: "Failed to prepare the LifeOps Browser extension.",
      }),
    );
  }, [
    lifeOpsBrowserPackageStatus,
    loadLifeOpsBrowserState,
    runBrowserWorkspaceAction,
    t,
  ]);

  const revealLifeOpsBrowserFolder = useCallback(async () => {
    await runBrowserWorkspaceAction(
      "lifeops-browser:reveal-folder",
      async () => {
        const response = await client.fetch<{
          path: string;
          target: string;
          revealOnly: boolean;
        }>("/api/lifeops/browser/packages/open-path", {
          method: "POST",
          body: JSON.stringify({
            target: "chrome_build",
            revealOnly: true,
          }),
        });
        setActionNoticeRef.current(
          t("browserworkspace.LifeOpsFolderRevealed", {
            defaultValue: "Revealed the LifeOps Browser folder at {{path}}.",
            path: response.path,
          }),
          "success",
          4_000,
        );
      },
      t("browserworkspace.OpenLifeOpsBrowserFolderFailed", {
        defaultValue: "Failed to reveal the LifeOps Browser extension folder.",
      }),
    );
  }, [runBrowserWorkspaceAction, t]);

  const openLifeOpsChromeExtensions = useCallback(async () => {
    await runBrowserWorkspaceAction(
      "lifeops-browser:open-manager",
      async () => {
        await client.fetch(
          "/api/lifeops/browser/packages/chrome/open-manager",
          {
            method: "POST",
          },
        );
        setActionNoticeRef.current(
          t("browserworkspace.LifeOpsOpenedChromeExtensions", {
            defaultValue:
              "Opened Chrome extensions. Click Load unpacked and choose the LifeOps Browser folder.",
          }),
          "success",
          4_000,
        );
      },
      t("browserworkspace.OpenLifeOpsBrowserManagerFailed", {
        defaultValue: "Failed to open Chrome extensions.",
      }),
    );
  }, [runBrowserWorkspaceAction, t]);

  const refreshLifeOpsBrowserConnection = useCallback(async () => {
    await runBrowserWorkspaceAction(
      "lifeops-browser:refresh",
      async () => {
        await loadLifeOpsBrowserState({ silent: true });
        setActionNoticeRef.current(
          t("browserworkspace.LifeOpsRefreshSuccess", {
            defaultValue: "Refreshed LifeOps Browser connection status.",
          }),
          "success",
          3_000,
        );
      },
      t("browserworkspace.RefreshLifeOpsBrowserFailed", {
        defaultValue: "Failed to refresh LifeOps Browser status.",
      }),
    );
  }, [loadLifeOpsBrowserState, runBrowserWorkspaceAction, t]);

  const navNode = (
    <>
      {/* Tab strip */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border/30 bg-card/30 px-2 pt-2">
        {workspace.tabs.map((tab) => {
          const active = tab.id === selectedTabId;
          const tabHasSessionFocus =
            workspace.mode === "web" ? tab.visible : active;
          const label = getBrowserWorkspaceTabLabel(tab, t);
          const activate = () =>
            void runBrowserWorkspaceAction(`show:${tab.id}`, async () => {
              await activateBrowserWorkspaceTab(tab.id);
            });
          return (
            // role="tab" on a div (not a button) because it hosts a nested
            // close button, and buttons can't nest interactive children.
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={tab.url}
              onClick={activate}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  activate();
                }
              }}
              className={`flex h-9 min-w-[8rem] max-w-[14rem] shrink-0 cursor-pointer items-center gap-2 rounded-t-lg border border-b-0 px-3 text-xs transition-colors ${
                active
                  ? "border-border/40 bg-bg text-txt"
                  : "border-transparent bg-card/30 text-muted hover:bg-card/60 hover:text-txt"
              }`}
            >
              {tabHasSessionFocus ? (
                <>
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full bg-accent shadow-[0_0_6px_var(--accent)]"
                  />
                  <span className="sr-only">
                    {t("browserworkspace.AgentActive", {
                      defaultValue: "Agent is on this tab",
                    })}
                  </span>
                </>
              ) : (
                <span
                  aria-hidden
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-muted/15 text-[10px] font-semibold text-muted"
                >
                  {getBrowserWorkspaceTabMonogram(label)}
                </span>
              )}
              <span className="flex-1 truncate text-left">{label}</span>
              <button
                type="button"
                aria-label={t("browserworkspace.CloseTab", {
                  defaultValue: "Close tab",
                })}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:bg-muted/20 hover:text-txt"
                onClick={(event) => {
                  event.stopPropagation();
                  void runBrowserWorkspaceAction(
                    `close:${tab.id}`,
                    async () => {
                      await client.closeBrowserWorkspaceTab(tab.id);
                      const snapshot = await client.getBrowserWorkspace();
                      const nextId =
                        snapshot.tabs.find((t) => t.id === selectedTabId)?.id ??
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
                  );
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-t-lg text-muted hover:bg-card/60 hover:text-txt"
          aria-label={t("browserworkspace.NewTab", {
            defaultValue: "New tab",
          })}
          disabled={busyAction !== null}
          onClick={() =>
            void runBrowserWorkspaceAction("open:new", async () => {
              await openNewBrowserWorkspaceTab(locationInput || "about:blank");
            })
          }
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* URL bar */}
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
            defaultValue: "Enter a URL",
          })}
          className="h-8 flex-1 rounded-full border-border/40 bg-card/70 px-4 text-sm text-txt"
        />
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
    </>
  );

  const mainNode = (
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
          </div>
        </div>
      ) : workspace.mode === "web" ? (
        workspace.tabs.map((tab) => {
          const active = tab.id === selectedTabId;
          const highlighted = tab.visible;
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
              className={`absolute inset-0 h-full w-full border-0 bg-white transition-opacity ${
                active
                  ? "pointer-events-auto opacity-100"
                  : "pointer-events-none opacity-0"
              }`}
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
                {t("browserworkspace.Provider", {
                  defaultValue: "Provider",
                })}
                {`: ${selectedTab.provider}`}
              </span>
            ) : null}
            {selectedTab?.status ? (
              <span>
                {t("browserworkspace.Status", {
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
                {t("browserworkspace.RealSessionDescription", {
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

  const browserPageCopy = useMemo(() => {
    const browserLabel =
      primaryLifeOpsBrowserCompanion?.browser === "safari" ? "Safari" : "Chrome";
    return getBrowserPageScopeCopy({
      lifeOpsConnected: lifeOpsBrowserConnected,
      browserLabel,
      profileLabel: primaryLifeOpsBrowserCompanion?.profileLabel ?? null,
    });
  }, [lifeOpsBrowserConnected, primaryLifeOpsBrowserCompanion]);

  const browserChatIntroActions = useMemo(() => {
    // Web mode without a connected extension is the only state where the user
    // needs the install entry points — in desktop/cloud modes the real
    // browser session runs server-side instead of via the companion.
    if (workspace.mode !== "web") return null;
    if (lifeOpsBrowserConnected) return null;
    if (!lifeOpsBrowserAvailable) return null;
    return (
      <>
        <Button
          type="button"
          size="sm"
          onClick={() => void installLifeOpsBrowserExtension()}
          disabled={busyAction !== null}
        >
          {t("browserworkspace.InstallLifeOpsBrowser", {
            defaultValue: "Install LifeOps Browser",
          })}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void refreshLifeOpsBrowserConnection()}
          disabled={busyAction !== null}
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          {t("common.refresh", { defaultValue: "Refresh" })}
        </Button>
        {lifeOpsBrowserPackageStatus?.chromeBuildPath ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void revealLifeOpsBrowserFolder()}
            disabled={busyAction !== null}
          >
            <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
            {t("browserworkspace.OpenExtensionFolder", {
              defaultValue: "Open extension folder",
            })}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void openLifeOpsChromeExtensions()}
          disabled={busyAction !== null}
        >
          {t("browserworkspace.OpenChromeExtensions", {
            defaultValue: "Open Chrome extensions",
          })}
        </Button>
      </>
    );
  }, [
    busyAction,
    installLifeOpsBrowserExtension,
    lifeOpsBrowserAvailable,
    lifeOpsBrowserConnected,
    lifeOpsBrowserPackageStatus,
    openLifeOpsChromeExtensions,
    refreshLifeOpsBrowserConnection,
    revealLifeOpsBrowserFolder,
    t,
    workspace.mode,
  ]);

  return (
    <AppWorkspaceChrome
      testId="browser-workspace-view"
      nav={navNode}
      main={mainNode}
      chat={
        <PageScopedChatPane
          scope="page-browser"
          introOverride={{
            title: browserPageCopy.title,
            body: browserPageCopy.body,
            actions: browserChatIntroActions,
          }}
          systemAddendumOverride={browserPageCopy.systemAddendum}
        />
      }
    />
  );
}
