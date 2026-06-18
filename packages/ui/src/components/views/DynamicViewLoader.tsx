/**
 * DynamicViewLoader — loads a view bundle from a remote URL at runtime.
 *
 * Each view lives behind a React.lazy boundary so it is only fetched when
 * first navigated to, and an ErrorBoundary wrapper prevents a failing view
 * from crashing the shell.
 *
 * Loaded modules are cached by bundleUrl so re-mounting does not re-fetch.
 *
 * On iOS App Store and Google Play builds, dynamic remote JS loading is
 * prohibited by platform policy. The loader detects this and renders a
 * static fallback instead of attempting to import the bundle.
 *
 * When a view module exports an `interact(capability, params)` function, the
 * loader registers it with view-interact-registry so the agent can invoke
 * capabilities via POST /api/views/:id/interact → WS → here → WS result.
 * Standard capabilities (get-text, get-state, refresh, focus-element,
 * click-element, fill-input) are handled by the loader itself even when the
 * module has no interact export.
 */

import { resolveAppBranding } from "@elizaos/shared";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  LoaderCircle,
  RotateCw,
} from "lucide-react";
import {
  type ComponentType,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import * as AgentSurfaceHost from "../../agent-surface";
import {
  AgentElementOverlay,
  AgentSurfaceElementReporter,
  AgentSurfaceProvider,
  getViewRegistry,
  handleAgentSurfaceCapability,
  isAgentSurfaceCapability,
  type ViewAgentRegistry,
} from "../../agent-surface";
import { client } from "../../api/index.ts";
import { isDynamicViewLoadingAllowed } from "../../platform/platform-guards";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { useApp } from "../../state/useApp.ts";
import { registerDetailExtension } from "../apps/extensions/registry.ts";
import {
  formatDetailTimestamp,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
} from "../apps/extensions/surface.helpers.ts";
import {
  SurfaceBadge,
  SurfaceCard,
  SurfaceEmptyState,
  SurfaceGrid,
  SurfaceSection,
} from "../apps/extensions/surface.tsx";
import { registerOverlayApp } from "../apps/overlay-app-registry.ts";
import { GameOperatorShell } from "../apps/surfaces/GameOperatorShell.tsx";
import { registerOperatorSurface } from "../apps/surfaces/registry.ts";
import { PagePanel } from "../composites/page-panel/index.ts";
import { Button } from "../ui/button.tsx";
import { ErrorBoundary } from "../ui/error-boundary";
import { Input } from "../ui/input.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { registerViewInteractHandler } from "./view-interact-registry";

interface ViewBundleModule {
  component: ComponentType<Record<string, unknown>>;
  interact?: (
    capability: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>;
  cleanup?: () => void | Promise<void>;
}

// Module cache lives outside React so it persists across re-renders and
// component unmounts.
const bundleModuleCache = new Map<string, Promise<ViewBundleModule>>();

function isReactComponentExport(
  value: unknown,
): value is ComponentType<Record<string, unknown>> {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}

type HostExternalImporter = () => Promise<Record<string, unknown>>;

const APP_CORE_VIEW_COMPAT: Record<string, unknown> = {
  client,
  resolveAppBranding,
  Button,
  Input,
  Spinner,
  PagePanel,
  GameOperatorShell,
  registerDetailExtension,
  registerOverlayApp,
  registerOperatorSurface,
  useApp,
  SurfaceBadge,
  SurfaceCard,
  SurfaceEmptyState,
  SurfaceGrid,
  SurfaceSection,
  formatDetailTimestamp,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
};

async function importAppCoreViewCompat(): Promise<Record<string, unknown>> {
  return APP_CORE_VIEW_COMPAT;
}

const HOST_EXTERNAL_IMPORTERS: Record<string, HostExternalImporter> = {
  "@elizaos/app-core": importAppCoreViewCompat,
  "@elizaos/app-core/browser": importAppCoreViewCompat,
  "@elizaos/app-core/ui-compat": importAppCoreViewCompat,
  "@elizaos/capacitor-contacts": () => import("@elizaos/capacitor-contacts"),
  "@elizaos/capacitor-messages": () => import("@elizaos/capacitor-messages"),
  "@elizaos/capacitor-mobile-signals": () =>
    import("@elizaos/capacitor-mobile-signals"),
  "@elizaos/capacitor-phone": () => import("@elizaos/capacitor-phone"),
  "@elizaos/capacitor-system": () => import("@elizaos/capacitor-system"),
  "@elizaos/shared": () => import("@elizaos/shared"),
  "@elizaos/ui": () => import("@elizaos/ui"),
  "@elizaos/plugin-browser": () => import("@elizaos/plugin-browser"),
  "@elizaos/plugin-health/screen-time/mobile-signal-setup": () =>
    import("@elizaos/plugin-health/screen-time/mobile-signal-setup"),
  "@elizaos/plugin-training": () => import("@elizaos/plugin-training"),
  "@elizaos/ui/agent-surface": async () => AgentSurfaceHost,
  "@elizaos/ui/app-navigate-view": () => import("../../app-navigate-view.ts"),
  "@elizaos/ui/api": () => import("../../api/index.ts"),
  "@elizaos/ui/bridge": () => import("../../bridge/index.ts"),
  "@elizaos/ui/components": () => import("../index.ts"),
  "@elizaos/ui/config": () => import("../../config/index.ts"),
  "@elizaos/ui/events": () => import("../../events/index.ts"),
  "@elizaos/ui/hooks": () => import("../../hooks/index.ts"),
  "@elizaos/ui/layouts": () => import("../../layouts/index.ts"),
  "@elizaos/ui/platform": () => import("../../platform/index.ts"),
  "@elizaos/ui/platform/ios-runtime": () =>
    import("../../platform/ios-runtime.ts"),
  "@elizaos/ui/state": () => import("../../state/index.ts"),
  "@elizaos/ui/state/useApp": () => import("../../state/useApp.ts"),
  "@elizaos/ui/utils": () => import("../../utils/index.ts"),
  "@elizaos/ui/components/composites/page-panel": () =>
    import("../composites/page-panel/index.ts"),
  "@elizaos/ui/components/composites/sidebar/sidebar-content": () =>
    import("../composites/sidebar/sidebar-content.tsx"),
  "@elizaos/ui/components/composites/sidebar/sidebar-panel": () =>
    import("../composites/sidebar/sidebar-panel.tsx"),
  "@elizaos/ui/components/composites/sidebar/sidebar-scroll-region": () =>
    import("../composites/sidebar/sidebar-scroll-region.tsx"),
  "@elizaos/ui/components/pages/MemoryDetailPanel": () =>
    import("../pages/MemoryDetailPanel.tsx"),
  "@elizaos/ui/components/pages/vector-browser-utils": () =>
    import("../pages/vector-browser-utils.ts"),
  "@elizaos/ui/components/shared/AppPageSidebar": () =>
    import("../shared/AppPageSidebar.tsx"),
  "@elizaos/ui/components/views/TerminalPluginView": () =>
    import("./TerminalPluginView.tsx"),
  "@elizaos/ui/components/ui/button": () => import("../ui/button.tsx"),
  "@elizaos/ui/components/ui/input": () => import("../ui/input.tsx"),
  "@elizaos/ui/components/ui/select": () => import("../ui/select.tsx"),
  "@elizaos/ui/components/ui/settings-controls": () =>
    import("../ui/settings-controls.tsx"),
  "@elizaos/ui/components/ui/spinner": () => import("../ui/spinner.tsx"),
  "@elizaos/ui/components/ui/skeleton-layouts": () =>
    import("../ui/skeleton-layouts.tsx"),
  "@elizaos/ui/components/ui/tabs": () => import("../ui/tabs.tsx"),
  "@elizaos/ui/components/ui/textarea": () => import("../ui/textarea.tsx"),
  "@elizaos/ui/components/ui/tooltip-extended": () =>
    import("../ui/tooltip-extended.tsx"),
  "@elizaos/ui/components/apps/surfaces/GameOperatorShell": () =>
    import("../apps/surfaces/GameOperatorShell.tsx"),
  "lucide-react": () => import("lucide-react"),
  "@pixiv/three-vrm": () => import("@pixiv/three-vrm"),
  "@pixiv/three-vrm/nodes": () => import("@pixiv/three-vrm/nodes"),
  react: () => import("react"),
  "react-plaid-link": () => import("react-plaid-link"),
  "react/jsx-dev-runtime": async () => {
    const devRuntime = await import("react/jsx-dev-runtime");
    if (typeof devRuntime.jsxDEV === "function") {
      return devRuntime;
    }
    const runtime = await import("react/jsx-runtime");
    return { ...runtime, jsxDEV: runtime.jsx };
  },
  "react/jsx-runtime": () => import("react/jsx-runtime"),
  three: () => import("three"),
  "three/tsl": () => import("three/tsl"),
  "three/webgpu": () => import("three/webgpu"),
  "three/examples/jsm/controls/OrbitControls.js": () =>
    import("three/examples/jsm/controls/OrbitControls.js"),
  "three/examples/jsm/libs/meshopt_decoder.module.js": () =>
    import("three/examples/jsm/libs/meshopt_decoder.module.js"),
  "three/examples/jsm/loaders/DRACOLoader.js": () =>
    import("three/examples/jsm/loaders/DRACOLoader.js"),
  "three/examples/jsm/loaders/FBXLoader.js": () =>
    import("three/examples/jsm/loaders/FBXLoader.js"),
  "three/examples/jsm/loaders/GLTFLoader.js": () =>
    import("three/examples/jsm/loaders/GLTFLoader.js"),
};

const HOST_EXTERNAL_IMPORTER_SPECIFIERS = Object.keys(HOST_EXTERNAL_IMPORTERS);

declare global {
  interface Window {
    __ELIZA_DYNAMIC_VIEW_IMPORT__?: (
      specifier: string,
    ) => Promise<Record<string, unknown>>;
    __ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__?: (
      bundleUrl: string,
    ) => Promise<Record<string, unknown>>;
  }
}

if (typeof window !== "undefined" && !window.__ELIZA_DYNAMIC_VIEW_IMPORT__) {
  window.__ELIZA_DYNAMIC_VIEW_IMPORT__ = async (specifier) => {
    const importer = HOST_EXTERNAL_IMPORTERS[specifier];
    if (!importer) {
      throw new Error(
        `DynamicViewLoader: unsupported host external "${specifier}"`,
      );
    }
    return importer();
  };
}

/** Dev-mode polling interval in ms. Not used in production builds. */
const DEV_POLL_INTERVAL_MS = 2000;

async function importViewBundle(
  bundleUrl: string,
): Promise<Record<string, unknown>> {
  if (
    typeof window !== "undefined" &&
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__
  ) {
    return window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__(bundleUrl);
  }

  const hostExternalUrl = buildHostExternalBundleUrl(bundleUrl);
  if (hostExternalUrl) {
    return import(/* @vite-ignore */ hostExternalUrl);
  }

  try {
    return await import(/* @vite-ignore */ bundleUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("Failed to resolve module specifier")) {
      throw err;
    }
  }

  const rewrittenUrl = buildHostExternalBundleUrl(bundleUrl);
  if (!rewrittenUrl) {
    throw new Error(
      `DynamicViewLoader: bundle at ${bundleUrl} could not use host externals`,
    );
  }
  return import(/* @vite-ignore */ rewrittenUrl);
}

function buildHostExternalBundleUrl(bundleUrl: string): string | null {
  if (typeof window === "undefined") return null;
  const rewrittenUrl = new URL(bundleUrl, window.location.href);
  if (rewrittenUrl.origin !== window.location.origin) return null;
  if (!rewrittenUrl.pathname.startsWith("/api/views/")) return null;
  rewrittenUrl.searchParams.set("hostExternalRuntime", "1");
  rewrittenUrl.searchParams.set(
    "hostExternalSpecifiers",
    HOST_EXTERNAL_IMPORTER_SPECIFIERS.join(","),
  );
  return rewrittenUrl.href;
}

function loadBundleModule(
  bundleUrl: string,
  componentExport: string,
): Promise<ViewBundleModule> {
  const cacheKey = `${bundleUrl}::${componentExport}`;
  const cached = bundleModuleCache.get(cacheKey);
  if (cached) return cached;

  const promise = importViewBundle(bundleUrl).then(
    (mod: Record<string, unknown>) => {
      const exported = mod[componentExport] ?? mod.default;
      if (!isReactComponentExport(exported)) {
        throw new Error(
          `DynamicViewLoader: bundle at ${bundleUrl} did not export a React component as "${componentExport}"`,
        );
      }
      const interact =
        typeof mod.interact === "function"
          ? (mod.interact as ViewBundleModule["interact"])
          : undefined;
      const cleanup =
        typeof mod.cleanup === "function" ? mod.cleanup : undefined;
      return {
        component: exported as ComponentType<Record<string, unknown>>,
        interact,
        cleanup: cleanup as ViewBundleModule["cleanup"],
      };
    },
  );

  bundleModuleCache.set(cacheKey, promise);
  return promise;
}

const STANDARD_CAPABILITIES = new Set([
  "get-state",
  "refresh",
  "focus-element",
  "click-element",
  "fill-input",
  "get-text",
]);

const DOM_FILLABLE_AGENT_ROLES = new Set([
  "text-input",
  "number-input",
  "textarea",
  "select",
  "slider",
]);

const DOM_CLICKABLE_AGENT_ROLES = new Set([
  "button",
  "link",
  "toggle",
  "tab",
  "menu-item",
  "list-item",
  "card",
]);

function resolveInteractTarget(
  containerEl: HTMLElement | null,
  params: Record<string, unknown> | undefined,
): { target: HTMLElement | null; selector: string | null } {
  const selector =
    typeof params?.selector === "string" ? params.selector : null;
  const name = typeof params?.name === "string" ? params.name : null;
  const target =
    (selector && containerEl?.querySelector<HTMLElement>(selector)) ||
    (name &&
      containerEl?.querySelector<HTMLElement>(
        `[name="${CSS.escape(name)}"]`,
      )) ||
    null;
  return { target, selector: selector ?? name };
}

function setNativeInputValue(
  target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : target instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(target, value);
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
}

function agentSelector(id: string): string {
  return `[data-agent-id="${CSS.escape(id)}"]`;
}

function getAgentElementById(
  containerEl: HTMLElement | null,
  id: string,
): HTMLElement | null {
  return containerEl?.querySelector<HTMLElement>(agentSelector(id)) ?? null;
}

function readElementValue(el: HTMLElement): unknown {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      return el.checked;
    }
    return el.value;
  }
  return undefined;
}

