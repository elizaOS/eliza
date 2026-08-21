/**
 * The Browser workspace view (`/browser`): a tabbed embedded-browser surface
 * whose tabs fold into a switcher sheet, with companion-bridge status and the
 * policy-controlled agent browser session panel (takeover, domain modes,
 * receipts) when the bridge plugin is available.
 *
 * The builtin registry declares this view `header: "fullscreen"`, so the shell
 * mounts it edge-to-edge and the view owns its chrome: a floating glass
 * toolbar and a rounded web-surface panel over the opaque app background —
 * the same fullscreen framing the Notes and Calendar views use.
 *
 * Tabs, navigation, and snapshots flow through the `client` browser API; on
 * native the tabs render via a registered renderer impl
 * (`browser-tabs-renderer-registry`), while desktop/web fall back to the
 * companion bridge. Mounted in `App.tsx` under the `browser` route key.
 */
import { Capacitor } from "@capacitor/core";
import {
  ExternalLink,
  FolderOpen,
  Globe,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import {
  type BrowserBridgeCompanionPackageStatus,
  type BrowserBridgeCompanionStatus,
  type BrowserWorkspaceSnapshot,
  type BrowserWorkspaceTab,
  client,
} from "../../api";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import { resolveBuiltinSurfaceManifest } from "../../builtin-tab-registry";
import { MOBILE_RUNTIME_MODE_CHANGED_EVENT } from "../../events";
import { readPersistedMobileRuntimeMode } from "../../first-run/mobile-runtime-mode";
import { useIntervalWhenDocumentVisible } from "../../hooks/useDocumentVisibility";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { useAppSelectorShallow } from "../../state";
import { deriveSurfacePlacement } from "../../surface/native-surface-shell";
import { useMobileNativeTabSurfaces } from "../../surface/use-mobile-native-tab-surfaces";
import { resolveBrowserTabRenderPath } from "../../surface-embedding";
import { openExternalUrl } from "../../utils";
import {
  BROWSER_TAB_PRELOAD_SCRIPT,
  setBrowserTabsRendererImpl,
} from "../../utils/browser-tabs-renderer-registry";
import { BrowserSessionPolicyPanel } from "../browser/BrowserSessionPolicyPanel";
import { PagePanel } from "../composites/page-panel";
import { ViewBackButton } from "../shared/ViewHeader";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { useConfirm } from "../ui/confirm-dialog.hooks";
import { Input } from "../ui/input";
import { TooltipHint } from "../ui/tooltip";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import {
  type BrowserSwitcherTab,
  BrowserTabFoldControl,
  BrowserTabSwitcher,
  foldBrowserTabs,
} from "./BrowserTabSwitcher";
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
import { useBrowserWorkspaceWalletBridge } from "./useBrowserWorkspaceWalletBridge";

const POLL_INTERVAL_MS = 2_500;
const BROWSER_BRIDGE_POLL_INTERVAL_MS = 4_000;
const BROWSER_WORKSPACE_AGENT_PARTITION = "persist:eliza-browser-agent";
const BROWSER_WORKSPACE_APP_PARTITION = "persist:eliza-browser-app";
// Concrete partition for a client-side "user" tab on the native mobile shell,
// where `resolveBrowserWorkspaceTabPartition("user")` is `undefined` (the
// server-default sentinel). Cosmetic on mobile — the native surface's storage
// isolation is governed by its explicit NativeSurfacePolicy, not this string.
const BROWSER_WORKSPACE_DEFAULT_PARTITION = "persist:eliza-browser";
// Default URL when the user opens a fresh tab via "+". Plain web hosts must use
// a page that explicitly permits iframe embedding; native shells render the
// same URL in their isolated WebView instead.
const BROWSER_WORKSPACE_DEFAULT_HOME_URL = "https://www.google.com/webhp?igu=1";
// Cross-origin pages can apply autofocus after their `load` event. Keep one
// bounded handoff alive long enough to catch that deferred focus without
// turning later, deliberate page interaction into a permanent focus trap.
const BROWSER_IFRAME_FOCUS_SETTLE_MS = 1_500;
const BROWSER_IFRAME_FOCUS_ARM_TIMEOUT_MS = 30_000;
const BROWSER_IFRAME_FOCUS_POLL_MS = 16;

type BrowserIframeFocusHandoff = {
  returnTarget: HTMLElement | null;
  navigationUrl: string | null;
  loaded: boolean;
  deadline: number;
  timer: number | null;
  pendingTargetRestore: boolean;
};

function isAvailableBrowserFocusTarget(
  target: HTMLElement | null,
): target is HTMLElement {
  if (!target?.isConnected) return false;
  if (target.getAttribute("aria-disabled") === "true") return false;
  return !("disabled" in target && target.disabled === true);
}
// The Browser view's isolation level, read from its builtin surface manifest
// rather than hardcoded, so the declared `native-webview` level is what
// actually drives which embedding each tab renders into (#14181/#13452). This
// is the enforcement seam: the native child web-content surface (outside the
// host renderer) is selected via `resolveBrowserTabRenderPath` only because
// this resolves to `native-webview`. If the registry ever dropped the browser
// manifest, `resolveBuiltinSurfaceManifest` throws at import — a loud failure,
// not a silent fall-back to the host-realm DOM.
const BROWSER_SURFACE_MANIFEST = resolveBuiltinSurfaceManifest("browser");
const BROWSER_SURFACE_ISOLATION = BROWSER_SURFACE_MANIFEST.isolation;
// The placement the mobile native tab surfaces are created with, derived from
// the same manifest — process is always isolated; storage is isolated because
// the Browser grants no `storage` capability. Throwing here (not defaulting)
// keeps the loud-failure contract: if the manifest ever stopped declaring
// `native-webview`, the native mobile path could not silently create a
// mis-policied surface.
const BROWSER_NATIVE_SURFACE_PLACEMENT = deriveSurfacePlacement(
  BROWSER_SURFACE_MANIFEST,
);
const BROWSER_NATIVE_SURFACE_POLICY =
  BROWSER_NATIVE_SURFACE_PLACEMENT.target === "native-surface"
    ? BROWSER_NATIVE_SURFACE_PLACEMENT.policy
    : (() => {
        throw new Error(
          "Browser surface manifest must declare native-webview isolation to host native mobile tab surfaces",
        );
      })();
// Selectors handed to every native Browser surface so the page doesn't paint
// over (or capture clicks within) React chrome stacked on the same rect. The
// chat selectors keep its pull sheet composited continuously over a full-size
// page; the remainder covers Radix Dialog/AlertDialog content
// (`role=dialog`/`alertdialog`), every Radix popper-based surface (Popover,
// Tooltip, Dropdown, Select, HoverCard, ContextMenu — all wrapped in
// `data-radix-popper-content-wrapper`), and the ActionNotice toast which
// uses `role=status`. Polled by OverlaySyncController so overlays mounted
// after the tab still get masked.
const BROWSER_WORKSPACE_TAB_MASK_SELECTORS = [
  '[data-testid="chat-sheet-surface"]',
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

type ElectrobunWebviewProps = React.DetailedHTMLProps<
  React.HTMLAttributes<WebviewTagElement> & {
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
  WebviewTagElement
>;

// JSX intrinsic for the Electrobun custom element. Kept local so packages that
// consume ui source do not need app-core's ambient module declarations.
declare module "react/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      "electrobun-webview": ElectrobunWebviewProps;
    }
  }
}

