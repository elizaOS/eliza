import {
  type BrowserWorkspaceWalletState,
  buildBrowserWorkspaceWalletState,
} from "@elizaos/app-steward/browser-workspace-wallet";
import { Button, Input } from "@elizaos/ui";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  MessageSquare,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
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
import { ChatView } from "./ChatView.js";
import { useBrowserWorkspaceWalletBridge } from "./useBrowserWorkspaceWalletBridge";

const POLL_INTERVAL_MS = 2_500;

function normalizeBrowserWorkspaceInputUrl(rawUrl: string): string | null {
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
    throw new Error("Enter a valid http or https URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https pages can be embedded.");
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

function inferBrowserWorkspaceTitle(url: string): string {
  if (url === "about:blank") return "New Tab";
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "Browser";
  } catch {
    return "Browser";
  }
}

function getBrowserWorkspaceTabLabel(tab: BrowserWorkspaceTab): string {
  const trimmedTitle = tab.title.trim();
  if (trimmedTitle && trimmedTitle !== "Browser") return trimmedTitle;
  return inferBrowserWorkspaceTitle(tab.url);
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
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [chatSidebarCollapsed, setChatSidebarCollapsed] = useState(false);
  const initialBrowseUrlRef = useRef<string | null | undefined>(undefined);
  const initialBrowseHandledRef = useRef(false);
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
        ? normalizeBrowserWorkspaceInputUrl(browseParam)
        : null;
    } catch {
      initialBrowseUrlRef.current = null;
    }
  }

  const selectedTab = useMemo(
    () => workspace.tabs.find((tab) => tab.id === selectedTabId) ?? null,
    [selectedTabId, workspace.tabs],
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

  const openNewBrowserWorkspaceTab = useCallback(
    async (rawUrl: string) => {
      const url = normalizeBrowserWorkspaceInputUrl(rawUrl);
      if (!url) {
        throw new Error("Enter a URL to open.");
      }
      const request = {
        url,
        title: inferBrowserWorkspaceTitle(url),
        show: true,
      };
      const { tab } = await client.openBrowserWorkspaceTab(request);
      await loadWorkspace({ preferTabId: tab.id, silent: true });
      setSelectedTabId(tab.id);
      setLocationInput(tab.url);
      setLocationDirty(false);
    },
    [loadWorkspace],
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
      const url = normalizeBrowserWorkspaceInputUrl(rawUrl);
      if (!url) {
        throw new Error("Enter a URL to navigate.");
      }
      if (!selectedTabId) {
        await openNewBrowserWorkspaceTab(url);
        return;
      }
      const { tab } = await client.navigateBrowserWorkspaceTab(
        selectedTabId,
        url,
      );
      // React won't re-navigate an existing iframe when only the src attribute
      // changes (same key = same DOM element). Set the src directly via the ref.
      const iframe = iframeRefs.current.get(selectedTabId);
      if (iframe && iframe.src !== tab.url) {
        iframe.src = tab.url;
      }
      await loadWorkspace({ preferTabId: tab.id, silent: true });
      setLocationInput(tab.url);
      setLocationDirty(false);
    },
    [loadWorkspace, openNewBrowserWorkspaceTab, selectedTabId],
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
    workspaceTabs: workspace.tabs,
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
    const timer = window.setInterval(() => {
      void loadWorkspace({ preferTabId: selectedTabId, silent: true });
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadWorkspace, selectedTabId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadBrowserWalletState();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [loadBrowserWalletState]);

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

  const reloadSelectedBrowserWorkspaceTab = useCallback(() => {
    if (!selectedTab) return;
    const iframe = iframeRefs.current.get(selectedTab.id);
    if (iframe) {
      iframe.src = selectedTab.url;
    }
  }, [selectedTab]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-bg"
      data-testid="browser-workspace-view"
    >
      {/* Tab strip */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border/30 bg-card/30 px-2 pt-2">
        {workspace.tabs.map((tab) => {
          const active = tab.id === selectedTabId;
          const label = getBrowserWorkspaceTabLabel(tab);
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
              {tab.visible ? (
                <span
                  className="h-2 w-2 shrink-0 rounded-full bg-accent shadow-[0_0_6px_var(--accent)]"
                  aria-label={t("browserworkspace.AgentActive", {
                    defaultValue: "Agent is on this tab",
                  })}
                />
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
          onClick={reloadSelectedBrowserWorkspaceTab}
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

      {/* Content row — iframes on the left, chat sidebar on the right */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
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
                  {t("browserworkspace.EmptyDescription", {
                    defaultValue:
                      "Open a page here, or let the agent create tabs through the browser workspace plugin.",
                  })}
                </div>
              </div>
            </div>
          ) : (
            workspace.tabs.map((tab) => {
              const active = tab.id === selectedTabId;
              return (
                <iframe
                  key={tab.id}
                  ref={(iframe) =>
                    registerBrowserWorkspaceIframe(tab.id, iframe)
                  }
                  title={getBrowserWorkspaceTabLabel(tab)}
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
                  onLoad={() => postBrowserWalletReady(tab, browserWalletState)}
                />
              );
            })
          )}
        </div>

        <aside
          className={`flex shrink-0 flex-col border-l border-border/30 bg-bg transition-[width] duration-200 ${
            chatSidebarCollapsed ? "w-10" : "w-[24rem]"
          }`}
          data-testid="browser-workspace-chat-sidebar"
        >
          <div className="flex h-10 items-center justify-between border-b border-border/30 px-2">
            {chatSidebarCollapsed ? (
              <button
                type="button"
                className="mx-auto flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-card/60 hover:text-txt"
                aria-label={t("browserworkspace.ExpandChat", {
                  defaultValue: "Expand chat",
                })}
                onClick={() => setChatSidebarCollapsed(false)}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            ) : (
              <>
                <div className="flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-muted">
                  <MessageSquare className="h-3.5 w-3.5" />
                  {t("browserworkspace.ChatSidebar", { defaultValue: "Chat" })}
                </div>
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-card/60 hover:text-txt"
                  aria-label={t("browserworkspace.CollapseChat", {
                    defaultValue: "Collapse chat",
                  })}
                  onClick={() => setChatSidebarCollapsed(true)}
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </>
            )}
          </div>

          {chatSidebarCollapsed ? null : (
            <div className="flex min-h-0 flex-1 flex-col">
              <ChatView variant="default" hideTerminalPanel />
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
