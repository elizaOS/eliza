

import { ExternalLink, Plus, RefreshCw, X } from "lucide-react";
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
import {
  BROWSER_WALLET_READY_TYPE,
  BROWSER_WALLET_RESPONSE_TYPE,
  type BrowserWorkspaceWalletResponse,
  type BrowserWorkspaceWalletState,
  buildBrowserWorkspaceWalletState,
  isBrowserWorkspaceWalletRequest,
} from "@elizaos/app-steward/browser-workspace-wallet";
import { useApp } from "../../state";
import { openExternalUrl } from "../../utils";
import { WidgetHost } from "../../widgets";
import { PagePanel, MetaPill, SidebarCollapsedActionButton, SidebarContent, SidebarHeader, SidebarPanel, Sidebar, SidebarScrollRegion, Button, Input, PageLayout } from "@elizaos/ui";

const POLL_INTERVAL_MS = 2_500;
const DEFAULT_BROWSER_WALLET_CHAIN_ID = 1;
function normalizeBrowserWorkspaceInputUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "about:blank") {
    return trimmed;
  }

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
  if (typeof window === "undefined") {
    return null;
  }
  const rawSearch =
    window.location.search || window.location.hash.split("?")[1] || "";
  const params = new URLSearchParams(
    rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch,
  );
  const value = params.get(name)?.trim();
  return value ? value : null;
}

function inferBrowserWorkspaceTitle(url: string): string {
  if (url === "about:blank") {
    return "New Tab";
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "Browser";
  } catch {
    return "Browser";
  }
}

function getBrowserWorkspaceTabLabel(tab: BrowserWorkspaceTab): string {
  const trimmedTitle = tab.title.trim();
  if (trimmedTitle && trimmedTitle !== "Browser") {
    return trimmedTitle;
  }
  return inferBrowserWorkspaceTitle(tab.url);
}

function getBrowserWorkspaceRailMonogram(label: string): string {
  const alphanumeric = label.trim().replace(/[^a-z0-9]/gi, "");
  return (alphanumeric[0] ?? "B").toUpperCase();
}

function formatBrowserWorkspaceTimestamp(value: string | null): string {
  if (!value) {
    return "Idle";
  }
  try {
    return new Date(value).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "Idle";
  }
}

function formatBrowserWorkspaceWalletAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function resolveBrowserWorkspaceTargetOrigin(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin && origin !== "null" ? origin : null;
  } catch {
    return null;
  }
}

/**
 * Verify the postMessage origin against the tab's known URL and return a safe
 * targetOrigin for the response. Returns null if the origin cannot be verified.
 *
 * With `allow-same-origin` in the iframe sandbox, a malicious page could
 * present the parent's origin. We mitigate this by checking that the message
 * origin matches the origin derived from the tab's URL — the URL the user or
 * agent explicitly navigated to.
 *
 * @internal Exported for testing only.
 */