type TranslateFn = (key: string, vars?: Record<string, unknown>) => string;
type BrowserWorkspaceTabSectionKey = "agent" | "app" | "user";

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

/**
 * Build a client-side tab for the native mobile shell. Unlike desktop/web, the
 * mobile agent server does not manage Browser tabs (its tab API returns 503), so
 * on the native-mobile-webview path the tab record lives entirely in React state
 * and the isolated native surface is what actually loads the page.
 */
function buildLocalBrowserWorkspaceTab(
  url: string,
  title: string,
  partition: string,
): BrowserWorkspaceTab {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title,
    url,
    partition,
    kind: "standard",
    visible: true,
    createdAt: now,
    updatedAt: now,
    lastFocusedAt: now,
  };
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
    // error-policy:J3 unparseable URL cannot match the frame-blocked hosts;
    // the iframe itself surfaces an unloadable address.
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

function BrowserNavButton({
  agentId,
  agentLabel,
  agentDescription,
  group,
  status,
  onActivate,
  ...buttonProps
}: {
  agentId: string;
  agentLabel: string;
  agentDescription?: string;
  group?: string;
  status?: "active" | "inactive";
  onActivate: () => void;
} & React.ComponentProps<typeof Button>): React.JSX.Element {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label: agentLabel,
    group,
    ...(agentDescription ? { description: agentDescription } : {}),
    ...(status ? { status } : {}),
    onActivate,
  });
  return <Button ref={ref} {...agentProps} {...buttonProps} />;
}

function BrowserAddressInput({
  agentLabel,
  agentDescription,
  getValue,
  onFill,
  ...inputProps
}: {
  agentLabel: string;
  agentDescription?: string;
  getValue: () => string;
  onFill: (value: string) => void;
} & React.ComponentProps<typeof Input>): React.JSX.Element {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: "address-input",
    role: "text-input",
    label: agentLabel,
    ...(agentDescription ? { description: agentDescription } : {}),
    getValue,
    onFill,
  });
  return (
    <Input ref={ref} aria-label={agentLabel} {...agentProps} {...inputProps} />
  );
}

