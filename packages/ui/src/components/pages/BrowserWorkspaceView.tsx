import { Capacitor } from "@capacitor/core";
import type {
  BrowserBridgeCompanionPackageStatus,
  BrowserBridgeCompanionStatus,
} from "@elizaos/plugin-browser";
import {
  Button,
  ConfirmDialog,
  Input,
  SidebarCollapsedActionButton,
  SidebarContent,
  SidebarPanel,
  SidebarScrollRegion,
  useConfirm,
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
import { MOBILE_RUNTIME_MODE_CHANGED_EVENT } from "../../events";
import { readPersistedMobileRuntimeMode } from "../../onboarding/mobile-runtime-mode";
import { useApp } from "../../state";
import { openExternalUrl } from "../../utils";
import {
  BROWSER_TAB_PRELOAD_SCRIPT,
  setBrowserTabsRendererImpl,
} from "../../utils/browser-tabs-renderer-registry";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { CollapsibleSidebarSection } from "../shared/CollapsibleSidebarSection";
import {
  AppWorkspaceChrome,
  type AppWorkspaceChromeProps,
} from "../workspace/AppWorkspaceChrome.js";
import {
  decodeBase64ForPreview,
  decodeSignableMessage,
  formatAddressForDisplay,
  formatWeiForDisplay,
  truncateMessageForDisplay,
} from "./browser-wallet-consent-format";
import {
  type BrowserWorkspaceWalletState,
  buildBrowserWorkspaceWalletState,
  getUnsupportedBrowserWorkspaceEvmChainError,
  isBrowserWorkspaceEvmChainSupported,
  parseBrowserWorkspaceEvmChainId,
  resolveBrowserWorkspaceSignMessage,
} from "./browser-workspace-wallet";
import { getBrowserPageScopeCopy } from "./page-scoped-conversations";
import { useBrowserWorkspaceWalletBridge } from "./useBrowserWorkspaceWalletBridge";

const POLL_INTERVAL_MS = 2_500;
const BROWSER_BRIDGE_POLL_INTERVAL_MS = 4_000;
const BROWSER_WORKSPACE_AGENT_PARTITION = "persist:eliza-browser-agent";
const BROWSER_WORKSPACE_APP_PARTITION = "persist:eliza-browser-app";
// Default URL when the user opens a fresh tab via "+". The docs site
// respects prefers-color-scheme so the OS theme drives light/dark.
const BROWSER_WORKSPACE_DEFAULT_HOME_URL = "https://docs.elizaos.ai/";
const BROWSER_WORKSPACE_COLLAPSED_SECTIONS_STORAGE_KEY =
  "eliza:browser-workspace:collapsed-sections";
// Selectors handed to `<electrobun-webview masks=…>` so the native OOPIF
// surface doesn't paint over (or capture clicks within) React overlays
// stacked on the same rect. Covers Radix Dialog/AlertDialog content
// (`role=dialog`/`alertdialog`), every Radix popper-based surface (Popover,
// Tooltip, Dropdown, Select, HoverCard, ContextMenu — all wrapped in
// `data-radix-popper-content-wrapper`), and the ActionNotice toast which
// uses `role=status`. Polled by OverlaySyncController so overlays mounted
// after the tab still get masked.
const BROWSER_WORKSPACE_TAB_MASK_SELECTORS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  "[data-radix-popper-content-wrapper]",
  '[role="tooltip"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="status"]',
].join(", ");

// Minimal subset of Electrobun's <electrobun-webview> custom element surface
// used by this view. Inlined so this file typechecks identically from any
// package that consumes app-core source — the full type lives in
// node_modules/electrobun/dist/api/browser/webviewtag.ts.
type WebviewTagElement = HTMLElement & {
  loadURL(url: string): void;
  reload(): void;
  executeJavascript(js: string): void;
  on(event: "host-message", handler: (event: CustomEvent) => void): void;
  off(event: "host-message", handler: (event: CustomEvent) => void): void;
  /**
   * Synchronizes the OOPIF's frame with the anchor's `getBoundingClientRect()`.
   * The tag auto-syncs on its own resize, but layout changes outside the
   * element (sidebar collapse, window resize, parent flex reflow) need a
   * manual poke. `force: true` triggers the sync even if dimensions look
   * unchanged.
   */
  syncDimensions(force?: boolean): void;
  /**
   * Hide/show the underlying native OOPIF view. The HTML `hidden` attribute
   * does not propagate to the native layer — only this method does. Without
   * it, inactive tabs' OOPIFs stay painted over the surface and intercept
   * clicks meant for sibling UI.
   */
  toggleHidden(value?: boolean): void;
  /**
   * Toggle pointer-event passthrough on the native OOPIF view. When enabled
   * the surface stops capturing clicks even if it remains visible, so React
   * siblings stacked over the same rect (overlays mid-transition, the
   * inactive-tab opacity-0 layer) can receive events. Used alongside
   * `toggleHidden` on inactive tabs so the native view neither paints nor
   * grabs input during the gap between layout flap and first sync.
   */
  togglePassthrough(value?: boolean): void;
};