function snapshotDomAgentElement(el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  const role = el.getAttribute("data-agent-role") || "region";
  return {
    id: el.getAttribute("data-agent-id") || "",
    role,
    label: el.getAttribute("data-agent-label") || "",
    status: el.getAttribute("data-state") || undefined,
    value: readElementValue(el),
    fillable: DOM_FILLABLE_AGENT_ROLES.has(role),
    clickable: DOM_CLICKABLE_AGENT_ROLES.has(role),
    focused:
      typeof document !== "undefined" &&
      (document.activeElement === el || el.contains(document.activeElement)),
    visible: rect.width > 0 && rect.height > 0,
    bounds: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

function listDomAgentElements(containerEl: HTMLElement | null) {
  if (!containerEl) return [];
  return [...containerEl.querySelectorAll<HTMLElement>("[data-agent-id]")]
    .map(snapshotDomAgentElement)
    .filter((item) => item.id.length > 0);
}

function handleDomAgentSurfaceCapability(
  viewId: string,
  viewType: "gui" | "tui" | "xr",
  capability: string,
  params: Record<string, unknown> | undefined,
  containerEl: HTMLElement | null,
): unknown {
  switch (capability) {
    case "list-elements": {
      const role = typeof params?.role === "string" ? params.role : null;
      const elements = listDomAgentElements(containerEl);
      return role ? elements.filter((item) => item.role === role) : elements;
    }

    case "get-agent-state": {
      const elements = listDomAgentElements(containerEl);
      const focused = elements.find((item) => item.focused)?.id ?? null;
      return {
        viewId,
        viewType,
        elementCount: elements.length,
        focusedId: focused,
        elements,
        updatedAt: Date.now(),
      };
    }

    case "describe-element": {
      const id = agentIdParam(params);
      if (!id) throw new Error("describe-element requires an `id` parameter");
      const el = getAgentElementById(containerEl, id);
      if (!el) throw new Error(`No element registered with id "${id}"`);
      return snapshotDomAgentElement(el);
    }

    case "get-focus": {
      const elements = listDomAgentElements(containerEl);
      const element = elements.find((item) => item.focused) ?? null;
      return { focusedId: element?.id ?? null, element };
    }

    case "agent-focus": {
      const id = agentIdParam(params);
      if (!id) throw new Error("agent-focus requires an `id` parameter");
      const el = getAgentElementById(containerEl, id);
      if (!el) return { ok: false, id, reason: "element not found" };
      el.focus();
      return { ok: true, id };
    }

    case "agent-click": {
      const id = agentIdParam(params);
      if (!id) throw new Error("agent-click requires an `id` parameter");
      const el = getAgentElementById(containerEl, id);
      if (!el) return { ok: false, id, reason: "element not found" };
      el.click();
      return { ok: true, id };
    }

    case "agent-fill": {
      const id = agentIdParam(params);
      const value = typeof params?.value === "string" ? params.value : null;
      if (!id) throw new Error("agent-fill requires an `id` parameter");
      if (value === null) {
        throw new Error("agent-fill requires a string `value` parameter");
      }
      const el = getAgentElementById(containerEl, id);
      if (!el) return { ok: false, id, reason: "element not found" };
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) {
        setNativeInputValue(el, value);
        return { ok: true, id, value };
      }
      return { ok: false, id, reason: "element is not a native field" };
    }

    case "agent-scroll-to": {
      const id = agentIdParam(params);
      if (!id) throw new Error("agent-scroll-to requires an `id` parameter");
      const el = getAgentElementById(containerEl, id);
      if (!el) return { ok: false, id, reason: "element not found" };
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return { ok: true, id };
    }

    case "set-highlight":
      return { highlighting: false };

    default:
      throw new Error(`Unknown agent-surface capability "${capability}"`);
  }
}

/**
 * Handle a standard capability on the view container element.
 * Called when a view module does not export an `interact` function, or when
 * the capability is a known standard one (ensuring baseline support).
 */
function agentIdParam(
  params: Record<string, unknown> | undefined,
): string | null {
  const id = params?.agentId ?? params?.id;
  return typeof id === "string" ? id : null;
}

async function handleStandardCapability(
  capability: string,
  params: Record<string, unknown> | undefined,
  containerEl: HTMLElement | null,
  setReloadKey: (fn: (k: number) => number) => void,
  cacheKey: string,
  registry: ViewAgentRegistry | undefined,
): Promise<unknown> {
  switch (capability) {
    case "get-text":
      return containerEl?.innerText ?? "";

    case "get-state": {
      // Prefer the agent-surface snapshot when the view registers elements; it
      // supersedes the legacy manual `[data-view-state]` attribute.
      if (registry && registry.size() > 0) {
        return registry.snapshot();
      }
      const stateEl = containerEl?.querySelector("[data-view-state]");
      if (stateEl) {
        try {
          return JSON.parse(stateEl.getAttribute("data-view-state") ?? "{}");
        } catch {
          return {};
        }
      }
      return {};
    }

    case "refresh":
      bundleModuleCache.delete(cacheKey);
      setReloadKey((k) => k + 1);
      return { refreshed: true };

    case "focus-element": {
      // Addressing by registered agent id takes precedence over raw selectors.
      const id = agentIdParam(params);
      if (id && registry) {
        const result = registry.focus(id);
        return { focused: result.ok, id, reason: result.reason };
      }
      const { target, selector } = resolveInteractTarget(containerEl, params);
      if (target) {
        target.focus();
        return { focused: true, selector };
      }
      return { focused: false, reason: "element not found" };
    }

    case "click-element": {
      const id = agentIdParam(params);
      if (id && registry) {
        const result = registry.click(id);
        return { clicked: result.ok, id, reason: result.reason };
      }
      const { target, selector } = resolveInteractTarget(containerEl, params);
      if (target) {
        target.click();
        return { clicked: true, selector };
      }
      return { clicked: false, reason: "element not found" };
    }

    case "fill-input": {
      const value = typeof params?.value === "string" ? params.value : null;
      if (value === null) {
        return { filled: false, reason: "value must be a string" };
      }
      const id = agentIdParam(params);
      if (id && registry) {
        const result = registry.fill(id, value);
        return { filled: result.ok, id, reason: result.reason, value };
      }
      const { target, selector } = resolveInteractTarget(containerEl, params);
      if (!target) {
        return { filled: false, reason: "element not found" };
      }
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        setNativeInputValue(target, value);
        return { filled: true, selector, value };
      }
      return { filled: false, reason: "element is not fillable" };
    }

    default:
      throw new Error(`Unknown standard capability "${capability}"`);
  }
}

