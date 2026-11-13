/** Renders the browser workspace with tab switching, navigation, and native or iframe page surfaces. */

import { Capacitor } from "@capacitor/core";
import type { NavigateViewDetail } from "@elizaos/core/protocol";
import {
  ArrowLeft,
  ArrowRight,
  EllipsisVertical,
  ExternalLink,
  Globe,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentElement } from "../../agent-surface/useAgentElement";
import type {
  BrowserWorkspaceSnapshot,
  BrowserWorkspaceTab,
} from "../../api/browser-contracts";
import { client } from "../../api/client";
import { isApiError } from "../../api/client-types-core";
import { resolveBuiltinSurfaceManifest } from "../../builtin-tab-registry";
import { NAVIGATE_VIEW_EVENT } from "../../events";
import { useActiveAgentAuthority } from "../../hooks/useActiveAgentAuthority";
import { useIntervalWhenDocumentVisible } from "../../hooks/useDocumentVisibility";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { useAppSelectorShallow } from "../../state/app-store";
import { deriveSurfacePlacement } from "../../surface/native-surface-shell";
import { useMobileNativeTabSurfaces } from "../../surface/use-mobile-native-tab-surfaces";
import { resolveBrowserTabRenderPath } from "../../surface-embedding";
import { resolveApiUrl } from "../../utils/asset-url.js";
import { openExternalUrl } from "../../utils/openExternalUrl";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { TooltipHint } from "../ui/tooltip";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { AndroidChromiumBrowser } from "./AndroidChromiumBrowser";
import {
  type BrowserSwitcherTab,
  BrowserTabFoldControl,
  BrowserTabSwitcher,
  foldBrowserTabs,
} from "./BrowserTabSwitcher";
import { parseBrowserWorkspaceInputUrl } from "./browser-workspace-host-identity";
import {
  type BrowserWorkspaceWalletState,
  buildBrowserWorkspaceWalletState,
} from "./browser-workspace-wallet";
import { useBrowserWorkspaceWalletBridge } from "./useBrowserWorkspaceWalletBridge";

const POLL_INTERVAL_MS = 2500;
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
const BROWSER_IFRAME_FOCUS_SETTLE_MS = 1500;
const BROWSER_IFRAME_FOCUS_ARM_TIMEOUT_MS = 30000;
const BROWSER_IFRAME_FOCUS_POLL_MS = 16;
const BROWSER_WORKSPACE_RUNTIME_UNAVAILABLE_CODE =
  "browser_workspace_runtime_unavailable";
type BrowserWorkspaceLoadError = {
  message: string;
  code?: string;
  retryable: boolean;
};
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
// uses `role=status`.
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
function isBrowserWorkspaceSessionMode(
  mode: BrowserWorkspaceSnapshot["mode"],
): boolean {
  // Cloud is the only mode that uses the snapshot-preview UX.
  return mode === "cloud";
}
function resolveBrowserWorkspaceLoadError(
  error: unknown,
  t: TranslateFn,
): BrowserWorkspaceLoadError {
  const apiError = isApiError(error) ? error : null;
  const errorData = apiError?.data;
  const structuredRetryable =
    typeof errorData === "object" &&
    errorData !== null &&
    "retryable" in errorData &&
    typeof (
      errorData as {
        retryable?: unknown;
      }
    ).retryable === "boolean"
      ? (
          errorData as {
            retryable: boolean;
          }
        ).retryable
      : undefined;
  const code = apiError?.code;
  if (code === BROWSER_WORKSPACE_RUNTIME_UNAVAILABLE_CODE) {
    return {
      code,
      message: t("browserworkspace.DedicatedRuntimeRequired", {
        defaultValue: "In-app browsing isn’t available with this connection.",
      }),
      retryable: false,
    };
  }
  if (apiError?.status === 404) {
    return {
      ...(code ? { code } : {}),
      message: t("browserworkspace.ServiceUnavailable", {
        defaultValue: "In-app browsing isn’t available here.",
      }),
      retryable: false,
    };
  }
  return {
    ...(code ? { code } : {}),
    message: t("browserworkspace.ConnectionFailed", {
      defaultValue: "Browser couldn’t connect. Try again in a moment.",
    }),
    retryable: structuredRetryable ?? true,
  };
}
export function normalizeBrowserWorkspaceInputUrl(
  rawUrl: string,
  t: TranslateFn,
): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (trimmed === "about:blank") return trimmed;
  if (/^\/[\\/]/.test(trimmed)) {
    throw new Error(
      t("browserworkspace.InvalidUrl", {
        defaultValue: "Enter a valid http or https URL.",
      }),
    );
  }
  const parsed = parseBrowserWorkspaceInputUrl(
    trimmed.startsWith("/")
      ? new URL(resolveApiUrl(trimmed), window.location.origin).toString()
      : trimmed,
  );
  if (parsed.ok) return parsed.url;
  if (parsed.reason === "unsupported") {
    throw new Error(
      t("browserworkspace.UnsupportedProtocol", {
        defaultValue: "Only http and https URLs are supported.",
      }),
    );
  }
  throw new Error(
    t("browserworkspace.InvalidUrl", {
      defaultValue: "Enter a valid http or https URL.",
    }),
  );
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
 * Build a client-side tab for the native mobile shell. Unlike web, the
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
  const authority = useActiveAgentAuthority();
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
    return <AndroidChromiumBrowser key={authority} />;
  }
  return <BrowserWorkspaceForAuthority key={authority} />;
}
/**
 * Browser state includes live tabs, snapshots, native surfaces, wallet grants,
 * and in-flight agent requests. Keying that complete state owner by authority
 * makes an in-place profile switch equivalent to a clean mount: the prior
 * profile disappears before the next paint and its late promises target an
 * unmounted tree instead of the newly active agent.
 */