function _isWebviewTagElement(
  value: EventTarget | null,
): value is WebviewTagElement {
  if (!(value instanceof HTMLElement)) return false;
  const candidate = value as Partial<WebviewTagElement>;
  return (
    typeof candidate.loadURL === "function" &&
    typeof candidate.reload === "function" &&
    typeof candidate.executeJavascript === "function"
  );
}

// JSX intrinsic for the Electrobun custom element. Augments the React module
// so the modern `react-jsx` transform picks it up without app-core's
// ambient-modules.d.ts being on every consumer's include list.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "electrobun-webview": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          partition?: string;
          preload?: string;
          sandbox?: boolean | "";
          transparent?: boolean | "";
          hidden?: boolean;
          /**
           * "cef" (bundled Chromium) or "native" (system WKWebView on macOS).
           * Set explicitly per-tag rather than relying on the
           * `defaultRenderer` config: CEF is what supports the OOPIF model
           * + RPC + preload script the agent automation kit depends on.
           */
          renderer?: "cef" | "native";
          /**
           * Comma-separated CSS selectors. Any element matching is treated
           * as a punch-out rect — the native OOPIF will not paint over it
           * and will not capture clicks within it. Required so React
           * overlays (modals, dropdowns, toasts) render above the webview
           * surface and remain interactive.
           */
          masks?: string;
          /**
           * Initial passthrough state. When present the OOPIF starts in
           * pointer-events: none mode. Set on inactive tabs so the gap
           * between mount and the first selection effect doesn't leak
           * clicks into the wrong tab.
           */
          passthrough?: boolean | "";
        },
        HTMLElement
      >;
    }
  }
}

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
      value === "browser" ||
      value === "browser-bridge" ||
      value === "plugin-browser" ||
      value === "@elizaos/plugin-browser",
  );
}