/**
 * Navigate back to the view launcher (`/views`). Hoisted so the error/crash
 * recovery surfaces can offer a "Back to views" escape hatch without depending
 * on the view itself having wired the `exitToApps` prop.
 */
function navigateToViews() {
  if (typeof window !== "undefined") {
    window.history.pushState(null, "", "/views");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

function ViewStatusFrame({
  tone,
  icon,
  title,
  children,
  actions,
}: {
  tone: "loading" | "error" | "restricted";
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const toneClass =
    tone === "error"
      ? "border-destructive/25 bg-destructive/5 text-destructive"
      : tone === "restricted"
        ? "border-muted-foreground/20 bg-muted/20 text-muted-foreground"
        : "border-primary/20 bg-primary/5 text-primary";

  return (
    <div className="flex flex-1 min-h-0 min-w-0 items-center justify-center p-6">
      <div
        className={`flex w-full max-w-sm flex-col gap-3 rounded-lg border p-4 shadow-sm ${toneClass}`}
      >
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-background/70">
            {icon}
          </div>
          <div className="min-w-0 text-left">
            <div className="text-sm font-semibold">{title}</div>
            {children ? (
              <div className="mt-1 text-xs opacity-75">{children}</div>
            ) : null}
          </div>
        </div>
        {actions ? (
          <div className="flex flex-wrap gap-2 pl-[3.25rem]">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}

function ViewLoadingSkeleton() {
  const { t } = useTranslation();
  return (
    <ViewStatusFrame
      tone="loading"
      icon={
        <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
      }
      title={t("dynamicviewloader.loading", { defaultValue: "Loading view…" })}
    />
  );
}

function ViewRecoveryActions({
  onRetry,
  onBack,
}: {
  onRetry: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1 rounded-sm text-xs"
        onClick={onRetry}
      >
        <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
        {t("dynamicviewloader.retry", { defaultValue: "Retry" })}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 rounded-sm text-xs"
        onClick={onBack}
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        {t("dynamicviewloader.back", { defaultValue: "Back to views" })}
      </Button>
    </>
  );
}

function ViewErrorState({
  viewId,
  error,
  onRetry,
  onBack,
}: {
  viewId: string;
  error?: Error | null;
  onRetry?: () => void;
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ViewStatusFrame
      tone="error"
      icon={<AlertTriangle className="h-5 w-5" aria-hidden="true" />}
      title={t("dynamicviewloader.error.title", {
        defaultValue: "Failed to load view",
      })}
      actions={
        onRetry && onBack ? (
          <ViewRecoveryActions onRetry={onRetry} onBack={onBack} />
        ) : undefined
      }
    >
      <span>
        {t("dynamicviewloader.viewId", {
          viewId,
          defaultValue: "View ID: {{viewId}}",
        })}
      </span>
      {error?.message ? (
        <span className="mt-1 block break-words font-mono text-[10px] opacity-60">
          {error.message}
        </span>
      ) : null}
    </ViewStatusFrame>
  );
}

function ViewRestrictedState({ viewId }: { viewId: string }) {
  const { t } = useTranslation();
  return (
    <ViewStatusFrame
      tone="restricted"
      icon={<Ban className="h-5 w-5" aria-hidden="true" />}
      title={t("dynamicviewloader.restricted.title", {
        defaultValue: "View not available on this platform",
      })}
    >
      <span>
        {t("dynamicviewloader.restricted.body", {
          defaultValue:
            "Dynamic views cannot be loaded on iOS or Android store builds.",
        })}
      </span>
      <span className="mt-1 block">
        {t("dynamicviewloader.viewId", {
          viewId,
          defaultValue: "View ID: {{viewId}}",
        })}
      </span>
    </ViewStatusFrame>
  );
}

interface DynamicViewLoaderProps {
  /** The URL of the JS bundle to dynamically import. */
  bundleUrl: string;
  /** Named export inside the bundle to use as the root component. Defaults to "default". */
  componentExport?: string;
  /** The view's stable ID, used in error state messages. */
  viewId: string;
  /** Optional props forwarded to the loaded view root component. */
  viewProps?: Record<string, unknown>;
  /** Presentation/runtime family for this view. Defaults to GUI. */
  viewType?: "gui" | "tui" | "xr";
}

/**
 * Loads and mounts a view component from a remote bundle URL.
 *
 * Usage:
 * ```tsx
 * <DynamicViewLoader
 *   bundleUrl="/api/views/wallet.inventory/bundle.js"
 *   viewId="wallet.inventory"
 * />
 * ```
 */
export const DynamicViewLoader = memo(function DynamicViewLoader({
  bundleUrl,
  componentExport = "default",
  viewId,
  viewProps: forwardedViewProps,
  viewType = "gui",
}: DynamicViewLoaderProps) {
  const [bundle, setBundle] = useState<ViewBundleModule | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  // Incrementing this key invalidates the module cache entry and forces a
  // fresh import. Used by the dev-mode ETag poller when the bundle changes,
  // and by the `refresh` standard capability.
  const [reloadKey, setReloadKey] = useState(0);
  const dynamicLoadingAllowed = isDynamicViewLoadingAllowed();
  // Ref to the container div so standard capabilities (get-text, focus-element, get-state)
  // can query the DOM.
  const containerRef = useRef<HTMLDivElement>(null);
  // viewId is only a log label inside the load effect; held in a ref so it does
  // not become an effect dependency (a viewId change with the same bundleUrl
  // must not re-run the import or flash the loading skeleton).
  const viewIdRef = useRef(viewId);
  viewIdRef.current = viewId;

  // reloadKey is intentionally a dependency: bumping it via the
  // standard `refresh` capability or the dev-mode ETag poller must
  // re-run this effect to invalidate the module cache.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a manual cache-bust trigger
  useEffect(() => {
    if (!dynamicLoadingAllowed) return;

    let cancelled = false;
    let loadedBundle: ViewBundleModule | null = null;

    setBundle(null);
    setLoadError(null);
    void loadBundleModule(bundleUrl, componentExport)
      .then((nextBundle) => {
        loadedBundle = nextBundle;
        if (!cancelled) {
          setBundle(nextBundle);
          return;
        }
        if (nextBundle.cleanup) {
          void Promise.resolve()
            .then(() => nextBundle.cleanup?.())
            .catch(() => {});
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const error = err instanceof Error ? err : new Error(String(err));
        console.error(
          `DynamicViewLoader failed to load view "${viewIdRef.current}" from ${bundleUrl}`,
          error,
        );
        setLoadError(error);
      });

    return () => {
      cancelled = true;
      const cleanup = loadedBundle?.cleanup;
      if (cleanup) {
        void Promise.resolve()
          .then(() => cleanup())
          .catch(() => {
            // View cleanup must never crash the shell.
          });
      }
    };
  }, [bundleUrl, componentExport, dynamicLoadingAllowed, reloadKey]);

  // Register this view's interact handler whenever the bundle is loaded.
  // The handler is unregistered on unmount or when the bundle changes.
  useLayoutEffect(() => {
    if (!bundle) return;

    const unregister = registerViewInteractHandler(
      viewId,
      viewType,
      async (capability, params) => {
        const registry = getViewRegistry(viewId, viewType);
        // Generic agent-surface capabilities (list-elements, agent-fill, …)
        // operate on the view's element registry.
        if (isAgentSurfaceCapability(capability)) {
          if (registry && registry.size() > 0) {
            return handleAgentSurfaceCapability(registry, capability, params);
          }
          return handleDomAgentSurfaceCapability(
            viewId,
            viewType,
            capability,
            params,
            containerRef.current,
          );
        }
        // Standard capabilities are handled here regardless of whether the
        // module exports interact — they operate on the registry or the DOM.
        if (STANDARD_CAPABILITIES.has(capability)) {
          return handleStandardCapability(
            capability,
            params,
            containerRef.current,
            setReloadKey,
            `${bundleUrl}::${componentExport}`,
            registry,
          );
        }
        // Delegate to the module's interact export if present.
        if (bundle.interact) {
          return bundle.interact(capability, params);
        }
        throw new Error(
          `View "${viewId}" does not support capability "${capability}"`,
        );
      },
    );

    return unregister;
  }, [bundle, bundleUrl, componentExport, viewId, viewType]);

  // Dev-mode only: poll the bundle URL with HEAD requests every 2s. When the
  // ETag changes the bundle has been rebuilt — evict the cache entry and bump
  // reloadKey so the component re-imports the updated bundle.
  const lastEtagRef = useRef<string | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV || !bundleUrl || !dynamicLoadingAllowed) return;

    const cacheKey = `${bundleUrl}::${componentExport}`;

    const id = setInterval(() => {
      void fetch(bundleUrl, { method: "HEAD" })
        .then((res) => {
          const etag = res.headers.get("etag");
          if (lastEtagRef.current !== null && etag !== lastEtagRef.current) {
            // Bundle changed on disk — evict cache and trigger re-import.
            bundleModuleCache.delete(cacheKey);
            setReloadKey((k) => k + 1);
          }
          lastEtagRef.current = etag;
        })
        .catch(() => {
          // Network errors during polling are non-fatal; just wait for the next tick.
        });
    }, DEV_POLL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [bundleUrl, componentExport, dynamicLoadingAllowed]);

  // Recover from a load failure or render crash: evict the cached module so the
  // next import re-fetches a fresh copy, clear the latched error, and bump
  // reloadKey to re-run the load effect. Bumping reloadKey also changes the
  // ErrorBoundary key below, remounting it with cleared state — so a view that
  // crashed at render is genuinely retried, not stuck behind a latched boundary.
  const recoverView = useCallback(() => {
    bundleModuleCache.delete(`${bundleUrl}::${componentExport}`);
    setLoadError(null);
    setReloadKey((k) => k + 1);
  }, [bundleUrl, componentExport]);

  // iOS App Store and Google Play builds cannot load remote JS at runtime.
  if (!dynamicLoadingAllowed) {
    return <ViewRestrictedState viewId={viewId} />;
  }

  if (loadError) {
    return (
      <ViewErrorState
        viewId={viewId}
        error={loadError}
        onRetry={recoverView}
        onBack={navigateToViews}
      />
    );
  }

  if (!bundle) {
    return <ViewLoadingSkeleton />;
  }

  const View = bundle.component;
  const viewProps = {
    ...forwardedViewProps,
    exitToApps: navigateToViews,
    t: (
      key: string,
      options?: { defaultValue?: string } | Record<string, unknown>,
    ) =>
      typeof options === "object" &&
      options !== null &&
      "defaultValue" in options &&
      typeof options.defaultValue === "string"
        ? options.defaultValue
        : key,
  };

  return (
    <div ref={containerRef} className="contents">
      <AgentSurfaceProvider viewId={viewId} viewType={viewType}>
        {/* Keyed by bundleUrl+reloadKey so a successful reload (refresh
            capability / dev HMR / Retry) remounts the boundary with cleared
            state instead of staying latched on a stale render crash. */}
        <ErrorBoundary
          key={`${bundleUrl}:${reloadKey}`}
          fallback={(error, resetErrorBoundary) => (
            <ViewErrorState
              viewId={viewId}
              error={error}
              onRetry={() => {
                resetErrorBoundary();
                recoverView();
              }}
              onBack={navigateToViews}
            />
          )}
        >
          <View {...viewProps} />
        </ErrorBoundary>
        <AgentElementOverlay />
        <AgentSurfaceElementReporter />
      </AgentSurfaceProvider>
    </div>
  );
});