export function BrowserWorkspaceView(): React.JSX.Element {
  useRenderGuard("BrowserWorkspaceView");
  const {
    getStewardPending,
    getStewardStatus,
    setActionNotice,
    t,
    plugins,
    uiTheme,
    walletAddresses,
    walletConfig,
  } = useAppSelectorShallow((s) => ({
    getStewardPending: s.getStewardPending,
    getStewardStatus: s.getStewardStatus,
    setActionNotice: s.setActionNotice,
    t: s.t,
    plugins: s.plugins,
    uiTheme: s.uiTheme,
    walletAddresses: s.walletAddresses,
    walletConfig: s.walletConfig,
  }));
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
  // The folded-tab switcher overlay (#13596). The browser folds every tab into
  // this one switcher instead of a permanent sidebar strip, so this is the only
  // multi-tab surface — opened from the toolbar's fold control.
  const [switcherOpen, setSwitcherOpen] = useState(false);
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
  const workspaceRootRef = useRef<HTMLElement | null>(null);
  const workspaceSnapshotRef = useRef<BrowserWorkspaceSnapshot>(workspace);
  // Polls are slower than their cadence when the API is unhealthy. Keep them
  // single-flight, and order every response so a late poll cannot roll back a
  // newer user action or turn stale-state refresh noise into a page failure.
  const workspaceLoadVersionRef = useRef(0);
  const foregroundWorkspaceLoadsRef = useRef(0);
  const visibleWorkspaceLoadsRef = useRef(0);
  const workspaceActionsInFlightRef = useRef(0);
  const backgroundWorkspaceRefreshInFlightRef = useRef(false);
  const initialWorkspaceLoadStartedRef = useRef(false);
  const iframeRefs = useRef(new Map<string, HTMLIFrameElement | null>());
  const registeredIframeElementsRef = useRef(new WeakSet<HTMLIFrameElement>());
  const iframeFocusHandoffsRef = useRef(
    new Map<HTMLIFrameElement, BrowserIframeFocusHandoff>(),
  );
  const iframeFocusTimersRef = useRef(new Set<number>());
  const browserActionFocusReturnTargetRef = useRef<HTMLElement | null>(null);
  const pendingIframeFocusReturnTargetsRef = useRef(
    new Map<string, HTMLElement | null>(),
  );
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

  // A Capacitor native shell (iOS/Android), distinct from the mobile web browser
  // which also reports `mode: "web"` — so the resolver cannot infer it from mode
  // and we pass it explicitly. Electrobun is desktop, not a mobile shell.
  const nativeMobileShell = useMemo(
    () => Capacitor.isNativePlatform() && !isElectrobunRuntime(),
    [],
  );

  // Which embedding each browser tab renders into, DRIVEN by the view's declared
  // isolation level (not the raw mode string): `native-webview` resolves to the
  // desktop native child surface (the `<electrobun-webview renderer="cef">`
  // OOPIF below) or, on a native mobile shell, a layered `WKWebView` /
  // `WebView`; plain web resolves to a sandboxed iframe; cloud to a server
  // snapshot. Reading the manifest here is what makes `isolation:
  // "native-webview"` authoritative (#14181/#15245) — a view without that level
  // could never reach a native surface.
  const browserTabRenderPath = resolveBrowserTabRenderPath({
    isolation: BROWSER_SURFACE_ISOLATION,
    mode: workspace.mode,
    nativeMobileShell,
  });

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
  // A user-created tab is a fresh browsing context. Reusing the address-field
  // draft would clone the current page, while internal-tab state must never
  // leak into a user tab. The address bar remains the explicit path for opening
  // a chosen URL.
  const newBrowserWorkspaceTabSeedUrl = BROWSER_WORKSPACE_DEFAULT_HOME_URL;
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

  const browserBridgeSupported = useMemo(
    () => plugins.some((plugin) => isBrowserBridgePlugin(plugin)),
    [plugins],
  );
  const browserBridgeUnsupportedInNativeLocalMode =
    Capacitor.isNativePlatform() && mobileRuntimeMode === "local";

  workspaceSnapshotRef.current = workspace;

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
      // Steward status / pending-approval failures propagate to the catch
      // below, which renders an explicit error-carrying wallet state — a
      // swallowed failure here would paint "0 pending approvals" over real
      // pending transactions.
      const stewardStatus = await getStewardStatusRef.current();
      const resolvedWalletConfig =
        walletConfigRef.current ??
        // error-policy:J4 wallet config is optional decoration for this
        // panel (absent when the wallet plugin isn't loaded).
        (await client.getWalletConfig().catch(() => null));
      const pendingApprovals =
        stewardStatus?.connected === true
          ? (await getStewardPendingRef.current()).length
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
      // error-policy:J4 explicit degrade — the wallet panel renders an
      // error-carrying "unavailable" state, never healthy-empty.
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

  const {
    beginBrowserWalletFrameNavigation,
    revokeBrowserWalletFrame,
    syncBrowserWalletFrameTarget,
  } = useBrowserWorkspaceWalletBridge({
    iframeRefs,
    workspaceTabs: workspace.mode === "web" ? workspace.tabs : [],
    walletState: browserWalletState,
    loadWalletState: loadBrowserWalletState,
  });

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

  const readBrowserWorkspaceFocusReturnTarget = useCallback(() => {
    if (typeof document === "undefined") return null;
    const activeElement = document.activeElement;
    return activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      !(activeElement instanceof HTMLIFrameElement) &&
      activeElement.isConnected
      ? activeElement
      : null;
  }, []);

  const clearBrowserWorkspaceIframeFocusTimer = useCallback(
    (handoff: BrowserIframeFocusHandoff) => {
      if (handoff.timer === null || typeof window === "undefined") return;
      window.clearTimeout(handoff.timer);
      iframeFocusTimersRef.current.delete(handoff.timer);
      handoff.timer = null;
    },
    [],
  );

  const releaseBrowserWorkspaceIframeFocusReturn = useCallback(
    (iframe: HTMLIFrameElement, expected?: BrowserIframeFocusHandoff) => {
      const current = iframeFocusHandoffsRef.current.get(iframe);
      if (!current || (expected && current !== expected)) return;
      clearBrowserWorkspaceIframeFocusTimer(current);
      iframeFocusHandoffsRef.current.delete(iframe);
    },
    [clearBrowserWorkspaceIframeFocusTimer],
  );

  const monitorBrowserWorkspaceIframeFocus = useCallback(
    (iframe: HTMLIFrameElement, handoff: BrowserIframeFocusHandoff) => {
      if (
        typeof document === "undefined" ||
        typeof window === "undefined" ||
        iframeFocusHandoffsRef.current.get(iframe) !== handoff
      ) {
        return;
      }

      clearBrowserWorkspaceIframeFocusTimer(handoff);
      const activeElement = document.activeElement;
      const parentFocusIsNeutral =
        activeElement === null ||
        activeElement === document.body ||
        activeElement === document.documentElement ||
        activeElement === workspaceRootRef.current;
      if (activeElement === iframe || parentFocusIsNeutral) {
        // Pointer presence is not intent: a full-surface Browser commonly
        // remains hovered while the user types in chat. Only pointer-down or
        // keyboard entry cancels the handoff, through the listeners below.
        // WebKit may expose a neutral parent activeElement while focus lives
        // in the child frame, so that state receives the same restoration.
        const returnTarget = isAvailableBrowserFocusTarget(handoff.returnTarget)
          ? handoff.returnTarget
          : workspaceRootRef.current;
        returnTarget?.focus({ preventScroll: true });
        handoff.pendingTargetRestore =
          returnTarget === workspaceRootRef.current &&
          handoff.returnTarget !== null;
      }

      if (
        handoff.pendingTargetRestore &&
        document.activeElement === workspaceRootRef.current &&
        isAvailableBrowserFocusTarget(handoff.returnTarget)
      ) {
        handoff.returnTarget.focus({ preventScroll: true });
        handoff.pendingTargetRestore = false;
      }

      if (!handoff.loaded || Date.now() >= handoff.deadline) {
        if (handoff.loaded) {
          releaseBrowserWorkspaceIframeFocusReturn(iframe, handoff);
        }
        return;
      }

      const timer = window.setTimeout(
        () => monitorBrowserWorkspaceIframeFocus(iframe, handoff),
        BROWSER_IFRAME_FOCUS_POLL_MS,
      );
      handoff.timer = timer;
      iframeFocusTimersRef.current.add(timer);
    },
    [
      clearBrowserWorkspaceIframeFocusTimer,
      releaseBrowserWorkspaceIframeFocusReturn,
    ],
  );

  const armBrowserWorkspaceIframeFocusReturn = useCallback(
    (
      iframe: HTMLIFrameElement,
      options?: {
        preserveExistingForUrl?: boolean;
        returnTarget?: HTMLElement | null;
        navigationUrl?: string;
      },
    ) => {
      if (typeof window === "undefined") return;
      const existing = iframeFocusHandoffsRef.current.get(iframe);
      if (
        existing &&
        options?.preserveExistingForUrl &&
        existing.navigationUrl === options.navigationUrl
      ) {
        return;
      }
      if (existing) {
        releaseBrowserWorkspaceIframeFocusReturn(iframe, existing);
      }

      const handoff: BrowserIframeFocusHandoff = {
        returnTarget: options?.returnTarget
          ? options.returnTarget
          : (browserActionFocusReturnTargetRef.current ??
            readBrowserWorkspaceFocusReturnTarget()),
        navigationUrl: options?.navigationUrl ?? null,
        loaded: false,
        deadline: 0,
        timer: null,
        pendingTargetRestore: false,
      };
      iframeFocusHandoffsRef.current.set(iframe, handoff);
      const timer = window.setTimeout(
        () => releaseBrowserWorkspaceIframeFocusReturn(iframe, handoff),
        BROWSER_IFRAME_FOCUS_ARM_TIMEOUT_MS,
      );
      handoff.timer = timer;
      iframeFocusTimersRef.current.add(timer);
    },
    [
      readBrowserWorkspaceFocusReturnTarget,
      releaseBrowserWorkspaceIframeFocusReturn,
    ],
  );

  const beginBrowserWorkspaceIframeFocusSettle = useCallback(
    (iframe: HTMLIFrameElement) => {
      const handoff = iframeFocusHandoffsRef.current.get(iframe);
      if (!handoff) return;
      if (document.activeElement === iframe) {
        // A cross-origin child does not bubble its pointer events into the
        // embedding document. Focus that reached the frame before its load
        // event is therefore the durable signal that the user entered the
        // still-loading page; the delayed-autofocus guard must not undo it.
        releaseBrowserWorkspaceIframeFocusReturn(iframe, handoff);
        return;
      }
      clearBrowserWorkspaceIframeFocusTimer(handoff);
      handoff.loaded = true;
      handoff.deadline = Date.now() + BROWSER_IFRAME_FOCUS_SETTLE_MS;
      monitorBrowserWorkspaceIframeFocus(iframe, handoff);
    },
    [
      clearBrowserWorkspaceIframeFocusTimer,
      monitorBrowserWorkspaceIframeFocus,
      releaseBrowserWorkspaceIframeFocusReturn,
    ],
  );

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof HTMLIFrameElement) {
        releaseBrowserWorkspaceIframeFocusReturn(target);
        return;
      }
      if (!(target instanceof Element)) return;
      const focusTarget = target.closest<HTMLElement>(
        "button, input, textarea, select, a[href], [tabindex]",
      );
      if (!focusTarget || focusTarget === workspaceRootRef.current) return;
      for (const handoff of iframeFocusHandoffsRef.current.values()) {
        handoff.returnTarget = focusTarget;
        handoff.pendingTargetRestore = false;
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      for (const [iframe, handoff] of iframeFocusHandoffsRef.current) {
        releaseBrowserWorkspaceIframeFocusReturn(iframe, handoff);
      }
    };
    const handleWindowBlur = () => {
      for (const [iframe, handoff] of iframeFocusHandoffsRef.current) {
        // Cross-origin child events cannot cross the iframe boundary, but the
        // embedding element is :active synchronously while a real pointer
        // press transfers focus. Page autofocus produces the same
        // activeElement transition without that activation signal.
        if (iframe.matches(":active")) {
          releaseBrowserWorkspaceIframeFocusReturn(iframe, handoff);
        }
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("blur", handleWindowBlur, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", handleWindowBlur, true);
      for (const timer of iframeFocusTimersRef.current) {
        window.clearTimeout(timer);
      }
      iframeFocusTimersRef.current.clear();
      iframeFocusHandoffsRef.current.clear();
    };
  }, [releaseBrowserWorkspaceIframeFocusReturn]);

  const loadWorkspace = useCallback(
    async (options?: {
      preferTabId?: string | null;
      silent?: boolean;
      background?: boolean;
    }) => {
      const background = options?.background === true;
      const showLoading = options?.silent !== true;
      if (!background) {
        foregroundWorkspaceLoadsRef.current += 1;
      }
      const loadVersion = ++workspaceLoadVersionRef.current;
      if (showLoading) {
        visibleWorkspaceLoadsRef.current += 1;
        setLoading(true);
      }
      try {
        const snapshot = await client.getBrowserWorkspace();
        if (loadVersion !== workspaceLoadVersionRef.current) return;
        const previousSnapshot = workspaceSnapshotRef.current;
        for (const nextTab of snapshot.tabs) {
          if (snapshot.mode === "web") {
            syncBrowserWalletFrameTarget(nextTab.id, nextTab.url);
          }
          const previousTab = previousSnapshot.tabs.find(
            (tab) => tab.id === nextTab.id,
          );
          if (!previousTab) {
            pendingIframeFocusReturnTargetsRef.current.set(
              nextTab.id,
              browserActionFocusReturnTargetRef.current ??
                readBrowserWorkspaceFocusReturnTarget(),
            );
            continue;
          }
          if (previousTab.url === nextTab.url) continue;
          const iframe = iframeRefs.current.get(nextTab.id);
          if (iframe) {
            armBrowserWorkspaceIframeFocusReturn(iframe, {
              preserveExistingForUrl: true,
              navigationUrl: nextTab.url,
            });
          }
        }
        if (previousSnapshot.mode === "web") {
          const nextTabIds = new Set(snapshot.tabs.map((tab) => tab.id));
          for (const previousTab of previousSnapshot.tabs) {
            if (snapshot.mode !== "web" || !nextTabIds.has(previousTab.id)) {
              revokeBrowserWalletFrame(previousTab.id);
            }
          }
        }
        workspaceSnapshotRef.current = snapshot;
        setWorkspace(snapshot);
        setLoadError(null);
        setSelectedTabId((current) =>
          resolveBrowserWorkspaceSelection(
            snapshot.tabs,
            options?.preferTabId ?? current,
          ),
        );
      } catch (error) {
        if (background || loadVersion !== workspaceLoadVersionRef.current) {
          // error-policy:J4 poll — retain the last successful workspace on a
          // transient background failure; the next visible tick retries.
          return;
        }
        const message =
          error instanceof Error
            ? error.message
            : tRef.current("browserworkspace.LoadFailed", {
                defaultValue: "Failed to load browser workspace.",
              });
        setLoadError(message);
      } finally {
        if (!background) {
          foregroundWorkspaceLoadsRef.current -= 1;
        }
        if (showLoading) {
          visibleWorkspaceLoadsRef.current -= 1;
          if (visibleWorkspaceLoadsRef.current === 0) {
            setLoading(false);
          }
        }
      }
    },
    [
      armBrowserWorkspaceIframeFocusReturn,
      readBrowserWorkspaceFocusReturnTarget,
      revokeBrowserWalletFrame,
      syncBrowserWalletFrameTarget,
    ],
  );

  const runBrowserWorkspaceAction = useCallback(
    async (
      actionKey: string,
      action: () => Promise<void>,
      onErrorMessage?: string,
    ) => {
      const actionFocusReturnTarget = readBrowserWorkspaceFocusReturnTarget();
      browserActionFocusReturnTargetRef.current = actionFocusReturnTarget;
      workspaceActionsInFlightRef.current += 1;
      workspaceLoadVersionRef.current += 1;
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
        workspaceActionsInFlightRef.current -= 1;
        setBusyAction(null);
        if (
          browserActionFocusReturnTargetRef.current === actionFocusReturnTarget
        ) {
          browserActionFocusReturnTargetRef.current = null;
        }
      }
    },
    [readBrowserWorkspaceFocusReturnTarget],
  );

  const refreshWorkspaceInBackground = useCallback(async () => {
    if (
      backgroundWorkspaceRefreshInFlightRef.current ||
      foregroundWorkspaceLoadsRef.current > 0 ||
      workspaceActionsInFlightRef.current > 0
    ) {
      return;
    }
    backgroundWorkspaceRefreshInFlightRef.current = true;
    try {
      await loadWorkspace({
        preferTabId: selectedTabId,
        silent: true,
        background: true,
      });
    } finally {
      backgroundWorkspaceRefreshInFlightRef.current = false;
    }
  }, [loadWorkspace, selectedTabId]);

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
      const partition = resolveBrowserWorkspaceTabPartition(sectionKey);
      // Native mobile shell: the server manages no tabs (its API 503s), so the
      // tab lives in client state and the isolated native surface loads the page.
      if (browserTabRenderPath === "native-mobile-webview") {
        const tab = buildLocalBrowserWorkspaceTab(
          url,
          inferBrowserWorkspaceTitle(url, t),
          partition ?? BROWSER_WORKSPACE_DEFAULT_PARTITION,
        );
        setWorkspace((prev) => ({ ...prev, tabs: [...prev.tabs, tab] }));
        setSelectedTabId(tab.id);
        setLocationInput(tab.url);
        setLocationDirty(false);
        return;
      }
      const { tab } = await client.openBrowserWorkspaceTab({
        url,
        title: inferBrowserWorkspaceTitle(url, t),
        partition,
        show: true,
      });
      await loadWorkspace({ preferTabId: tab.id, silent: true });
      setSelectedTabId(tab.id);
      setLocationInput(tab.url);
      setLocationDirty(false);
    },
    [browserTabRenderPath, loadWorkspace, t],
  );

  const activateBrowserWorkspaceTab = useCallback(
    async (tabId: string) => {
      setSelectedTabId(tabId);
      // Native mobile shell: selection is client-side (the hook foregrounds the
      // matching native surface); there is no server tab to show.
      if (browserTabRenderPath === "native-mobile-webview") return;
      const { tab } = await client.showBrowserWorkspaceTab(tabId);
      await loadWorkspace({ preferTabId: tab.id, silent: true });
    },
    [browserTabRenderPath, loadWorkspace],
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
      // Native mobile shell: navigation is client-side. Updating the tab's URL
      // in state re-drives the native surface (the hook navigates the existing
      // WKWebView/WebView on a URL change rather than recreating it).
      if (browserTabRenderPath === "native-mobile-webview") {
        setWorkspace((prev) => ({
          ...prev,
          tabs: prev.tabs.map((tab) =>
            tab.id === selectedTabId
              ? { ...tab, url, updatedAt: new Date().toISOString() }
              : tab,
          ),
        }));
        setLocationInput(url);
        setLocationDirty(false);
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
          beginBrowserWalletFrameNavigation(selectedTabId, tab.url);
          armBrowserWorkspaceIframeFocusReturn(iframe, {
            navigationUrl: tab.url,
          });
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
      armBrowserWorkspaceIframeFocusReturn,
      beginBrowserWalletFrameNavigation,
      browserTabRenderPath,
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
      if (!registeredIframeElementsRef.current.has(iframe)) {
        registeredIframeElementsRef.current.add(iframe);
        const pendingReturnTarget =
          pendingIframeFocusReturnTargetsRef.current.get(tabId);
        pendingIframeFocusReturnTargetsRef.current.delete(tabId);
        armBrowserWorkspaceIframeFocusReturn(iframe, {
          returnTarget: pendingReturnTarget,
          navigationUrl:
            workspaceSnapshotRef.current.tabs.find((tab) => tab.id === tabId)
              ?.url ?? undefined,
        });
      }
      iframeRefs.current.set(tabId, iframe);
    },
    [armBrowserWorkspaceIframeFocusReturn],
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

  // Mobile native tab surfaces: iOS gives each Browser tab a fresh WKProcessPool
  // and data store; Android uses an out-of-app sandboxed renderer (which the OS
  // may reuse across WebViews) plus a per-tab storage profile. Surfaces are
  // backgrounded while the tab
  // switcher or any confirm dialog is open so the native layer never paints over
  // those React overlays — the mobile analogue of the desktop `masks=`.
  const nativeSurfaceTabs = useMemo(
    () => workspace.tabs.map((tab) => ({ id: tab.id, url: tab.url })),
    [workspace.tabs],
  );
  const nativeMobileTabPath = browserTabRenderPath === "native-mobile-webview";
  const nativeTabSurfaces = useMobileNativeTabSurfaces({
    active: nativeMobileTabPath,
    tabs: nativeSurfaceTabs,
    selectedTabId,
    overlayOpen: switcherOpen || browserWorkspaceConfirmOpen,
    occlusionSelector: BROWSER_WORKSPACE_TAB_MASK_SELECTORS,
    policy: BROWSER_NATIVE_SURFACE_POLICY,
    lifecycle: BROWSER_SURFACE_MANIFEST.lifecycle,
  });

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

        // Pick the most-recently-modified entry; first-save flows typically
        // have one entry per domain.
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
    return () => {
      observer.disconnect();
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

  const closeBrowserWorkspaceTabById = useCallback(
    async (tabId: string) => {
      // Native mobile shell: tabs are client-side. Drop the tab from state (the
      // hook tears down its native surface) and select a neighbour.
      if (browserTabRenderPath === "native-mobile-webview") {
        setWorkspace((prev) => {
          const remaining = prev.tabs.filter((tab) => tab.id !== tabId);
          if (tabId === selectedTabId) {
            setSelectedTabId(remaining[0]?.id ?? null);
          }
          return { ...prev, tabs: remaining };
        });
        return;
      }
      await client.closeBrowserWorkspaceTab(tabId);
      revokeBrowserWalletFrame(tabId);
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
    [
      browserTabRenderPath,
      loadWorkspace,
      revokeBrowserWalletFrame,
      selectedTabId,
    ],
  );

  const closeAllBrowserWorkspaceTabs = useCallback(async () => {
    const closableTabs = workspace.tabs.filter(
      (tab) => !isInternalBrowserWorkspaceTab(tab),
    );
    for (const tab of closableTabs) {
      await client.closeBrowserWorkspaceTab(tab.id);
      revokeBrowserWalletFrame(tab.id);
    }
    const snapshot = await client.getBrowserWorkspace();
    const nextId = snapshot.tabs[0]?.id ?? null;
    if (nextId) {
      await client.showBrowserWorkspaceTab(nextId);
    }
    setSelectedTabId(nextId);
    setLocationInput(snapshot.tabs.find((tab) => tab.id === nextId)?.url ?? "");
    setLocationDirty(false);
    await loadWorkspace({ preferTabId: nextId, silent: true });
  }, [loadWorkspace, revokeBrowserWalletFrame, workspace.tabs]);

  useEffect(() => {
    if (initialWorkspaceLoadStartedRef.current) return;
    initialWorkspaceLoadStartedRef.current = true;
    void loadWorkspace();
  }, [loadWorkspace]);

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
    void refreshWorkspaceInBackground();
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
    if (browserTabRenderPath === "native-mobile-webview") {
      nativeTabSurfaces.reloadSurface(selectedTab.id);
      return;
    }
    if (workspace.mode === "web") {
      const iframe = iframeRefs.current.get(selectedTab.id);
      if (iframe) {
        beginBrowserWalletFrameNavigation(selectedTab.id, selectedTab.url);
        armBrowserWorkspaceIframeFocusReturn(iframe, {
          navigationUrl: selectedTab.url,
        });
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
  }, [
    armBrowserWorkspaceIframeFocusReturn,
    beginBrowserWalletFrameNavigation,
    browserTabRenderPath,
    nativeTabSurfaces,
    selectedTab,
    workspace.mode,
  ]);

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
  const agentActiveLabel = t("browserworkspace.AgentActive", {
    defaultValue: "Agent is on this tab",
  });

  // Map the section-grouped tabs down to the switcher's display shape and fold
  // them (#13596). The switcher — not a permanent sidebar strip — is the only
  // multi-tab surface, so it must carry every section (agent tabs stay visually
  // distinct) while the toolbar shows just the folded count + active label.
  const switcherTabs = useMemo<BrowserSwitcherTab[]>(
    () =>
      workspace.tabs.map((tab) => {
        const label = getBrowserWorkspaceTabLabel(tab, t);
        return {
          id: tab.id,
          label,
          description: getBrowserWorkspaceTabDescription(tab, workspace.mode),
          monogram: getBrowserWorkspaceTabMonogram(label),
          section: resolveBrowserWorkspaceTabSectionKey(tab),
          closable: !isInternalBrowserWorkspaceTab(tab),
          hasSessionFocus:
            workspace.mode === "web" ? tab.visible : tab.id === selectedTabId,
        };
      }),
    [selectedTabId, t, workspace.mode, workspace.tabs],
  );
  const foldedTabs = useMemo(
    () =>
      foldBrowserTabs(switcherTabs, selectedTabId, {
        user: userTabsLabel,
        agent: agentTabsLabel,
        app: appTabsLabel,
      }),
    [switcherTabs, selectedTabId, userTabsLabel, agentTabsLabel, appTabsLabel],
  );
  const foldControlActiveLabel =
    foldedTabs.activeTab?.label ??
    t("browserworkspace.NoActiveTab", { defaultValue: "No tab" });
  const openTabSwitcherLabel = t("browserworkspace.OpenTabSwitcher", {
    defaultValue: "Show {{count}} tabs",
    count: foldedTabs.count,
  });

  const navNode = (
    <div className="grid grid-cols-[2.75rem_minmax(0,1fr)_repeat(3,2.75rem)] items-center gap-1 px-1.5 py-1 md:grid-cols-[2.75rem_minmax(10rem,4fr)_repeat(3,2.75rem)_minmax(10rem,5fr)_repeat(2,2.75rem)] md:gap-1.5 md:px-2 md:py-1.5 lg:gap-2 lg:px-3 lg:py-2">
      <TooltipHint
        content={t("common.backToLauncher", {
          defaultValue: "Back to launcher",
        })}
      >
        <ViewBackButton
          label={t("common.backToLauncher", {
            defaultValue: "Back to launcher",
          })}
          className="shrink-0"
        />
      </TooltipHint>
      {/* Folded tabs (#13596): one compact count control opens the switcher —
          no permanent tab strip. It names the active tab so the user always
          knows which page is live even with the rest folded away. */}
      <BrowserTabFoldControl
        activeLabel={foldControlActiveLabel}
        count={foldedTabs.count}
        openLabel={openTabSwitcherLabel}
        onOpen={() => setSwitcherOpen(true)}
      />
      <BrowserNavButton
        agentId="new-tab"
        agentLabel={newTabLabel}
        agentDescription="Open a new browser tab"
        group="browser-nav"
        onActivate={() =>
          void runBrowserWorkspaceAction("open:new", async () => {
            await openNewBrowserWorkspaceTab(
              newBrowserWorkspaceTabSeedUrl,
              "user",
            );
          })
        }
        variant="ghost"
        size="icon"
        className="h-11 w-11 shrink-0"
        aria-label={newTabLabel}
        disabled={busyAction !== null}
        onClick={() =>
          void runBrowserWorkspaceAction("open:new", async () => {
            await openNewBrowserWorkspaceTab(
              newBrowserWorkspaceTabSeedUrl,
              "user",
            );
          })
        }
        data-testid="browser-workspace-nav-new-tab"
      >
        <Plus className="h-4 w-4" />
      </BrowserNavButton>
      <BrowserNavButton
        agentId="reload"
        agentLabel={t("common.refresh", { defaultValue: "Refresh" })}
        agentDescription="Reload the active browser tab"
        group="browser-nav"
        onActivate={() =>
          void runBrowserWorkspaceAction("reload:selected", async () => {
            await reloadSelectedBrowserWorkspaceTab();
          })
        }
        variant="ghost"
        size="icon"
        className="h-11 w-11"
        aria-label={t("common.refresh", { defaultValue: "Refresh" })}
        disabled={!selectedTab || busyAction !== null}
        onClick={() =>
          void runBrowserWorkspaceAction("reload:selected", async () => {
            await reloadSelectedBrowserWorkspaceTab();
          })
        }
      >
        <RefreshCw className="h-4 w-4" />
      </BrowserNavButton>
      <BrowserNavButton
        agentId="close-all-tabs"
        agentLabel={t("browserworkspace.CloseAllTabs", {
          defaultValue: "Close all tabs",
        })}
        agentDescription="Close every user browser tab"
        group="browser-nav"
        onActivate={() =>
          void runBrowserWorkspaceAction("close:all", async () => {
            await closeAllBrowserWorkspaceTabs();
          })
        }
        variant="ghost"
        size="icon"
        className="h-11 w-11"
        aria-label={t("browserworkspace.CloseAllTabs", {
          defaultValue: "Close all tabs",
        })}
        disabled={
          busyAction !== null ||
          !workspace.tabs.some((tab) => !isInternalBrowserWorkspaceTab(tab))
        }
        onClick={() =>
          void runBrowserWorkspaceAction("close:all", async () => {
            await closeAllBrowserWorkspaceTabs();
          })
        }
        data-testid="browser-workspace-close-all-tabs"
      >
        <X className="h-4 w-4" />
      </BrowserNavButton>
      <BrowserAddressInput
        agentLabel={t("browserworkspace.AddressPlaceholder", {
          defaultValue: selectedTabIsInternal
            ? "Internal tab URL is managed by the app"
            : "Enter a URL",
        })}
        agentDescription="The browser address bar for the active tab"
        getValue={() => locationInput}
        onFill={(value) => {
          setLocationInput(value);
          setLocationDirty(true);
        }}
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
        className="col-span-2 h-11 min-w-[10rem] flex-1 rounded-full border-transparent bg-card/70 px-4 text-sm text-txt shadow-inset md:col-span-1"
      />
      <BrowserNavButton
        agentId="go"
        agentLabel={goLabel}
        agentDescription="Navigate the active tab to the address bar URL"
        group="browser-nav"
        onActivate={() =>
          void runBrowserWorkspaceAction("navigate:click", async () => {
            await navigateSelectedBrowserWorkspaceTab(locationInput);
          })
        }
        variant="outline"
        size="sm"
        className="h-11 shrink-0 px-3"
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
      </BrowserNavButton>
      <BrowserNavButton
        agentId="open-external"
        agentLabel={t("browserworkspace.OpenExternal", {
          defaultValue: "Open external",
        })}
        agentDescription="Open the active tab URL in an external browser"
        group="browser-nav"
        onActivate={() =>
          void runBrowserWorkspaceAction("open:external", async () => {
            if (!selectedTab) return;
            await openExternalUrl(selectedTab.url);
          })
        }
        variant="ghost"
        size="icon"
        className="h-11 w-11"
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
      </BrowserNavButton>
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
      className="relative flex-1 min-h-0 overflow-hidden"
    >
      {watchBannerLabel ? (
        <div
          className="absolute left-3 right-3 top-2 z-20 flex items-center gap-2 rounded-sm bg-card/95 px-3 py-1.5 text-xs text-muted"
          role="status"
          aria-live="polite"
          data-testid="browser-workspace-watch-banner"
        >
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent "
          />
          <span className="truncate">{watchBannerLabel}</span>
        </div>
      ) : null}
      {loadError ? (
        <div
          className="absolute left-1/2 top-6 z-20 -translate-x-1/2 rounded-sm border border-danger/50 bg-danger/15 px-3 py-1.5 text-xs text-danger"
          role="alert"
        >
          {loadError}
        </div>
      ) : null}

      {workspace.tabs.length === 0 ? (
        loading ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-sm text-muted">
              {t("browserworkspace.Loading", {
                defaultValue: "Loading browser workspace",
              })}
            </div>
          </div>
        ) : (
          // The designed-empty column centers with margin-auto INSIDE the
          // scroller (not justify-center on the scroller itself) so a short
          // viewport degrades to a scrollable top-aligned column instead of
          // clipping the heading above the scroll origin.
          <div className="flex h-full min-h-0 flex-col overflow-y-auto pt-3 pb-[calc(var(--eliza-chat-clearance,5.25rem)+1rem)] pe-[var(--eliza-chat-side-clearance,0px)]">
            <div className="m-auto flex w-full min-w-0 flex-col items-center">
              <PagePanel.Empty
                variant="inset"
                className="flex-none py-1 sm:py-2"
                icon={<Globe className="h-6 w-6" aria-hidden />}
                title={t("browserworkspace.EmptyTitle", {
                  defaultValue: "No page open",
                })}
                action={
                  <Button
                    variant="default"
                    size="sm"
                    className="min-h-11 gap-1.5"
                    onClick={() =>
                      void runBrowserWorkspaceAction("open:home", async () => {
                        await openNewBrowserWorkspaceTab(
                          BROWSER_WORKSPACE_DEFAULT_HOME_URL,
                          "user",
                        );
                      })
                    }
                  >
                    <Plus className="h-4 w-4" aria-hidden />
                    {t("browserworkspace.OpenWebsite", {
                      defaultValue: "Open a website",
                    })}
                  </Button>
                }
              />
              {/* Bottom + side chat clearance is reserved once, on the scroller
                above — repeating it on this grid double-counted the inset in
                short landscape and squeezed the column off-canvas. */}
              {workspace.mode === "web" &&
              browserBridgeSupported &&
              !browserBridgeUnsupportedInNativeLocalMode ? (
                <div className="grid w-full max-w-xl grid-cols-1 items-stretch gap-1.5 px-6 sm:grid-cols-3">
                  <div className="text-center text-[11px] text-muted sm:col-span-3">
                    {browserBridgeConnected
                      ? t("browserworkspace.BrowserBridgeConnected", {
                          defaultValue: "Browser Bridge connected",
                        })
                      : browserBridgeAvailable
                        ? t("browserworkspace.BrowserBridgeAvailable", {
                            defaultValue: "Browser Bridge available",
                          })
                        : t("browserworkspace.BrowserBridgeNotConnected", {
                            defaultValue:
                              "Let the agent drive your real Chrome tabs",
                          })}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyAction !== null}
                    onClick={() => void installBrowserBridgeExtension()}
                    className="min-h-11 sm:col-span-3"
                  >
                    {t("browserworkspace.InstallBrowserBridge", {
                      defaultValue: "Install Agent Browser Bridge",
                    })}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={
                      busyAction !== null ||
                      !browserBridgePackageStatus?.chromeBuildPath
                    }
                    onClick={() => void revealBrowserBridgeFolder()}
                    className="min-h-11 min-w-0"
                  >
                    <FolderOpen className="h-4 w-4" />
                    <span className="truncate">
                      {t("browserworkspace.OpenBrowserBridgeFolder", {
                        defaultValue: "Open extension folder",
                      })}
                    </span>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyAction !== null}
                    onClick={() => void openBrowserBridgeChromeExtensions()}
                    className="min-h-11 min-w-0"
                  >
                    <span className="truncate">
                      {t("browserworkspace.OpenChromeExtensions", {
                        defaultValue: "Open Chrome extensions",
                      })}
                    </span>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={browserBridgeLoading || busyAction !== null}
                    onClick={() => void refreshBrowserBridgeConnection()}
                    className="min-h-11 min-w-0"
                  >
                    <RefreshCw className="h-4 w-4" />
                    <span className="truncate">
                      {t("browserworkspace.RefreshBrowserBridge", {
                        defaultValue: "Refresh connection",
                      })}
                    </span>
                  </Button>
                </div>
              ) : null}
              {workspace.mode === "web" &&
              browserBridgeSupported &&
              !browserBridgeUnsupportedInNativeLocalMode ? (
                <div className="mt-4 flex w-full max-w-xl flex-col gap-2 px-6 pb-4">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
                    {t("browserworkspace.AgentBrowserSessions", {
                      defaultValue: "Agent browser sessions",
                    })}
                  </div>
                  <BrowserSessionPolicyPanel api={client} />
                </div>
              ) : null}
            </div>
          </div>
        )
      ) : browserTabRenderPath === "native-child-webview" ? (
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
      ) : browserTabRenderPath === "native-mobile-webview" ? (
        nativeTabSurfaces.error ? (
          <div
            role="alert"
            className="absolute inset-0 flex h-full w-full items-center justify-center bg-bg px-6 text-center"
          >
            <div className="flex max-w-sm flex-col items-center gap-3 rounded-3xl border border-border bg-bg-elevated p-6 shadow-lg">
              <div className="text-sm font-semibold text-txt">
                {nativeTabSurfaces.error.permanent
                  ? t("browserworkspace.NativeSurfaceUnsupported", {
                      defaultValue: "Secure browsing not supported here",
                    })
                  : t("browserworkspace.NativeSurfaceUnavailable", {
                      defaultValue: "Browser view unavailable",
                    })}
              </div>
              <div className="text-xs leading-5 text-muted">
                {nativeTabSurfaces.error.permanent
                  ? t("browserworkspace.NativeSurfaceUnsupportedDescription", {
                      defaultValue:
                        "This device's system WebView cannot provide the isolation Eliza requires, so Eliza will not open pages inside the app. You can open the page in the device browser instead.",
                    })
                  : t("browserworkspace.NativeSurfaceUnavailableDescription", {
                      defaultValue:
                        "The secure browser surface could not connect. Retry without losing your tabs.",
                    })}
              </div>
              {nativeTabSurfaces.error.permanent ? (
                selectedTab ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busyAction !== null}
                    onClick={() =>
                      void runBrowserWorkspaceAction(
                        `open:external:${selectedTab.id}`,
                        async () => {
                          await openExternalUrl(selectedTab.url);
                        },
                      )
                    }
                  >
                    <ExternalLink className="h-4 w-4" />
                    {t("browserworkspace.OpenExternal", {
                      defaultValue: "Open external",
                    })}
                  </Button>
                ) : null
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={nativeTabSurfaces.retry}
                >
                  {t("common.retry", { defaultValue: "Retry" })}
                </Button>
              )}
            </div>
          </div>
        ) : (
          workspace.tabs.map((tab) => {
            const active = tab.id === selectedTabId;
            const visibilityClass = active
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0";
            return (
              // The native WKWebView / Android WebView is layered over this
              // placeholder by `useMobileNativeTabSurfaces`; the div reports
              // the chat-safe content rect. Expanded overlays still use native
              // occlusion holes, while the resting composer owns real layout
              // space so page controls never sit underneath it.
              <div
                key={tab.id}
                ref={(el) =>
                  nativeTabSurfaces.registerSurfaceElement(tab.id, el)
                }
                aria-hidden={!active}
                className={`absolute inset-0 h-full w-full bg-bg transition-opacity ${visibilityClass}`}
                style={{ colorScheme: uiTheme }}
              />
            );
          })
        )
      ) : browserTabRenderPath === "sandboxed-iframe" ? (
        workspace.tabs.map((tab) => {
          const active = tab.id === selectedTabId;
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
                      defaultValue: "This site blocks embedded frames.",
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
              onPointerDownCapture={(event) => {
                releaseBrowserWorkspaceIframeFocusReturn(event.currentTarget);
              }}
              onKeyDownCapture={(event) => {
                if (event.key === "Tab") {
                  releaseBrowserWorkspaceIframeFocusReturn(event.currentTarget);
                }
              }}
              onLoad={(event) => {
                beginBrowserWorkspaceIframeFocusSettle(event.currentTarget);
              }}
            />
          );
        })
      ) : (
        <div className="flex h-full flex-1 flex-col bg-bg">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted">
            <span className="font-medium text-txt">
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
              <Button
                variant="ghost"
                size="sm"
                className="h-auto rounded-sm px-2 py-1 text-txt transition-colors hover:bg-card/60"
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
              </Button>
            ) : null}
          </div>

          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
            {snapshotError ? (
              <div
                className="absolute left-1/2 top-6 z-20 -translate-x-1/2 rounded-sm border border-danger/50 bg-danger/15 px-3 py-1.5 text-xs text-danger"
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
            <div className="px-3 py-2 text-xs text-muted">
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

  // Fullscreen surface framing (parity with Notes/Calendar): the shell mounts
  // this view edge-to-edge (`header: "fullscreen"` in the builtin registry), so
  // the view owns its whole chrome — no host ViewHeader row, no workspace
  // chrome. The toolbar (folded-tab control + URL bar) floats as a glass panel
  // over the opaque app background. Compact mobile gutters leave more room for
  // the page without shrinking touch targets; large screens retain the shared
  // Notes/Calendar clamp rhythm. The web surface fills the remaining height as
  // a second rounded panel. Tabs stay folded into the switcher (no permanent
  // tab strip), matching #13596.
  const mainNode = (
    <main
      ref={workspaceRootRef}
      aria-label={t("browserworkspace.ViewTitle", { defaultValue: "Browser" })}
      data-testid="browser-workspace-view"
      data-chat-clearance-aware="true"
      tabIndex={-1}
      className="relative flex h-full min-h-0 w-full min-w-0 flex-col gap-1.5 overflow-hidden bg-bg px-1.5 pt-[calc(0.375rem+var(--safe-area-top,0px))] pb-[calc(0.5rem+var(--eliza-mobile-nav-offset,0px)+max(var(--safe-area-bottom,0px),var(--android-gesture-inset-bottom,0px))+var(--eliza-chat-clearance,5.25rem))] lg:gap-[clamp(8px,1.6vw,14px)] lg:px-[clamp(8px,2.4vw,24px)] lg:pt-[calc(clamp(8px,2.4vw,24px)+var(--safe-area-top,0px))] lg:pb-[calc(clamp(8px,2.4vw,24px)+var(--eliza-mobile-nav-offset,0px)+max(var(--safe-area-bottom,0px),var(--android-gesture-inset-bottom,0px))+var(--eliza-chat-clearance,5.25rem))]"
    >
      <div
        data-testid="browser-workspace-toolbar"
        className="shrink-0 rounded-3xl bg-[color-mix(in_srgb,var(--card)_76%,transparent)] shadow-[inset_0_1px_0_rgba(255,255,255,.10),0_18px_48px_rgba(0,0,0,.20)] backdrop-blur-[24px] backdrop-saturate-[1.45]"
      >
        {navNode}
      </div>
      {/* The web-surface panel carries fill + radius only — no box-shadow.
          A shadow on this near-full-viewport panel reads as visual furniture
          (and the minimalism occupancy scan rightly counts it as such in
          short landscape); the toolbar above keeps the full glass treatment. */}
      <div
        data-testid="browser-workspace-surface-panel"
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-3xl bg-[color-mix(in_srgb,var(--card)_76%,transparent)]"
      >
        {browserSurface}
      </div>
    </main>
  );

  return (
    <ShellViewAgentSurface viewId="browser">
      {mainNode}
      <BrowserTabSwitcher
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        folded={foldedTabs}
        activeTabId={selectedTabId}
        title={tabsLabel}
        closeLabel={closeTabLabel}
        agentActiveLabel={agentActiveLabel}
        newTabLabel={newTabLabel}
        emptyLabel={t("browserworkspace.NoTabsYet", {
          defaultValue: "No tabs open yet",
        })}
        actionsDisabled={busyAction !== null}
        onActivateTab={(id) =>
          void runBrowserWorkspaceAction(`show:${id}`, async () => {
            await activateBrowserWorkspaceTab(id);
          })
        }
        onCloseTab={(id) =>
          void runBrowserWorkspaceAction(`close:${id}`, async () => {
            await closeBrowserWorkspaceTabById(id);
          })
        }
        onNewTab={() =>
          void runBrowserWorkspaceAction("open:new", async () => {
            await openNewBrowserWorkspaceTab(
              newBrowserWorkspaceTabSeedUrl,
              "user",
            );
          })
        }
      />
      <ConfirmDialog {...vaultAutofillModalProps} />
      <ConfirmDialog {...walletActionModalProps} />
    </ShellViewAgentSurface>
  );
}