function isBrowserWorkspaceSessionMode(
  mode: BrowserWorkspaceSnapshot["mode"],
): boolean {
  // Cloud is the only mode that still uses the snapshot-preview UX. Desktop
  // mode renders <electrobun-webview> tags directly into the React tree, so
  // there's no need to poll for screenshot data.
  return mode === "cloud";
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

function resolveSolanaCluster(
  value: unknown,
): "mainnet" | "devnet" | "testnet" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  if (normalized.includes("devnet")) return "devnet";
  if (normalized.includes("testnet")) return "testnet";
  if (normalized.includes("mainnet")) return "mainnet";
  return undefined;
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
  const [mobileRuntimeMode, setMobileRuntimeMode] = useState(
    readPersistedMobileRuntimeMode,
  );
  const initialBrowseUrlRef = useRef<string | null | undefined>(undefined);
  const initialBrowseHandledRef = useRef(false);
  const iframeRefs = useRef(new Map<string, HTMLIFrameElement | null>());
  const electrobunWebviewRefs = useRef(
    new Map<string, WebviewTagElement | null>(),
  );
  const electrobunHostMessageHandlersRef = useRef(
    new Map<string, (event: CustomEvent) => void>(),
  );
  const pendingTabExecsRef = useRef(
    new Map<
      number,
      {
        resolve: (value: {
          ok: boolean;
          result?: unknown;
          error?: string;
        }) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  const tabExecCounterRef = useRef(0);
  const tabChainIdRef = useRef(new Map<string, number>());
  const browserWalletStateRef = useRef<BrowserWorkspaceWalletState | null>(
    null,
  );
  // Per-session "the user already allowed this domain to read accounts"
  // set. EIP-1193 dApps poll `eth_accounts` after connect; without this
  // the consent modal would re-prompt on every poll. Cleared when the
  // workspace unmounts (i.e. app restart). A persistent vault-backed
  // version is a follow-up — see Phase 2 brief.
  const walletConnectAllowedDomainsRef = useRef<Set<string>>(new Set());
  // Ref-mirror of the selected tab id so the register callback (which is
  // memoized on handleTabHostMessage only) can read the current selection
  // without a fresh closure each render.
  const selectedTabIdRef = useRef<string | null>(null);
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
    : locationInput || BROWSER_WORKSPACE_DEFAULT_HOME_URL;
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
  const browserBridgeUnsupportedInNativeLocalMode =
    Capacitor.isNativePlatform() && mobileRuntimeMode === "local";

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

  useEffect(() => {
    if (typeof document === "undefined") return;
    const syncRuntimeMode = () => {
      setMobileRuntimeMode(readPersistedMobileRuntimeMode());
    };
    document.addEventListener(
      MOBILE_RUNTIME_MODE_CHANGED_EVENT,
      syncRuntimeMode,
    );
    return () => {
      document.removeEventListener(
        MOBILE_RUNTIME_MODE_CHANGED_EVENT,
        syncRuntimeMode,
      );
    };
  }, []);

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
      if (browserBridgeUnsupportedInNativeLocalMode) {
        setBrowserBridgeCompanions([]);
        setBrowserBridgePackageStatus(null);
        setBrowserBridgeAvailable(false);
        setBrowserBridgeLoading(false);
        return;
      }
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
    [browserBridgeUnsupportedInNativeLocalMode],
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
      } else if (workspace.mode === "desktop") {
        const tag = electrobunWebviewRefs.current.get(selectedTabId);
        tag?.loadURL(tab.url);
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

  // Keep a ref so the host-message handler always sees the latest wallet
  // state without needing a fresh closure per render.
  browserWalletStateRef.current = browserWalletState;
  selectedTabIdRef.current = selectedTabId;

  // Wallet-action consent (eth_sendTransaction, personal_sign, eth_sign,
  // first-time eth_requestAccounts). Must be declared before
  // handleTabWalletRequest references it.
  const { confirm: walletActionConfirm, modalProps: walletActionModalProps } =
    useConfirm();

  const handleTabWalletRequest = useCallback(
    async (req: {
      tabId: string;
      requestId: number;
      protocol: "evm" | "solana";
      method: string;
      params: unknown;
      hostname: string;
    }): Promise<void> => {
      const tag = electrobunWebviewRefs.current.get(req.tabId);
      const reply = (payload: { result?: unknown; error?: string }): void => {
        if (!tag) return;
        tag.executeJavascript(
          `window.__elizaWalletReply(${JSON.stringify(req.requestId)}, ${JSON.stringify(payload)})`,
        );
      };
      const walletState = browserWalletStateRef.current;
      if (!walletState) {
        reply({ error: "Wallet state not yet loaded." });
        return;
      }
      const domain = (req.hostname || "this site").trim();
      try {
        const evmAddress = walletState.evmAddress;
        const solanaAddress = walletState.solanaAddress;
        if (req.protocol === "evm") {
          switch (req.method) {
            case "eth_requestAccounts": {
              if (!evmAddress) {
                reply({
                  error: walletState.reason ?? "No EVM wallet connected.",
                });
                return;
              }
              const allowed =
                walletConnectAllowedDomainsRef.current.has(domain) ||
                (await walletActionConfirm({
                  title: `Connect Eliza wallet to ${domain}`,
                  message: `${domain} is requesting your wallet address. Allow it to read ${formatAddressForDisplay(evmAddress)}?`,
                  confirmLabel: "Connect",
                  cancelLabel: "Reject",
                }));
              if (!allowed) {
                reply({ error: "User rejected wallet connection." });
                return;
              }
              walletConnectAllowedDomainsRef.current.add(domain);
              reply({ result: [evmAddress] });
              return;
            }
            case "eth_accounts": {
              if (!evmAddress) {
                reply({ result: [] });
                return;
              }
              // Per EIP-1193, eth_accounts returns the list of accounts
              // the dApp is already authorized to use; an unauthorized
              // dApp must see [], not a prompt. We honour that here so
              // we don't block silent polls behind a consent dialog.
              if (!walletConnectAllowedDomainsRef.current.has(domain)) {
                reply({ result: [] });
                return;
              }
              reply({ result: [evmAddress] });
              return;
            }
            case "eth_chainId": {
              const chainId = tabChainIdRef.current.get(req.tabId) ?? 1;
              reply({ result: `0x${chainId.toString(16)}` });
              return;
            }
            case "wallet_switchEthereumChain": {
              const arr = Array.isArray(req.params) ? req.params : [req.params];
              const next =
                arr[0] && typeof arr[0] === "object"
                  ? (arr[0] as { chainId?: unknown }).chainId
                  : null;
              const chainId = parseBrowserWorkspaceEvmChainId(next);
              if (!chainId) {
                reply({
                  error: "wallet_switchEthereumChain requires a valid chainId.",
                });
                return;
              }
              if (!isBrowserWorkspaceEvmChainSupported(chainId)) {
                reply({
                  error: getUnsupportedBrowserWorkspaceEvmChainError(chainId),
                });
                return;
              }
              tabChainIdRef.current.set(req.tabId, chainId);
              reply({ result: null });
              return;
            }
            case "personal_sign":
            case "eth_sign": {
              if (!walletState.messageSigningAvailable) {
                reply({
                  error:
                    walletState.mode === "steward"
                      ? "Browser message signing requires a local wallet key."
                      : (walletState.reason ??
                        "Browser wallet message signing is unavailable."),
                });
                return;
              }
              const message = resolveBrowserWorkspaceSignMessage(
                req.params,
                evmAddress,
              );
              if (!message) {
                reply({
                  error: "Browser wallet signing requires a message payload.",
                });
                return;
              }
              const allowed = await walletActionConfirm({
                title: `${domain} wants to sign a message`,
                message: `Message preview:\n\n${truncateMessageForDisplay(decodeSignableMessage(message))}\n\nAllow signing?`,
                confirmLabel: "Sign",
                cancelLabel: "Reject",
              });
              if (!allowed) {
                reply({ error: "User rejected message signing." });
                return;
              }
              const result = await client.signBrowserWalletMessage(message);
              reply({ result: result.signature });
              return;
            }
            case "eth_signTypedData":
            case "eth_signTypedData_v3":
            case "eth_signTypedData_v4": {
              reply({
                error:
                  "Typed-data signing is not supported by the Eliza browser wallet.",
              });
              return;
            }
            case "eth_sendTransaction": {
              if (!walletState.transactionSigningAvailable) {
                reply({
                  error:
                    walletState.reason ??
                    "Browser wallet transaction signing is unavailable.",
                });
                return;
              }
              const arr = Array.isArray(req.params) ? req.params : [req.params];
              const tx =
                arr[0] && typeof arr[0] === "object"
                  ? (arr[0] as Record<string, unknown>)
                  : null;
              if (!tx) {
                reply({
                  error: "eth_sendTransaction requires a transaction object.",
                });
                return;
              }
              const txChainId = parseBrowserWorkspaceEvmChainId(tx.chainId);
              const chainId =
                txChainId ?? tabChainIdRef.current.get(req.tabId) ?? 1;
              if (!isBrowserWorkspaceEvmChainSupported(chainId)) {
                reply({
                  error: getUnsupportedBrowserWorkspaceEvmChainError(chainId),
                });
                return;
              }
              tabChainIdRef.current.set(req.tabId, chainId);
              const value =
                typeof tx.value === "string"
                  ? tx.value.startsWith("0x")
                    ? BigInt(tx.value).toString()
                    : tx.value
                  : "0";
              const to = typeof tx.to === "string" ? tx.to : "";
              const allowed = await walletActionConfirm({
                title: `${domain} wants to send a transaction`,
                message: `From: ${formatAddressForDisplay(evmAddress ?? "")}\nTo: ${formatAddressForDisplay(to)}\nValue: ${formatWeiForDisplay(value)}\nChain: ${chainId}\n\nAllow this transaction?`,
                confirmLabel: "Send",
                cancelLabel: "Reject",
              });
              if (!allowed) {
                reply({ error: "User rejected transaction." });
                return;
              }
              const result = await client.sendBrowserWalletTransaction({
                broadcast: true,
                chainId,
                to,
                value,
                data: typeof tx.data === "string" ? tx.data : undefined,
                description:
                  typeof tx.description === "string"
                    ? tx.description
                    : undefined,
              });
              reply({ result: result.txHash ?? result.txId ?? null });
              const next = await loadBrowserWalletState();
              browserWalletStateRef.current = next;
              return;
            }
            default:
              reply({ error: `Unsupported EVM method: ${req.method}` });
              return;
          }
        }
        if (req.protocol === "solana") {
          switch (req.method) {
            case "connect": {
              if (!solanaAddress) {
                reply({
                  error: walletState.reason ?? "No Solana wallet connected.",
                });
                return;
              }
              const allowed =
                walletConnectAllowedDomainsRef.current.has(domain) ||
                (await walletActionConfirm({
                  title: `Connect Eliza Solana wallet to ${domain}`,
                  message: `${domain} is requesting your Solana address. Allow it to read ${formatAddressForDisplay(solanaAddress)}?`,
                  confirmLabel: "Connect",
                  cancelLabel: "Reject",
                }));
              if (!allowed) {
                reply({ error: "User rejected wallet connection." });
                return;
              }
              walletConnectAllowedDomainsRef.current.add(domain);
              reply({ result: { publicKey: solanaAddress } });
              return;
            }
            case "signMessage": {
              if (!walletState.solanaMessageSigningAvailable) {
                reply({
                  error:
                    walletState.reason ??
                    "Solana message signing is unavailable.",
                });
                return;
              }
              const messageBase64 =
                req.params && typeof req.params === "object"
                  ? ((req.params as Record<string, unknown>).messageBase64 as
                      | string
                      | undefined)
                  : undefined;
              const message =
                req.params && typeof req.params === "object"
                  ? ((req.params as Record<string, unknown>).message as
                      | string
                      | undefined)
                  : undefined;
              const previewSource =
                message ??
                (messageBase64
                  ? decodeBase64ForPreview(messageBase64)
                  : "(no message preview available)");
              const allowed = await walletActionConfirm({
                title: `${domain} wants to sign a Solana message`,
                message: `Message preview:\n\n${truncateMessageForDisplay(previewSource)}\n\nAllow signing?`,
                confirmLabel: "Sign",
                cancelLabel: "Reject",
              });
              if (!allowed) {
                reply({ error: "User rejected message signing." });
                return;
              }
              const result = await client.signBrowserSolanaMessage({
                ...(messageBase64 ? { messageBase64 } : {}),
                ...(message ? { message } : {}),
              });
              reply({ result });
              return;
            }
            case "signTransaction":
            case "signAndSendTransaction": {
              if (!walletState.solanaTransactionSigningAvailable) {
                reply({
                  error:
                    walletState.reason ??
                    "Solana transaction signing is unavailable.",
                });
                return;
              }
              const transactionBase64 =
                req.params && typeof req.params === "object"
                  ? ((req.params as Record<string, unknown>)
                      .transactionBase64 as string | undefined)
                  : undefined;
              if (!transactionBase64) {
                reply({
                  error:
                    "Solana transaction signing requires transactionBase64.",
                });
                return;
              }
              const willBroadcast = req.method === "signAndSendTransaction";
              const chain =
                req.params && typeof req.params === "object"
                  ? (req.params as Record<string, unknown>).chain
                  : undefined;
              const cluster =
                resolveSolanaCluster(
                  req.params && typeof req.params === "object"
                    ? (req.params as Record<string, unknown>).cluster
                    : undefined,
                ) ?? resolveSolanaCluster(chain);
              const description =
                req.params && typeof req.params === "object"
                  ? (req.params as Record<string, unknown>).description
                  : undefined;
              const effectiveDescription =
                typeof description === "string" && description.trim()
                  ? description.trim()
                  : typeof chain === "string" && chain.trim()
                    ? `Solana transaction on ${chain.trim()}`
                    : cluster
                      ? `Solana transaction on ${cluster}`
                      : undefined;
              const solanaDetails = [
                cluster ? `Cluster: ${cluster}` : null,
                typeof chain === "string" && chain.trim()
                  ? `Chain: ${chain.trim()}`
                  : null,
              ].filter(Boolean);
              const allowed = await walletActionConfirm({
                title: `${domain} wants to ${willBroadcast ? "send" : "sign"} a Solana transaction`,
                message: `From: ${formatAddressForDisplay(solanaAddress ?? "")}${solanaDetails.length ? `\n${solanaDetails.join("\n")}` : ""}\n${willBroadcast ? "Will broadcast on submit." : "Returns the signed bytes to the dApp; the dApp may broadcast."}\n\nAllow?`,
                confirmLabel: willBroadcast ? "Send" : "Sign",
                cancelLabel: "Reject",
              });
              if (!allowed) {
                reply({ error: "User rejected transaction." });
                return;
              }
              const result = await client.sendBrowserSolanaTransaction({
                transactionBase64,
                broadcast: willBroadcast,
                ...(cluster ? { cluster } : {}),
                ...(effectiveDescription
                  ? { description: effectiveDescription }
                  : {}),
              });
              reply({ result });
              return;
            }
            default:
              reply({ error: `Unsupported Solana method: ${req.method}` });
              return;
          }
        }
        reply({ error: `Unsupported wallet protocol: ${req.protocol}` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply({ error: message });
      }
    },
    [loadBrowserWalletState, walletActionConfirm],
  );

  // ── Vault autofill ────────────────────────────────────────────────
  // The in-tab preload sends `__elizaVaultAutofillRequest` whenever it
  // detects a login form. We resolve credentials from the vault via the
  // app API, prompt the user once per domain (unless they have flagged
  // the domain as auto-allow), then reply with the field values to fill.
  // No silent autofill: every reply that carries fields requires explicit
  // user consent, either at request time or via a previously stored
  // `creds.<domain>.:autoallow` entry.
  const { confirm: vaultAutofillConfirm, modalProps: vaultAutofillModalProps } =
    useConfirm();
  const browserWorkspaceConfirmOpen =
    walletActionModalProps.open || vaultAutofillModalProps.open;

  const handleTabVaultAutofillRequest = useCallback(
    async (req: {
      tabId: string;
      requestId: number;
      domain: string;
      url: string;
      fieldHints: ReadonlyArray<{
        kind: "username" | "password";
        selector: string;
      }>;
    }): Promise<void> => {
      const tag = electrobunWebviewRefs.current.get(req.tabId);
      const reply = (payload: {
        fields?: Record<string, string>;
        error?: string;
      }): void => {
        if (!tag) return;
        tag.executeJavascript(
          `window.__elizaVaultReply(${JSON.stringify(req.requestId)}, ${JSON.stringify(payload)})`,
        );
      };

      const userHint = req.fieldHints.find((h) => h.kind === "username");
      const passwordHint = req.fieldHints.find((h) => h.kind === "password");
      if (!passwordHint) {
        // No password slot — nothing to autofill.
        reply({ fields: {} });
        return;
      }

      try {
        // Aggregate from every signed-in backend. The manager filters by
        // domain (case-insensitive); external adapters list everything
        // and filter client-side because their CLIs don't accept a
        // domain filter.
        const { logins } = await client.listSavedLogins(req.domain);
        // The manager already filters by domain, but we double-check
        // here against the registrable hostname. External entries with
        // a missing or non-matching domain are dropped — they aren't
        // valid candidates for this form.
        const requestDomain = req.domain.toLowerCase();
        const candidates = logins.filter(
          (l) =>
            typeof l.domain === "string" &&
            l.domain.toLowerCase() === requestDomain,
        );
        if (candidates.length === 0) {
          reply({ fields: {} });
          return;
        }

        // Pick the most-recently-modified entry. Multi-account selection
        // is a future UI improvement — at first save time only one entry
        // typically exists per domain.
        const sorted = [...candidates].sort(
          (a, b) => b.updatedAt - a.updatedAt,
        );
        const chosen = sorted[0];
        if (!chosen) {
          reply({ fields: {} });
          return;
        }

        const sourceLabel =
          chosen.source === "1password"
            ? "1Password"
            : chosen.source === "bitwarden"
              ? "Bitwarden"
              : "local vault";

        const allowed = await client.getAutofillAllowed(req.domain);
        const consented =
          allowed ||
          (await vaultAutofillConfirm({
            title: `Autofill ${req.domain}`,
            message: `Sign in as ${chosen.username || chosen.title} from ${sourceLabel}?\n\nEliza will fill the saved username and password for this site.`,
            confirmLabel: "Allow",
            cancelLabel: "Deny",
          }));
        if (!consented) {
          reply({ fields: {} });
          return;
        }

        const reveal = await client.revealSavedLogin(
          chosen.source,
          chosen.identifier,
        );

        const fields: Record<string, string> = {};
        if (userHint) fields[userHint.selector] = reveal.username;
        fields[passwordHint.selector] = reveal.password;
        reply({ fields });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply({ error: message });
      }
    },
    [vaultAutofillConfirm],
  );

  const handleTabHostMessage = useCallback(
    (tabId: string, event: CustomEvent) => {
      const detail = event.detail as
        | {
            type?: string;
            requestId?: number;
            ok?: boolean;
            result?: unknown;
            error?: string;
            protocol?: "evm" | "solana";
            method?: string;
            params?: unknown;
            origin?: string;
            hostname?: string;
            domain?: string;
            url?: string;
            fieldHints?: Array<{
              kind?: string;
              selector?: string;
            }>;
          }
        | null
        | undefined;
      if (!detail || typeof detail.type !== "string") return;

      if (
        detail.type === "__elizaTabExecResult" &&
        typeof detail.requestId === "number"
      ) {
        const pending = pendingTabExecsRef.current.get(detail.requestId);
        if (!pending) return;
        pendingTabExecsRef.current.delete(detail.requestId);
        clearTimeout(pending.timer);
        pending.resolve({
          ok: detail.ok === true,
          result: detail.result,
          error: detail.error,
        });
        return;
      }

      if (
        detail.type === "__elizaWalletRequest" &&
        typeof detail.requestId === "number" &&
        typeof detail.protocol === "string" &&
        typeof detail.method === "string"
      ) {
        void handleTabWalletRequest({
          tabId,
          requestId: detail.requestId,
          protocol: detail.protocol,
          method: detail.method,
          params: detail.params,
          hostname: typeof detail.hostname === "string" ? detail.hostname : "",
        });
        return;
      }

      if (
        detail.type === "__elizaVaultAutofillRequest" &&
        typeof detail.requestId === "number" &&
        typeof detail.domain === "string" &&
        typeof detail.url === "string" &&
        Array.isArray(detail.fieldHints)
      ) {
        const fieldHints: Array<{
          kind: "username" | "password";
          selector: string;
        }> = [];
        for (const hint of detail.fieldHints) {
          if (
            hint &&
            (hint.kind === "username" || hint.kind === "password") &&
            typeof hint.selector === "string" &&
            hint.selector.length > 0
          ) {
            fieldHints.push({ kind: hint.kind, selector: hint.selector });
          }
        }
        void handleTabVaultAutofillRequest({
          tabId,
          requestId: detail.requestId,
          domain: detail.domain,
          url: detail.url,
          fieldHints,
        });
      }
    },
    [handleTabWalletRequest, handleTabVaultAutofillRequest],
  );

  const registerBrowserWorkspaceElectrobunWebview = useCallback(
    (tabId: string, element: WebviewTagElement | null) => {
      const previous = electrobunWebviewRefs.current.get(tabId);
      const previousHandler =
        electrobunHostMessageHandlersRef.current.get(tabId);
      if (previous && previous !== element) {
        if (previousHandler) {
          previous.off("host-message", previousHandler);
        }
        electrobunHostMessageHandlersRef.current.delete(tabId);
      }
      if (!element) {
        if (previous && previousHandler) {
          previous.off("host-message", previousHandler);
        }
        electrobunHostMessageHandlersRef.current.delete(tabId);
        electrobunWebviewRefs.current.delete(tabId);
        return;
      }
      if (previous !== element) {
        const hostMessageHandler = (event: CustomEvent) =>
          handleTabHostMessage(tabId, event);
        electrobunHostMessageHandlersRef.current.set(tabId, hostMessageHandler);
        element.on("host-message", hostMessageHandler);
        // Poke the OOPIF to read fresh dimensions multiple times — the
        // tag auto-syncs only on its own ResizeObserver firing, and that
        // can miss the initial layout settle if the parent flex chain is
        // still computing on first mount.
        const sync = () => {
          try {
            element.syncDimensions(true);
          } catch {
            // Element may have unmounted.
          }
        };
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => requestAnimationFrame(sync));
        } else {
          setTimeout(sync, 0);
        }
        // Safety net for late-settling layouts (image-driven shifts, web
        // fonts loading, etc.). The poll loop in the upstream tag runs
        // every 100ms anyway — these poke a forceSync on top.
        setTimeout(sync, 250);
        setTimeout(sync, 1000);
        // Hide the native OOPIF immediately if the tag isn't the active
        // one — otherwise its native view sits over the surface and
        // intercepts clicks while React still has it in the tree.
        // Passthrough goes along for the ride so any clicks landing on the
        // rect mid-transition fall through to React siblings beneath.
        if (selectedTabIdRef.current && selectedTabIdRef.current !== tabId) {
          try {
            element.toggleHidden(true);
            element.togglePassthrough(true);
          } catch {
            // best-effort
          }
        }
      }
      electrobunWebviewRefs.current.set(tabId, element);
    },
    [handleTabHostMessage],
  );

  // Track the surface container so layout changes (sidebar collapse,
  // window resize, route entry) re-poke every mounted tag. Without this
  // the OOPIF can latch at whatever rect it had on first mount because
  // Electrobun's OverlaySyncController only fires onSync when the rect
  // *changes* — a small-but-stable rect persists.
  const browserSurfaceRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const surface = browserSurfaceRef.current;
    if (!surface || typeof ResizeObserver === "undefined") return;
    const pokeAll = (): void => {
      for (const element of electrobunWebviewRefs.current.values()) {
        try {
          element?.syncDimensions(true);
        } catch {
          // Tag may have been unmounted between observation and dispatch.
        }
      }
    };
    const observer = new ResizeObserver(() => pokeAll());
    observer.observe(surface);
    window.addEventListener("resize", pokeAll);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", pokeAll);
    };
  }, []);

  // Drive native hide/show on every tag whenever selection or an in-app
  // consent dialog changes. The native webview is an OOPIF overlay, so
  // React dialogs are otherwise rendered under it and cannot be acted on.
  // HTML `hidden` attribute does NOT propagate to the OOPIF — only the
  // tag's `toggleHidden(bool)` method does. Without this, inactive tabs'
  // OOPIFs stay painted over the surface as native views and intercept
  // clicks intended for sibling UI (e.g. the top app nav). Passthrough is
  // toggled in lockstep so a tab caught mid-transition (visible but not
  // selected) still lets clicks fall through to the React layer beneath.
  useEffect(() => {
    if (workspace.mode !== "desktop") return;
    for (const [tabId, element] of electrobunWebviewRefs.current.entries()) {
      if (!element) continue;
      // Hide + engage passthrough whenever the tab is inactive OR an
      // in-app consent dialog is open over the surface, so the dialog (a
      // React sibling) renders above the native OOPIF and stays clickable.
      const occluded = browserWorkspaceConfirmOpen || tabId !== selectedTabId;
      try {
        element.toggleHidden(occluded);
        element.togglePassthrough(occluded);
        element.syncDimensions(true);
      } catch {
        // best-effort
      }
    }
  }, [browserWorkspaceConfirmOpen, selectedTabId, workspace.mode]);

  // On unmount, hide every OOPIF and engage passthrough so leftover native
  // views don't bleed onto other routes between React's unmount and the
  // tag's disconnectedCallback firing.
  useEffect(() => {
    const refs = electrobunWebviewRefs;
    const handlers = electrobunHostMessageHandlersRef;
    return () => {
      for (const [tabId, element] of refs.current.entries()) {
        try {
          const handler = handlers.current.get(tabId);
          if (element && handler) {
            element.off("host-message", handler);
          }
          element?.toggleHidden(true);
          element?.togglePassthrough(true);
        } catch {
          // best-effort
        }
      }
      handlers.current.clear();
    };
  }, []);

  useEffect(() => {
    const tagsRef = electrobunWebviewRefs;
    const pendingsRef = pendingTabExecsRef;
    const counterRef = tabExecCounterRef;
    setBrowserTabsRendererImpl({
      evaluate: (id, script, timeoutMs) =>
        new Promise((resolve) => {
          const tag = tagsRef.current.get(id);
          if (!tag) {
            resolve({
              ok: false,
              error: `browser workspace tab ${id} is not mounted in the renderer`,
            });
            return;
          }
          counterRef.current += 1;
          const requestId = counterRef.current;
          const timer = setTimeout(() => {
            if (pendingsRef.current.delete(requestId)) {
              resolve({
                ok: false,
                error: `browser workspace tab eval timed out after ${timeoutMs}ms`,
              });
            }
          }, timeoutMs);
          pendingsRef.current.set(requestId, { resolve, timer });
          tag.executeJavascript(
            `window.__elizaTabExec(${JSON.stringify(requestId)}, ${JSON.stringify(script)})`,
          );
        }),
      getTabRect: async (id) => {
        const tag = tagsRef.current.get(id);
        if (!tag) return null;
        const rect = tag.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
      },
    });
    return () => {
      setBrowserTabsRendererImpl(null);
      for (const pending of pendingsRef.current.values()) {
        clearTimeout(pending.timer);
        pending.resolve({
          ok: false,
          error: "BrowserWorkspaceView unmounted",
        });
      }
      pendingsRef.current.clear();
    };
  }, []);

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

  const reloadSelectedBrowserWorkspaceTab = useCallback(async () => {
    if (!selectedTab) return;
    if (workspace.mode === "web") {
      const iframe = iframeRefs.current.get(selectedTab.id);
      if (iframe) {
        iframe.src = selectedTab.url;
      }
      return;
    }
    if (workspace.mode === "desktop") {
      const tag = electrobunWebviewRefs.current.get(selectedTab.id);
      tag?.reload();
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
    !browserBridgeSupported ||
    browserBridgeUnsupportedInNativeLocalMode ||
    browserBridgeConnected ? null : (
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
            aria-label={`${closeTabLabel} ${label}`}
            title={`${closeTabLabel}: ${label}`}
            className={`absolute right-0 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-[var(--radius-sm)] text-muted transition-opacity hover:bg-bg-muted/50 hover:text-danger focus-visible:opacity-100 ${
              active
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            }`}
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
        data-testid="browser-workspace-address-input"
        disabled={busyAction !== null || selectedTabIsInternal}
        className="h-8 min-w-0 flex-1 rounded-full border-border/40 bg-card/70 px-4 text-sm text-txt"
      />
      <Button
        variant="outline"
        size="sm"
        className="h-8 shrink-0 px-3"
        aria-label={goLabel}
        disabled={
          busyAction !== null ||
          selectedTabIsInternal ||
          locationInput.trim().length === 0
        }
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

  const watchBannerLabel = busyAction
    ? t("browserworkspace.Working", {
        defaultValue: "Working: {{action}}",
        action: busyAction.replace(/[:\-_]+/g, " "),
      })
    : null;

  const browserSurface = (
    <div
      ref={browserSurfaceRef}
      className="relative flex-1 min-h-0 overflow-hidden bg-bg"
    >
      {watchBannerLabel ? (
        <div
          className="absolute left-3 right-3 top-2 z-20 flex items-center gap-2 rounded-md border border-border/40 bg-card/80 px-3 py-1.5 text-xs text-muted shadow-sm backdrop-blur-sm"
          role="status"
          aria-live="polite"
          data-testid="browser-workspace-watch-banner"
        >
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent shadow-[0_0_4px_var(--accent)]"
          />
          <span className="truncate">{watchBannerLabel}</span>
        </div>
      ) : null}
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
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <div className="text-sm font-semibold text-txt">
              {loading
                ? t("browserworkspace.Loading", {
                    defaultValue: "Loading browser workspace",
                  })
                : t("browserworkspace.EmptyTitle", {
                    defaultValue: "No browser tabs yet",
                  })}
            </div>
            <div className="text-xs leading-5 text-muted">
              {isBrowserWorkspaceSessionMode(workspace.mode)
                ? t("browserworkspace.EmptySessionDescription", {
                    defaultValue:
                      "Open a page to start a real browser session. The preview here follows the session instead of embedding the target site directly.",
                  })
                : t("browserworkspace.EmptyDescription", {
                    defaultValue:
                      "Open a tab and watch the agent drive the page. Wallet and signing route through your local Steward — no extension required.",
                  })}
            </div>
            {!loading ? (
              <Button
                size="sm"
                className="mt-1"
                disabled={busyAction !== null}
                onClick={() =>
                  void runBrowserWorkspaceAction("open:home", async () => {
                    await openNewBrowserWorkspaceTab(
                      BROWSER_WORKSPACE_DEFAULT_HOME_URL,
                      "user",
                    );
                  })
                }
                data-testid="browser-workspace-open-home"
              >
                {t("browserworkspace.OpenNewTab", {
                  defaultValue: "Open new tab",
                })}
              </Button>
            ) : null}
            {!loading &&
            workspace.mode === "web" &&
            browserBridgeSupported &&
            !browserBridgeUnsupportedInNativeLocalMode ? (
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
      ) : workspace.mode === "desktop" ? (
        workspace.tabs.map((tab) => {
          const active = tab.id === selectedTabId;
          const visibilityClass = active
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0";
          return (
            <electrobun-webview
              key={tab.id}
              ref={(el) =>
                registerBrowserWorkspaceElectrobunWebview(
                  tab.id,
                  (el as WebviewTagElement | null) ?? null,
                )
              }
              src={tab.url}
              partition={tab.partition}
              preload={BROWSER_TAB_PRELOAD_SCRIPT}
              renderer="cef"
              masks={BROWSER_WORKSPACE_TAB_MASK_SELECTORS}
              // Start inactive tabs in passthrough so the OOPIF doesn't
              // capture clicks during the gap between mount and the first
              // selection effect. Native hide/show (toggleHidden) is then
              // driven from the selection useEffect.
              passthrough={active ? undefined : ""}
              className={`absolute inset-0 ${visibilityClass}`}
              style={{ display: "block" }}
            />
          );
        })
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
                        "Discord blocks embedded browser frames. Use Eliza Desktop Browser or a connected browser profile so LifeOps can inspect the page after login.",
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
              {t("browserworkspace.CloudSession", {
                defaultValue: "Cloud browser session",
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
    <>
      <AppWorkspaceChrome
        testId="browser-workspace-view"
        main={mainNode}
        chatScope="page-browser"
        pageScopedChatPaneProps={browserPageScopedChatPaneProps}
      />
      <ConfirmDialog {...vaultAutofillModalProps} />
      <ConfirmDialog {...walletActionModalProps} />
    </>
  );
}