export function resolveBrowserWorkspaceMessageOrigin(
  origin: string,
  tabUrl?: string,
): string | null {
  if (!origin || origin === "null") {
    return null;
  }

  // If we know the tab's URL, verify the message origin matches.
  // This prevents a page loaded via allow-same-origin from spoofing
  // the parent origin to access wallet signing.
  if (tabUrl) {
    try {
      const expectedOrigin = new URL(tabUrl).origin;
      if (
        expectedOrigin &&
        expectedOrigin !== "null" &&
        origin !== expectedOrigin
      ) {
        return null;
      }
    } catch {
      // Malformed tab URL — reject.
      return null;
    }
  }

  return origin;
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

function formatBrowserWorkspaceChainId(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

function parseBrowserWorkspaceChainId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = trimmed.startsWith("0x")
    ? Number.parseInt(trimmed.slice(2), 16)
    : Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveBrowserWorkspaceWalletAccounts(
  state: BrowserWorkspaceWalletState,
): string[] {
  return state.evmAddress ? [state.evmAddress] : [];
}

/** @internal Exported for testing only. */
export function normalizeBrowserWorkspaceTxRequest(
  params: unknown,
  fallbackChainId: number,
): {
  broadcast: boolean;
  chainId: number;
  data?: string;
  description?: string;
  to: string;
  value: string;
} | null {
  const raw = Array.isArray(params) && params.length > 0 ? params[0] : params;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const chainId =
    parseBrowserWorkspaceChainId(value.chainId) ?? fallbackChainId;
  const to = typeof value.to === "string" ? value.to.trim() : "";
  // value is optional — ERC-20 and other contract calls legitimately omit it.
  // Default to "0x0" when absent so these calls aren't silently rejected.
  const amount =
    typeof value.value === "string"
      ? value.value.trim()
      : typeof value.value === "number"
        ? String(value.value)
        : "0x0";
  if (!to || !chainId || !Number.isFinite(chainId)) {
    return null;
  }
  return {
    broadcast: value.broadcast !== false,
    chainId,
    data: typeof value.data === "string" ? value.data : undefined,
    description:
      typeof value.description === "string" ? value.description : undefined,
    to,
    value: amount,
  };
}

function resolveBrowserWorkspaceMessageToSign(
  params: unknown,
  address: string | null,
): string | null {
  if (typeof params === "string") {
    return params;
  }
  if (!Array.isArray(params) || params.length === 0) {
    return null;
  }

  const first = params[0];
  const second = params[1];
  if (typeof first === "string" && typeof second === "string" && address) {
    if (first.toLowerCase() === address.toLowerCase()) {
      return second;
    }
    if (second.toLowerCase() === address.toLowerCase()) {
      return first;
    }
  }

  return typeof first === "string" ? first : null;
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
  const initialBrowseUrlRef = useRef<string | null | undefined>(undefined);
  const initialBrowseHandledRef = useRef(false);
  const iframeRefs = useRef(new Map<string, HTMLIFrameElement | null>());
  const getStewardPendingRef = useRef(getStewardPending);
  const getStewardStatusRef = useRef(getStewardStatus);
  const setActionNoticeRef = useRef(setActionNotice);
  const tRef = useRef(t);
  const walletAddressesRef = useRef(walletAddresses);
  const walletConfigRef = useRef(walletConfig);
  const browserWalletStateRef = useRef(browserWalletState);
  const browserWalletChainIdByTabRef = useRef(new Map<string, number>());
  const workspaceTabsRef = useRef(workspace.tabs);
  workspaceTabsRef.current = workspace.tabs;
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
  const walletStateRefreshKey = useMemo(
    () =>
      [
        walletAddresses?.evmAddress ?? "",
        walletAddresses?.solanaAddress ?? "",
        walletConfig?.evmAddress ?? "",
        walletConfig?.executionReady ? "1" : "0",
        walletConfig?.executionBlockedReason ?? "",
        walletConfig?.solanaAddress ?? "",
        walletConfig?.solanaSigningAvailable ? "1" : "0",
      ].join("|"),
    [walletAddresses, walletConfig],
  );

  useEffect(() => {
    browserWalletStateRef.current = browserWalletState;
  }, [browserWalletState]);

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

  const closeSelectedBrowserWorkspaceTab = useCallback(async () => {
    if (!selectedTabId) {
      return;
    }
    await client.closeBrowserWorkspaceTab(selectedTabId);
    // Fetch fresh tab list after closing — avoids stale closure refs that
    // could pick a tab the server no longer knows about.
    const snapshot = await client.getBrowserWorkspace();
    const nextTabId = snapshot.tabs[0]?.id ?? null;
    if (nextTabId) {
      await client.showBrowserWorkspaceTab(nextTabId);
    }
    await loadWorkspace({ preferTabId: nextTabId, silent: true });
  }, [loadWorkspace, selectedTabId]);

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

  const postBrowserWalletReady = useCallback(
    (tab: BrowserWorkspaceTab, state: BrowserWorkspaceWalletState) => {
      const iframeWindow = iframeRefs.current.get(tab.id)?.contentWindow;
      const targetOrigin = resolveBrowserWorkspaceTargetOrigin(tab.url);
      if (!iframeWindow || !targetOrigin) {
        return;
      }
      iframeWindow.postMessage(
        {
          type: BROWSER_WALLET_READY_TYPE,
          state,
        },
        targetOrigin,
      );
    },
    [],
  );

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    void loadBrowserWalletState();
  }, [loadBrowserWalletState, walletStateRefreshKey]);

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

  useEffect(() => {
    for (const tab of workspace.tabs) {
      postBrowserWalletReady(tab, browserWalletState);
    }
  }, [browserWalletState, postBrowserWalletReady, workspace.tabs]);

  useEffect(() => {
    const knownTabIds = new Set(workspace.tabs.map((tab) => tab.id));
    for (const tabId of browserWalletChainIdByTabRef.current.keys()) {
      if (!knownTabIds.has(tabId)) {
        browserWalletChainIdByTabRef.current.delete(tabId);
      }
    }
  }, [workspace.tabs]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (!isBrowserWorkspaceWalletRequest(event.data)) {
        return;
      }
      const request = event.data;

      const sourceTab = workspaceTabsRef.current.find(
        (tab) => iframeRefs.current.get(tab.id)?.contentWindow === event.source,
      );
      const sourceWindow = sourceTab
        ? iframeRefs.current.get(sourceTab.id)?.contentWindow
        : null;
      if (!sourceTab || !sourceWindow) {
        return;
      }

      const targetOrigin = resolveBrowserWorkspaceMessageOrigin(
        event.origin,
        sourceTab.url,
      );
      if (targetOrigin === null) {
        // Refuse to respond — origin cannot be verified or doesn't match tab URL.
        return;
      }
      const respond = (response: BrowserWorkspaceWalletResponse) => {
        sourceWindow.postMessage(response, targetOrigin);
      };
      const currentWalletState = browserWalletStateRef.current;
      const currentTabChainId =
        browserWalletChainIdByTabRef.current.get(sourceTab.id) ??
        DEFAULT_BROWSER_WALLET_CHAIN_ID;

      if (request.method === "getState") {
        respond({
          type: BROWSER_WALLET_RESPONSE_TYPE,
          requestId: request.requestId,
          ok: true,
          result: browserWalletStateRef.current,
        });
        return;
      }

      if (request.method === "requestAccounts") {
        respond({
          type: BROWSER_WALLET_RESPONSE_TYPE,
          requestId: request.requestId,
          ok: true,
          result: {
            accounts: resolveBrowserWorkspaceWalletAccounts(currentWalletState),
          },
        });
        return;
      }

      void (async () => {
        if (
          request.method === "eth_accounts" ||
          request.method === "eth_requestAccounts"
        ) {
          respond({
            type: BROWSER_WALLET_RESPONSE_TYPE,
            requestId: request.requestId,
            ok: true,
            result: resolveBrowserWorkspaceWalletAccounts(currentWalletState),
          });
          return;
        }

        if (request.method === "solana_connect") {
          if (
            !currentWalletState.solanaConnected ||
            !currentWalletState.solanaAddress
          ) {
            respond({
              type: BROWSER_WALLET_RESPONSE_TYPE,
              requestId: request.requestId,
              ok: false,
              error: "Solana wallet is unavailable.",
            });
            return;
          }

          respond({
            type: BROWSER_WALLET_RESPONSE_TYPE,
            requestId: request.requestId,
            ok: true,
            result: {
              address: currentWalletState.solanaAddress,
            },
          });
          return;
        }

        if (request.method === "eth_chainId") {
          respond({
            type: BROWSER_WALLET_RESPONSE_TYPE,
            requestId: request.requestId,
            ok: true,
            result: formatBrowserWorkspaceChainId(currentTabChainId),
          });
          return;
        }

        if (request.method === "solana_signMessage") {
          if (!currentWalletState.solanaMessageSigningAvailable) {
            respond({
              type: BROWSER_WALLET_RESPONSE_TYPE,
              requestId: request.requestId,
              ok: false,
              error:
                currentWalletState.reason ||
                "Solana browser wallet signing is unavailable.",
            });
            return;
          }

          const params =
            request.params && typeof request.params === "object"
              ? (request.params as {
                  message?: unknown;
                  messageBase64?: unknown;
                })
              : null;
          const message =
            typeof params?.message === "string" ? params.message : undefined;
          const messageBase64 =
            typeof params?.messageBase64 === "string"
              ? params.messageBase64
              : undefined;

          if (!message && !messageBase64) {
            respond({
              type: BROWSER_WALLET_RESPONSE_TYPE,
              requestId: request.requestId,
              ok: false,
              error:
                "Solana browser wallet signing requires message or messageBase64.",
            });
            return;
          }

          try {
            const result = await client.signBrowserSolanaMessage({
              ...(message ? { message } : {}),
              ...(messageBase64 ? { messageBase64 } : {}),
            });
            respond({
              type: BROWSER_WALLET_RESPONSE_TYPE,
              requestId: request.requestId,
              ok: true,
              result,
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            respond({
              type: BROWSER_WALLET_RESPONSE_TYPE,
              requestId: request.requestId,
              ok: false,
              error: message,
            });
          }
          return;
        }

        if (request.method === "wallet_switchEthereumChain") {
          if (!currentWalletState.chainSwitchingAvailable) {
            respond({
              type: BROWSER_WALLET_RESPONSE_TYPE,
              requestId: request.requestId,
              ok: false,
              error:
                currentWalletState.reason ||
                "Browser wallet chain switching is unavailable.",
            });
            return;
          }

          const nextChainId = parseBrowserWorkspaceChainId(
            Array.isArray(request.params)
              ? (request.params[0] as { chainId?: unknown } | undefined)
                  ?.chainId
              : (request.params as { chainId?: unknown } | undefined)?.chainId,
          );

          if (!nextChainId) {
            respond({
              type: BROWSER_WALLET_RESPONSE_TYPE,
              requestId: request.requestId,
              ok: false,
              error: "wallet_switchEthereumChain requires a valid chainId.",
            });
            return;
          }

          browserWalletChainIdByTabRef.current.set(sourceTab.id, nextChainId);
          // Use the ref (not the stale closure snapshot) so the dApp receives
          // the most up-to-date wallet state after the chain switch.
          postBrowserWalletReady(sourceTab, browserWalletStateRef.current);
          respond({
            type: BROWSER_WALLET_RESPONSE_TYPE,
            requestId: request.requestId,
            ok: true,
            result: null,
          });
          return;
        }

        if (
          request.method === "personal_sign" ||
          request.method === "eth_sign"
        ) {
          if (!currentWalletState.messageSigningAvailable) {
            respond({
              type: BROWSER_WALLET_RESPONSE_TYPE,
              requestId: request.requestId,
              ok: false,
              error:
                currentWalletState.mode === "steward"
                  ? "Browser message signing requires a local wallet key."
                  : currentWalletState.reason ||
                    "Browser wallet message signing is unavailable.",
            });
            return;
          }

          const message = resolveBrowserWorkspaceMessageToSign(
            request.params,
            currentWalletState.address,
          );
          if (!message) {
            respond({
              type: BROWSER_WALLET_RESPONSE_TYPE,
              requestId: request.requestId,
              ok: false,
              error: "Browser wallet signing requires a message payload.",
            });
            return;
          }

          try {
            const result = await client.signBrowserWalletMessage(message);
            respond({
              type: BROWSER_WALLET_RESPONSE_TYPE,
              requestId: request.requestId,
              ok: true,
              result:
                request.method === "eth_sign" ||
                request.method === "personal_sign"
                  ? result.signature
                  : result,
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            respond({
              type: BROWSER_WALLET_RESPONSE_TYPE,
              requestId: request.requestId,
              ok: false,
              error: message,
            });
          }
          return;
        }

        if (
          request.method !== "sendTransaction" &&
          request.method !== "eth_sendTransaction"
        ) {
          respond({
            type: BROWSER_WALLET_RESPONSE_TYPE,
            requestId: request.requestId,
            ok: false,
            error: "Unsupported browser wallet request.",
          });
          return;
        }

        if (!currentWalletState.transactionSigningAvailable) {
          respond({
            type: BROWSER_WALLET_RESPONSE_TYPE,
            requestId: request.requestId,
            ok: false,
            error:
              currentWalletState.reason ||
              "Browser wallet transaction signing is unavailable.",
          });
          return;
        }

        const transaction = normalizeBrowserWorkspaceTxRequest(
          request.params,
          currentTabChainId,
        );
        if (!transaction) {
          respond({
            type: BROWSER_WALLET_RESPONSE_TYPE,
            requestId: request.requestId,
            ok: false,
            error:
              "Browser wallet sendTransaction requires to, value, and chainId.",
          });
          return;
        }

        try {
          const result = await client.sendBrowserWalletTransaction(transaction);
          const nextState = await loadBrowserWalletState();
          postBrowserWalletReady(sourceTab, nextState);
          respond({
            type: BROWSER_WALLET_RESPONSE_TYPE,
            requestId: request.requestId,
            ok: true,
            result:
              request.method === "eth_sendTransaction"
                ? (result.txHash ?? result.txId ?? null)
                : result,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          respond({
            type: BROWSER_WALLET_RESPONSE_TYPE,
            requestId: request.requestId,
            ok: false,
            error: message,
          });
        }
      })();
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [loadBrowserWalletState, postBrowserWalletReady]);

  const browserSidebar = (
    <Sidebar
      testId="browser-workspace-sidebar"
      collapsible
      contentIdentity={`browser-workspace:${workspace.mode}`}
      collapseButtonTestId="browser-workspace-sidebar-collapse-toggle"
      expandButtonTestId="browser-workspace-sidebar-expand-toggle"
      collapseButtonAriaLabel="Collapse browser workspace"
      expandButtonAriaLabel="Expand browser workspace"
      header={
        <SidebarHeader>
          <div className="space-y-1">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted/70">
              {t("browserworkspace.SidebarLabel", {
                defaultValue: "Browser workspace",
              })}
            </div>
            <div className="text-lg font-semibold text-txt">
              {workspace.mode === "desktop"
                ? t("browserworkspace.DesktopBridge", {
                    defaultValue: "Desktop bridge",
                  })
                : t("browserworkspace.WebWorkspace", {
                    defaultValue: "Web iframe workspace",
                  })}
            </div>
          </div>
        </SidebarHeader>
      }
      collapsedRailAction={
        <SidebarCollapsedActionButton
          aria-label={t("browserworkspace.NewTab", {
            defaultValue: "New tab",
          })}
          onClick={() =>
            void runBrowserWorkspaceAction("open:new-rail", async () => {
              await openNewBrowserWorkspaceTab(locationInput || "about:blank");
            })
          }
        >
          <Plus className="h-4 w-4" />
        </SidebarCollapsedActionButton>
      }
      collapsedRailItems={workspace.tabs.map((tab) => {
        const label = getBrowserWorkspaceTabLabel(tab);
        return (
          <SidebarContent.RailItem
            key={tab.id}
            aria-label={label}
            title={label}
            active={tab.id === selectedTabId}
            indicatorTone={tab.visible ? "accent" : undefined}
            onClick={() =>
              void runBrowserWorkspaceAction(
                `show:${tab.id}:rail`,
                async () => {
                  await activateBrowserWorkspaceTab(tab.id);
                },
              )
            }
          >
            {getBrowserWorkspaceRailMonogram(label)}
          </SidebarContent.RailItem>
        );
      })}
      footer={
        <Button
          variant="outline"
          size="sm"
          className="h-10 w-full justify-start rounded-xl px-4 text-xs font-semibold"
          onClick={() =>
            void runBrowserWorkspaceAction("refresh:list", async () => {
              await loadWorkspace({
                preferTabId: selectedTabId,
                silent: true,
              });
            })
          }
          disabled={busyAction !== null}
        >
          <RefreshCw className="h-4 w-4" />
          {t("common.refresh")}
        </Button>
      }
    >
      <SidebarScrollRegion>
        <SidebarPanel>
          {/* URL controls */}
          <div className="space-y-2 mb-4">
            <Input
              value={locationInput}
              onChange={(event) => {
                setLocationInput(event.target.value);
                setLocationDirty(true);
              }}
              placeholder={t("browserworkspace.AddressPlaceholder", {
                defaultValue: "Enter a URL",
              })}
              className="w-full h-10 rounded-full border-border/35 bg-card/70 px-4 text-sm text-txt shadow-sm transition-colors focus-visible:border-accent/40"
            />
            <div className="flex gap-1.5">
              <Button
                variant="default"
                size="sm"
                className="h-9 flex-1 rounded-xl px-3 text-xs font-semibold"
                onClick={() =>
                  void runBrowserWorkspaceAction(
                    "navigate:selected",
                    async () => {
                      await navigateSelectedBrowserWorkspaceTab(locationInput);
                    },
                  )
                }
                disabled={busyAction !== null}
              >
                {selectedTab
                  ? t("browserworkspace.Go", { defaultValue: "Go" })
                  : t("browserworkspace.Open", { defaultValue: "Open" })}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-9 flex-1 rounded-xl px-3 text-xs font-semibold"
                onClick={() =>
                  void runBrowserWorkspaceAction(
                    "open:new-address",
                    async () => {
                      await openNewBrowserWorkspaceTab(
                        locationInput || "about:blank",
                      );
                    },
                  )
                }
                disabled={busyAction !== null}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                {t("browserworkspace.NewTab", { defaultValue: "New tab" })}
              </Button>
            </div>
            <div className="flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-9 flex-1 rounded-xl px-3 text-xs font-semibold"
                onClick={() =>
                  void runBrowserWorkspaceAction("open:external", async () => {
                    if (!selectedTab) return;
                    await openExternalUrl(selectedTab.url);
                  })
                }
                disabled={!selectedTab || busyAction !== null}
              >
                <ExternalLink className="mr-1 h-3.5 w-3.5" />
                {t("browserworkspace.OpenExternal", {
                  defaultValue: "Open external",
                })}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-9 flex-1 rounded-xl px-3 text-xs font-semibold"
                onClick={() =>
                  void runBrowserWorkspaceAction("close:selected", async () => {
                    await closeSelectedBrowserWorkspaceTab();
                  })
                }
                disabled={!selectedTab || busyAction !== null}
              >
                <X className="mr-1 h-3.5 w-3.5" />
                {t("browserworkspace.Close", { defaultValue: "Close" })}
              </Button>
            </div>
          </div>

          <PagePanel.SummaryCard compact className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs-tight uppercase tracking-[0.16em] text-muted/70">
                {t("browserworkspace.OpenTabs", {
                  defaultValue: "Open tabs",
                })}
              </span>
              <MetaPill compact>{workspace.tabs.length}</MetaPill>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs-tight uppercase tracking-[0.16em] text-muted/70">
                {t("browserworkspace.Active", {
                  defaultValue: "Active",
                })}
              </span>
              <MetaPill compact>
                {workspace.tabs.filter((tab) => tab.visible).length}
              </MetaPill>
            </div>
          </PagePanel.SummaryCard>

          {workspace.tabs.length > 0 ? (
            <>
              <SidebarContent.SectionLabel className="mt-4">
                {t("browserworkspace.Tabs", {
                  defaultValue: "Tabs",
                })}
              </SidebarContent.SectionLabel>
              <div className="mt-2 space-y-1">
                {workspace.tabs.map((tab) => {
                  const active = tab.id === selectedTabId;
                  const label = getBrowserWorkspaceTabLabel(tab);
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      className={`flex w-full items-center gap-3 rounded-2xl border px-3 py-2 text-left transition-colors ${
                        active
                          ? "border-accent/30 bg-accent/12 text-txt"
                          : "border-border/30 bg-card/50 text-muted hover:border-border/55 hover:text-txt"
                      }`}
                      onClick={() =>
                        void runBrowserWorkspaceAction(
                          `show:${tab.id}:sidebar`,
                          async () => {
                            await activateBrowserWorkspaceTab(tab.id);
                          },
                        )
                      }
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/30 bg-black/10 text-xs font-semibold">
                        {getBrowserWorkspaceRailMonogram(label)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-current">
                          {label}
                        </div>
                        <div className="truncate text-xs-tight text-muted">
                          {tab.url}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
        </SidebarPanel>
      </SidebarScrollRegion>
    </Sidebar>
  );

  return (
    <PageLayout
      sidebar={browserSidebar}
      contentInnerClassName="mx-auto flex h-full w-full max-w-[110rem] flex-1"
      data-testid="browser-workspace-view"
      footer={<WidgetHost slot="browser" className="py-3" />}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {loadError ? (
          <PagePanel.Notice tone="danger">{loadError}</PagePanel.Notice>
        ) : null}

        {loading && workspace.tabs.length === 0 ? (
          <PagePanel.Loading
            variant="workspace"
            heading={t("browserworkspace.Loading", {
              defaultValue: "Loading browser workspace",
            })}
          />
        ) : workspace.tabs.length === 0 ? (
          <PagePanel.Empty
            variant="panel"
            title={t("browserworkspace.EmptyTitle", {
              defaultValue: "No browser tabs yet",
            })}
            description={t("browserworkspace.EmptyDescription", {
              defaultValue:
                "Open a page here, or let the agent create tabs through the browser workspace plugin.",
            })}
            className="min-h-[28rem]"
          />
        ) : (
          <PagePanel
            variant="workspace"
            className="flex min-h-[34rem] flex-1 overflow-hidden p-0"
          >
            <div className="relative flex-1 overflow-hidden rounded-[calc(var(--radius-xl,1.5rem)-0.25rem)] bg-black/5">
              {workspace.tabs.map((tab) => {
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
                    onLoad={() => {
                      postBrowserWalletReady(
                        tab,
                        browserWalletStateRef.current,
                      );
                    }}
                  />
                );
              })}
            </div>
          </PagePanel>
        )}

        {selectedTab ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <MetaPill compact>
              {getBrowserWorkspaceTabLabel(selectedTab)}
            </MetaPill>
            <span>{selectedTab.url}</span>
            <span>•</span>
            <span>
              {t("browserworkspace.LastSeen", {
                defaultValue: "Last seen {{time}}",
                time: formatBrowserWorkspaceTimestamp(
                  selectedTab.lastFocusedAt ?? selectedTab.updatedAt,
                ),
              })}
            </span>
            <span>•</span>
            <span>
              {selectedTab.visible
                ? t("browserworkspace.Visible", {
                    defaultValue: "Visible",
                  })
                : t("browserworkspace.Background", {
                    defaultValue: "Background",
                  })}
            </span>
          </div>
        ) : null}
      </div>
    </PageLayout>
  );
}