function BrowserWorkspaceForAuthority({
  handleInitialBrowse = true,
}: {
  handleInitialBrowse?: boolean;
} = {}): React.JSX.Element {
  useRenderGuard("BrowserWorkspaceView");
  const {
    getStewardPending,
    getStewardStatus,
    setActionNotice,
    t,
    uiTheme,
    walletAddresses,
    walletConfig,
  } = useAppSelectorShallow((s) => ({
    getStewardPending: s.getStewardPending,
    getStewardStatus: s.getStewardStatus,
    setActionNotice: s.setActionNotice,
    t: s.t,
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
  const [loadError, setLoadError] = useState<BrowserWorkspaceLoadError | null>(
    null,
  );
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [tabSnapshots, setTabSnapshots] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  // The folded-tab switcher overlay (#13596). The browser folds every tab into
  // this one switcher instead of a permanent sidebar strip, so this is the only
  // multi-tab surface — opened from the toolbar's fold control.
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const initialBrowseUrlRef = useRef<string | null | undefined>(undefined);
  const initialBrowseHandledRef = useRef(false);
  const workspaceRootRef = useRef<HTMLElement | null>(null);
  const workspaceSnapshotRef = useRef<BrowserWorkspaceSnapshot>(workspace);
  // Polls are slower than their cadence when the API is unhealthy. Keep them
  // single-flight, and order every response so a late poll cannot roll back a
  // newer user action or turn stale-state refresh noise into a page failure.
  const workspaceLoadVersionRef = useRef(0);
  const workspaceLoadAbortControllerRef = useRef<AbortController | null>(null);
  const snapshotAbortControllerRef = useRef<AbortController | null>(null);
  const lifecycleAbortControllerRef = useRef(new AbortController());
  const lifecycleEffectEpochRef = useRef(0);
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
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const mobileActionsMenuRef = useRef<HTMLDivElement | null>(null);
  const mobileActionsFocusRef = useRef<HTMLElement | null>(null);
  const pendingIframeFocusReturnTargetsRef = useRef(
    new Map<string, HTMLElement | null>(),
  );
  const getStewardPendingRef = useRef(getStewardPending);
  const getStewardStatusRef = useRef(getStewardStatus);
  const setActionNoticeRef = useRef(setActionNotice);
  const tRef = useRef(t);
  const walletAddressesRef = useRef(walletAddresses);
  const walletConfigRef = useRef(walletConfig);
  const previousSelectedTabIdRef = useRef<string | null>(null);
  if (typeof initialBrowseUrlRef.current === "undefined") {
    const browseParam = handleInitialBrowse
      ? readBrowserWorkspaceQueryParam("browse")
      : null;
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
  // and we pass it explicitly.
  const nativeMobileShell = useMemo(() => Capacitor.isNativePlatform(), []);
  // Which embedding each browser tab renders into, DRIVEN by the view's declared
  // isolation level (not the raw mode string): `native-webview` resolves, on a
  // native mobile shell, to a layered `WKWebView` / `WebView`; plain web resolves to a sandboxed iframe; cloud to a server
  // snapshot. Reading the manifest here is what makes `isolation:
  // "native-webview"` authoritative (#14181/#15245) — a view without that level
  // could never reach a native surface.
  const browserTabRenderPath = resolveBrowserTabRenderPath({
    isolation: BROWSER_SURFACE_ISOLATION,
    mode: workspace.mode,
    nativeMobileShell,
  });
  // The native mobile shell owns its tabs locally, so an absent server-side
  // workspace is a usable empty state there. Every other renderer depends on
  // the workspace API: a failed initial read is unavailability, never an empty
  // browser. Keep that distinction central so the surface and every mutating
  // control agree on what the user can actually do.
  const browserWorkspaceUsesLocalTabs =
    browserTabRenderPath === "native-mobile-webview";
  const browserWorkspaceUnavailable =
    !browserWorkspaceUsesLocalTabs &&
    loadError !== null &&
    workspace.tabs.length === 0;
  const browserWorkspaceCanRetryLoad =
    loadError?.retryable === true &&
    loadError.code !== BROWSER_WORKSPACE_RUNTIME_UNAVAILABLE_CODE;
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
  workspaceSnapshotRef.current = workspace;
  useEffect(() => {
    const epoch = ++lifecycleEffectEpochRef.current;
    return () => {
      // React StrictMode performs a setup/cleanup/setup probe without actually
      // discarding this state owner. Defer one microtask so the second setup can
      // supersede that probe; a real unmount or authority-key replacement has
      // no next setup and therefore aborts every lifecycle-owned read.
      queueMicrotask(() => {
        if (lifecycleEffectEpochRef.current !== epoch) return;
        lifecycleAbortControllerRef.current.abort(
          "Browser workspace unmounted",
        );
        workspaceLoadAbortControllerRef.current?.abort(
          "Browser workspace unmounted",
        );
        snapshotAbortControllerRef.current?.abort(
          "Browser workspace unmounted",
        );
      });
    };
  }, []);
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
  const dismissMobileActions = useCallback(() => {
    setMobileActionsOpen(false);
    // Explicit dismissal ends the navigation's return-to-toolbar handoff.
    // Otherwise its settle timer can undo the user's next click inside the
    // embedded page. A frame taking focus while the menu is open still goes
    // through onOpenChange's modal guard, not this user-dismissal path.
    for (const [iframe, handoff] of iframeFocusHandoffsRef.current) {
      releaseBrowserWorkspaceIframeFocusReturn(iframe, handoff);
    }
  }, [releaseBrowserWorkspaceIframeFocusReturn]);
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
      const menu = mobileActionsMenuRef.current;
      if (
        menu?.dataset.state === "open" &&
        target instanceof Element &&
        !menu.contains(target) &&
        !target.closest('[data-testid="browser-workspace-mobile-more"]')
      ) {
        // The modal's deferred outside-click listener may not yet be armed
        // when a user immediately leaves a newly opened menu.
        dismissMobileActions();
      }
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
  }, [dismissMobileActions, releaseBrowserWorkspaceIframeFocusReturn]);
  const loadWorkspace = useCallback(
    async (options?: {
      preferTabId?: string | null;
      silent?: boolean;
      background?: boolean;
    }) => {
      const lifecycleSignal = lifecycleAbortControllerRef.current.signal;
      if (lifecycleSignal.aborted) return;
      workspaceLoadAbortControllerRef.current?.abort(
        "Browser workspace refresh superseded",
      );
      const abortController = new AbortController();
      workspaceLoadAbortControllerRef.current = abortController;
      const abortForLifecycle = () =>
        abortController.abort(lifecycleSignal.reason);
      lifecycleSignal.addEventListener("abort", abortForLifecycle, {
        once: true,
      });
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
        const snapshot = await client.getBrowserWorkspace({
          signal: abortController.signal,
        });
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
        if (abortController.signal.aborted) return;
        if (background || loadVersion !== workspaceLoadVersionRef.current) {
          // error-policy:J4 poll — retain the last successful workspace on a
          // transient background failure; the next visible tick retries.
          return;
        }
        setLoadError(resolveBrowserWorkspaceLoadError(error, tRef.current));
      } finally {
        lifecycleSignal.removeEventListener("abort", abortForLifecycle);
        if (workspaceLoadAbortControllerRef.current === abortController) {
          workspaceLoadAbortControllerRef.current = null;
        }
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
        setActionNoticeRef.current(message, "error", 4000);
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
    // Native-mobile tabs are authoritative client state: the remote agent's
    // workspace endpoint deliberately has no matching native WebView tabs.
    // Polling that empty server snapshot would erase a tab (and its permanent
    // capability/error recovery surface) moments after the user opened it.
    if (browserTabRenderPath === "native-mobile-webview") return;
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
  }, [browserTabRenderPath, loadWorkspace, selectedTabId]);
  const loadSelectedBrowserWorkspaceSnapshot = useCallback(
    async (tabId: string, mode: BrowserWorkspaceSnapshot["mode"]) => {
      if (!isBrowserWorkspaceSessionMode(mode)) {
        snapshotAbortControllerRef.current?.abort(
          "Browser preview is no longer active",
        );
        setSnapshotError(null);
        return;
      }
      const lifecycleSignal = lifecycleAbortControllerRef.current.signal;
      if (lifecycleSignal.aborted) return;
      snapshotAbortControllerRef.current?.abort(
        "Browser preview refresh superseded",
      );
      const abortController = new AbortController();
      snapshotAbortControllerRef.current = abortController;
      const abortForLifecycle = () =>
        abortController.abort(lifecycleSignal.reason);
      lifecycleSignal.addEventListener("abort", abortForLifecycle, {
        once: true,
      });
      try {
        const snapshot = await client.snapshotBrowserWorkspaceTab(tabId, {
          signal: abortController.signal,
        });
        setTabSnapshots((current) => {
          if (current[tabId] === snapshot.data) {
            return current;
          }
          return { ...current, [tabId]: snapshot.data };
        });
        setSnapshotError(null);
      } catch {
        if (abortController.signal.aborted) return;
        setSnapshotError(
          tRef.current("browserworkspace.SnapshotFailed", {
            defaultValue: "Preview couldn’t refresh. Retrying automatically.",
          }),
        );
      } finally {
        lifecycleSignal.removeEventListener("abort", abortForLifecycle);
        if (snapshotAbortControllerRef.current === abortController) {
          snapshotAbortControllerRef.current = null;
        }
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
    overlayOpen: switcherOpen,
    occlusionSelector: BROWSER_WORKSPACE_TAB_MASK_SELECTORS,
    policy: BROWSER_NATIVE_SURFACE_POLICY,
    lifecycle: BROWSER_SURFACE_MANIFEST.lifecycle,
    onNavigation: ({ tabId, url, previousUrl }) => {
      setWorkspace((previous) => {
        const tab = previous.tabs.find((entry) => entry.id === tabId);
        // Do not let a late native observation replace a newer address-bar
        // command that React has not yet sent across the native bridge.
        if (!tab || tab.url === url || tab.url !== previousUrl) return previous;
        return {
          ...previous,
          tabs: previous.tabs.map((entry) =>
            entry.id === tabId
              ? { ...entry, url, updatedAt: new Date().toISOString() }
              : entry,
          ),
        };
      });
    },
  });
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
      // A changed URL is reconciled through tab state. Repeating the current
      // URL must explicitly reload: unchanged state cannot retry a failed page.
      if (browserTabRenderPath === "native-mobile-webview") {
        if (selectedTab?.url === url) {
          nativeTabSurfaces.reloadSurface(selectedTabId);
          setLocationInput(url);
          setLocationDirty(false);
          return;
        }
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
      nativeTabSurfaces.reloadSurface,
      openNewBrowserWorkspaceTab,
      selectedTab,
      selectedTabId,
      t,
      workspace.mode,
    ],
  );
  // Remote browser actions mutate the server workspace. Native mobile tabs are
  // deliberately local, so mirror the completed action's verified deep-link
  // URL into the currently mounted secure WebView instead of leaving it on the
  // previous page. The same deep link handles the first navigation on mount;
  // this listener covers subsequent actions while /browser is already active.
  useEffect(() => {
    if (!browserWorkspaceUsesLocalTabs) return;
    const handleAgentBrowserNavigation = (event: Event) => {
      const detail = (event as CustomEvent<NavigateViewDetail>).detail;
      if (detail?.viewId !== "browser" || !detail.viewPath) return;
      const query = detail.viewPath.split("?", 2)[1];
      const rawUrl = query
        ? new URLSearchParams(query).get("browse")?.trim()
        : null;
      if (!rawUrl) return;
      void runBrowserWorkspaceAction(
        "agent:navigate",
        async () => {
          await navigateSelectedBrowserWorkspaceTab(rawUrl);
        },
        t("browserworkspace.NavigationFailed", {
          defaultValue: "Couldn’t open that page.",
        }),
      );
    };
    window.addEventListener(NAVIGATE_VIEW_EVENT, handleAgentBrowserNavigation);
    return () =>
      window.removeEventListener(
        NAVIGATE_VIEW_EVENT,
        handleAgentBrowserNavigation,
      );
  }, [
    browserWorkspaceUsesLocalTabs,
    navigateSelectedBrowserWorkspaceTab,
    runBrowserWorkspaceAction,
    t,
  ]);
  const readNativePage = useCallback(
    async (selector?: string) => {
      if (!selectedTabId) throw new Error("No native Browser tab is selected.");
      return nativeTabSurfaces.readPage(selectedTabId, selector);
    },
    [selectedTabId, nativeTabSurfaces.readPage],
  );
  // Track the surface container so narrow panels fit a compact layout.
  const browserSurfaceRef = useRef<HTMLDivElement | null>(null);
  const [iframeScale, setIframeScale] = useState(1);
  useEffect(() => {
    const surface = browserSurfaceRef.current;
    if (!surface || typeof ResizeObserver === "undefined") return;
    const pokeAll = (): void => {
      // Cross-origin frames cannot inherit a mobile viewport policy from the
      // host. Give narrow panels a compact 400px layout viewport and fit it
      // into the surface, rather than clipping sites with that minimum width.
      // Grow the logical height by the same ratio so no blank strip remains.
      const width = surface.getBoundingClientRect().width;
      setIframeScale(width > 0 ? Math.min(1, width / 400) : 1);
    };
    const observer = new ResizeObserver(() => pokeAll());
    observer.observe(surface);
    pokeAll();
    return () => {
      observer.disconnect();
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
      const snapshot = await client.getBrowserWorkspace({
        signal: lifecycleAbortControllerRef.current.signal,
      });
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
    // Native mobile follows the same client-owned lifecycle as opening and
    // closing one tab. Calling the server here can only fail because no remote
    // workspace exists for these native WebViews.
    if (browserTabRenderPath === "native-mobile-webview") {
      const remainingTabs = workspace.tabs.filter((tab) =>
        isInternalBrowserWorkspaceTab(tab),
      );
      const nextId = remainingTabs[0]?.id ?? null;
      setWorkspace((current) => ({ ...current, tabs: remainingTabs }));
      setSelectedTabId(nextId);
      setLocationInput(
        remainingTabs.find((tab) => tab.id === nextId)?.url ?? "",
      );
      setLocationDirty(false);
      return;
    }
    for (const tab of closableTabs) {
      await client.closeBrowserWorkspaceTab(tab.id);
      revokeBrowserWalletFrame(tab.id);
    }
    const snapshot = await client.getBrowserWorkspace({
      signal: lifecycleAbortControllerRef.current.signal,
    });
    const nextId = snapshot.tabs[0]?.id ?? null;
    if (nextId) {
      await client.showBrowserWorkspaceTab(nextId);
    }
    setSelectedTabId(nextId);
    setLocationInput(snapshot.tabs.find((tab) => tab.id === nextId)?.url ?? "");
    setLocationDirty(false);
    await loadWorkspace({ preferTabId: nextId, silent: true });
  }, [
    browserTabRenderPath,
    loadWorkspace,
    revokeBrowserWalletFrame,
    workspace.tabs,
  ]);
  useEffect(() => {
    if (initialWorkspaceLoadStartedRef.current) return;
    initialWorkspaceLoadStartedRef.current = true;
    void loadWorkspace();
  }, [loadWorkspace]);
  useEffect(() => {
    void loadBrowserWalletState();
  }, [loadBrowserWalletState]);
  // A deterministic unavailability (missing route or a runtime without the
  // browser capability) will not change on the next tick: stop polling it
  // instead of re-requesting a known 404 every interval. Transient failures
  // stay retryable and keep polling so the workspace recovers on its own.
  const browserWorkspacePollEnabled = loadError === null || loadError.retryable;
  useIntervalWhenDocumentVisible(
    () => {
      void refreshWorkspaceInBackground();
    },
    POLL_INTERVAL_MS,
    browserWorkspacePollEnabled,
  );
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
  }, 5000);
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
      loading ||
      browserWorkspaceUnavailable
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
    browserWorkspaceUnavailable,
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
    await client.navigateBrowserWorkspaceTab(selectedTab.id, selectedTab.url);
  }, [
    armBrowserWorkspaceIframeFocusReturn,
    beginBrowserWalletFrameNavigation,
    browserTabRenderPath,
    nativeTabSurfaces,
    selectedTab,
    workspace.mode,
  ]);
  const backSelectedBrowserWorkspaceTab = useCallback(async () => {
    if (!selectedTab) return;
    if (nativeMobileTabPath) {
      await nativeTabSurfaces.backSurface(selectedTab.id);
      return;
    }
    const result = await client.fetch<{
      tab?: BrowserWorkspaceTab;
    }>("/api/browser-workspace/command", {
      method: "POST",
      body: JSON.stringify({ subaction: "back", id: selectedTab.id }),
    });
    if (result.tab) {
      setLocationInput(result.tab.url);
      setLocationDirty(false);
      await loadWorkspace({ preferTabId: result.tab.id, silent: true });
    }
  }, [selectedTab, loadWorkspace, nativeMobileTabPath, nativeTabSurfaces]);
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
  const openTabSwitcher = useCallback(() => {
    setSwitcherOpen(true);
  }, []);
  const handleTabSwitcherOpenChange = useCallback((open: boolean) => {
    setSwitcherOpen(open);
  }, []);
  const navNode = (
    <div className="flex items-center gap-0 px-0.5 py-1 md:grid md:grid-cols-[2.75rem_minmax(10rem,4fr)_repeat(3,2.75rem)_minmax(10rem,5fr)_repeat(2,2.75rem)] md:gap-x-2 md:gap-y-1 md:px-2 md:py-0.5">
      <TooltipHint
        content={t("browserworkspace.Back", {
          defaultValue: "Back",
        })}
      >
        <BrowserNavButton
          agentId="back"
          agentLabel="Back"
          agentDescription="Go back in the active browser tab"
          group="browser-nav"
          onActivate={() =>
            void runBrowserWorkspaceAction(
              "navigate:back",
              backSelectedBrowserWorkspaceTab,
            )
          }
          onClick={() =>
            void runBrowserWorkspaceAction(
              "navigate:back",
              backSelectedBrowserWorkspaceTab,
            )
          }
          aria-label={t("browserworkspace.Back", { defaultValue: "Back" })}
          disabled={!selectedTab || busyAction !== null}
          variant="ghost"
          size="icon"
          className="size-11 shrink-0"
        >
          <ArrowLeft className="size-4" aria-hidden />
        </BrowserNavButton>
      </TooltipHint>
      {/* Folded tabs (#13596): one compact count control opens the switcher —
            no permanent tab strip. It names the active tab so the user always
            knows which page is live even with the rest folded away. */}
      <BrowserTabFoldControl
        activeLabel={foldControlActiveLabel}
        count={foldedTabs.count}
        openLabel={openTabSwitcherLabel}
        onOpen={openTabSwitcher}
        controlRef={switcherReturnFocusRef}
      />
      <span className="max-md:hidden">
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
          className="size-11 shrink-0"
          aria-label={newTabLabel}
          disabled={busyAction !== null || browserWorkspaceUnavailable}
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
          <Plus className="size-4" />
        </BrowserNavButton>
      </span>
      <span className="max-md:hidden">
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
          className="size-11"
          aria-label={t("common.refresh", { defaultValue: "Refresh" })}
          disabled={!selectedTab || busyAction !== null}
          onClick={() =>
            void runBrowserWorkspaceAction("reload:selected", async () => {
              await reloadSelectedBrowserWorkspaceTab();
            })
          }
        >
          <RefreshCw className="size-4" />
        </BrowserNavButton>
      </span>
      <span className="max-md:hidden">
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
          className="size-11"
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
          <X className="size-4" />
        </BrowserNavButton>
      </span>
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
        disabled={
          busyAction !== null ||
          selectedTabIsInternal ||
          browserWorkspaceUnavailable
        }
        className="h-11 min-w-0 flex-1 rounded-full border-border/70 bg-bg/80 px-3 text-sm text-txt md:col-span-1 md:min-w-[10rem] md:px-4"
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
        variant="ghost"
        size="icon"
        className="hidden size-11 shrink-0 md:inline-flex"
        aria-label={goLabel}
        disabled={
          busyAction !== null ||
          selectedTabIsInternal ||
          browserWorkspaceUnavailable ||
          locationInput.trim().length === 0
        }
        onClick={() =>
          void runBrowserWorkspaceAction("navigate:click", async () => {
            await navigateSelectedBrowserWorkspaceTab(locationInput);
          })
        }
      >
        <ArrowRight className="size-4" aria-hidden />
      </BrowserNavButton>
      <span className="max-md:hidden">
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
          className="size-11"
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
          <ExternalLink className="size-4" />
        </BrowserNavButton>
      </span>
      {/* Mobile overflow (#29261): the toolbar stays one 44px row, so the
          secondary actions live behind one touch-sized menu instead of a
          second row. */}
      <span className="shrink-0 max-md:inline-flex md:hidden">
        <DropdownMenu
          open={mobileActionsOpen}
          onOpenChange={(open) => {
            const activeElement = document.activeElement;
            const menu = mobileActionsMenuRef.current;
            if (
              !open &&
              document.hasFocus() &&
              menu?.dataset.state === "open" &&
              activeElement instanceof HTMLIFrameElement &&
              [...iframeRefs.current.values()].includes(activeElement)
            ) {
              // Radix closes menus on window blur, including child-frame focus.
              // Keep this modal open and restore its focus after that transfer.
              queueMicrotask(() => {
                if (
                  mobileActionsMenuRef.current !== menu ||
                  !menu.isConnected ||
                  menu.dataset.state !== "open"
                )
                  return;
                const previous = mobileActionsFocusRef.current;
                const target =
                  previous && menu.contains(previous) ? previous : menu;
                target.focus({ preventScroll: true });
              });
              return;
            }
            setMobileActionsOpen(open);
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 shrink-0"
              aria-label={t("browserworkspace.MoreActions", {
                defaultValue: "More browser actions",
              })}
              data-testid="browser-workspace-mobile-more"
            >
              <EllipsisVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            ref={mobileActionsMenuRef}
            align="end"
            className="min-w-52 md:hidden"
            onFocusCapture={(event) => {
              if (event.target instanceof HTMLElement) {
                mobileActionsFocusRef.current = event.target;
              }
            }}
            onEscapeKeyDown={dismissMobileActions}
            onPointerDownOutside={dismissMobileActions}
          >
            <DropdownMenuItem
              className="min-h-12 gap-3"
              disabled={busyAction !== null || browserWorkspaceUnavailable}
              onSelect={() =>
                void runBrowserWorkspaceAction("open:new", async () => {
                  await openNewBrowserWorkspaceTab(
                    newBrowserWorkspaceTabSeedUrl,
                    "user",
                  );
                })
              }
            >
              <Plus className="size-4" />
              {newTabLabel}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-12 gap-3"
              disabled={!selectedTab || busyAction !== null}
              onSelect={() =>
                void runBrowserWorkspaceAction("reload:selected", async () => {
                  await reloadSelectedBrowserWorkspaceTab();
                })
              }
            >
              <RefreshCw className="size-4" />
              {t("common.refresh", { defaultValue: "Refresh" })}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-12 gap-3"
              disabled={
                busyAction !== null ||
                !workspace.tabs.some(
                  (tab) => !isInternalBrowserWorkspaceTab(tab),
                )
              }
              onSelect={() =>
                void runBrowserWorkspaceAction("close:all", async () => {
                  await closeAllBrowserWorkspaceTabs();
                })
              }
            >
              <X className="size-4" />
              {t("browserworkspace.CloseAllTabs", {
                defaultValue: "Close all tabs",
              })}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-12 gap-3"
              disabled={!selectedTab || busyAction !== null}
              onSelect={() =>
                void runBrowserWorkspaceAction("open:external", async () => {
                  if (!selectedTab) return;
                  await openExternalUrl(selectedTab.url);
                })
              }
            >
              <ExternalLink className="size-4" />
              {t("browserworkspace.OpenExternal", {
                defaultValue: "Open external",
              })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
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
            className="inline-block size-1.5 animate-pulse rounded-full bg-accent "
          />
          <span className="truncate">{watchBannerLabel}</span>
        </div>
      ) : null}
      {loadError &&
      !browserWorkspaceUsesLocalTabs &&
      workspace.tabs.length > 0 ? (
        <div
          className="absolute left-4 right-4 top-3 z-20 rounded-xl border border-warning/30 bg-bg/95 px-3 py-2 text-xs text-muted md:left-1/2 md:right-auto md:w-max md:max-w-[min(32rem,calc(100%-2rem))] md:-translate-x-1/2"
          role="alert"
        >
          {loadError.message}
        </div>
      ) : null}

      {workspace.tabs.length === 0 ? (
        browserWorkspaceUnavailable ? (
          <PagePanel.ContentState
            state="error"
            placement="workspace"
            role="alert"
            tone="warning"
            aria-busy={browserWorkspaceCanRetryLoad && loading}
            icon={<Globe className="size-5" aria-hidden />}
            title={t("browserworkspace.NativeSurfaceUnavailable", {
              defaultValue: "Browser view unavailable",
            })}
            description={loadError.message}
            action={
              browserWorkspaceCanRetryLoad ? (
                <Button
                  type="button"
                  size="touch"
                  variant="outline"
                  disabled={loading || busyAction !== null}
                  onClick={() => void loadWorkspace()}
                >
                  <RefreshCw
                    className={`size-4 ${loading ? "animate-spin" : ""}`}
                    aria-hidden
                  />
                  {t("common.retry", { defaultValue: "Retry" })}
                </Button>
              ) : undefined
            }
          />
        ) : loading ? (
          <PagePanel.ContentState
            state="loading"
            placement="workspace"
            aria-busy
            heading={t("browserworkspace.Loading", {
              defaultValue: "Opening Browser",
            })}
          />
        ) : (
          <PagePanel.ContentState
            state="empty"
            placement="workspace"
            icon={<Globe className="size-5" aria-hidden />}
            title={t("browserworkspace.EmptyTitle", {
              defaultValue: "No page open",
            })}
          />
        )
      ) : browserTabRenderPath === "native-mobile-webview" ? (
        nativeTabSurfaces.error ? (
          <PagePanel.ContentState
            state="error"
            placement="workspace"
            role="alert"
            data-native-surface-error-key={nativeTabSurfaces.error.key}
            data-native-surface-error-message={nativeTabSurfaces.error.message}
            tone="warning"
            className="absolute inset-0 bg-bg"
            title={
              nativeTabSurfaces.error.permanent
                ? t("browserworkspace.NativeSurfaceUnsupported", {
                    defaultValue: "Secure browsing not supported here",
                  })
                : t("browserworkspace.NativeSurfaceUnavailable", {
                    defaultValue: "Browser view unavailable",
                  })
            }
            description={
              nativeTabSurfaces.error.permanent
                ? t("browserworkspace.NativeSurfaceUnsupportedDescription", {
                    defaultValue:
                      "This device can’t keep in-app browsing isolated. Open the page in your browser instead.",
                  })
                : t("browserworkspace.NativeSurfaceUnavailableDescription", {
                    defaultValue:
                      "The secure browser couldn’t connect. Try again without losing your tabs.",
                  })
            }
            action={
              nativeTabSurfaces.error.permanent ? (
                selectedTab ? (
                  <Button
                    type="button"
                    size="touch"
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
                    <ExternalLink className="size-4" />
                    {t("browserworkspace.OpenExternal", {
                      defaultValue: "Open external",
                    })}
                  </Button>
                ) : null
              ) : (
                <Button
                  type="button"
                  size="touch"
                  variant="outline"
                  onClick={nativeTabSurfaces.retry}
                >
                  {t("common.retry", { defaultValue: "Retry" })}
                </Button>
              )
            }
          />
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
              <PagePanel.ContentState
                key={tab.id}
                state="error"
                placement="workspace"
                tone="warning"
                className={`absolute inset-0 bg-bg transition-opacity ${visibilityClass}`}
                title={t("browserworkspace.FrameBlockedTitle", {
                  defaultValue: "Open this site in your browser",
                })}
                description={t("browserworkspace.FrameBlockedDescription", {
                  defaultValue: "This site doesn’t allow in-app viewing.",
                })}
                action={
                  <Button
                    type="button"
                    size="touch"
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
                    <ExternalLink className="size-4" />
                    {t("browserworkspace.OpenExternal", {
                      defaultValue: "Open external",
                    })}
                  </Button>
                }
              />
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
              style={{
                colorScheme: uiTheme,
                width: `${100 / iframeScale}%`,
                height: `${100 / iframeScale}%`,
                transform: `scale(${iframeScale})`,
                transformOrigin: "top left",
              }}
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
          <div className="flex min-h-11 items-center gap-2 border-b border-border/70 px-4 text-xs text-muted">
            <span className="font-medium text-txt">
              {t("browserworkspace.CloudSession", {
                defaultValue: "Cloud session",
              })}
            </span>
            {selectedTab?.status ? (
              <span className="truncate">{selectedTab.status}</span>
            ) : null}
            {selectedTabLiveViewUrl ? (
              <Button
                variant="surface"
                size="tiny"
                className="ml-auto"
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
                className="absolute left-4 right-4 top-3 z-20 rounded-xl border border-warning/30 bg-bg/95 px-3 py-2 text-xs text-muted"
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
                width={1280}
                height={720}
                className="h-full w-full object-contain"
              />
            ) : (
              <PagePanel.ContentState
                state="loading"
                placement="workspace"
                heading={t("browserworkspace.SessionPreviewPending", {
                  defaultValue: "Preparing preview",
                })}
              />
            )}
          </div>

          {selectedTab ? (
            <div className="border-t border-border/70 px-4 py-2 text-xs text-muted">
              <div className="truncate font-medium text-txt">
                {getBrowserWorkspaceTabLabel(selectedTab, t)}
              </div>
              <div className="truncate">{selectedTab.url}</div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
  // The fullscreen view owns one flat navigation rail and one content surface.
  // Compact layouts keep a 16px canvas inset and fold secondary actions away;
  // every remaining control still meets the 44px touch floor.
  const showMinimalToolbar =
    workspace.tabs.length === 0 && (loading || browserWorkspaceUnavailable);
  const mainNode = (
    <main
      ref={workspaceRootRef}
      aria-label={t("browserworkspace.ViewTitle", { defaultValue: "Browser" })}
      data-testid="browser-workspace-view"
      data-chat-clearance-aware="true"
      aria-busy={loading || busyAction !== null}
      tabIndex={-1}
      className="relative flex h-full min-h-0 w-full min-w-0 flex-col gap-3 overflow-hidden bg-bg px-4 pt-[calc(var(--safe-area-top,0px)+0.75rem)] pb-[calc(1rem+var(--eliza-chat-clearance,5.25rem))] lg:px-6 lg:pt-[calc(var(--safe-area-top,0px)+1.5rem)] lg:pb-[calc(1.5rem+var(--eliza-chat-clearance,5.25rem))]"
    >
      {!showMinimalToolbar && (
        <div
          data-testid="browser-workspace-toolbar"
          className="shrink-0 overflow-hidden rounded-2xl border border-border bg-card"
        >
          {navNode}
        </div>
      )}
      <div
        data-testid="browser-workspace-surface-panel"
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card"
      >
        {browserSurface}
      </div>
    </main>
  );
  return (
    <ShellViewAgentSurface
      viewId="browser"
      readPage={nativeMobileTabPath ? readNativePage : undefined}
    >
      {mainNode}
      <BrowserTabSwitcher
        open={switcherOpen}
        onOpenChange={handleTabSwitcherOpenChange}
        folded={foldedTabs}
        activeTabId={selectedTabId}
        title={tabsLabel}
        closeLabel={closeTabLabel}
        agentActiveLabel={agentActiveLabel}
        newTabLabel={newTabLabel}
        emptyLabel={t("browserworkspace.NoTabsYet", {
          defaultValue: "No tabs open yet",
        })}
        returnFocusRef={switcherReturnFocusRef}
        actionsDisabled={busyAction !== null || browserWorkspaceUnavailable}
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
    </ShellViewAgentSurface>
  );
}
