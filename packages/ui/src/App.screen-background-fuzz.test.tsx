// @vitest-environment jsdom
//
// Fuzz test for the screen / background color invariant across view switching.
//
// The unified app background (`AppBackground`) is mounted ONCE at the shell root
// and is driven purely by the persisted background config — so navigating
// between views must NEVER change the screen color. Each route resolves a
// background policy (`useActiveScreenBackgroundPolicy`) to exactly one of two
// painted layers:
//
//   • `app-background-shader` / `app-background-image` — the persisted wallpaper
//     shows through (policy "shared"). The screen color === the user's chosen
//     background color.
//   • `app-opaque-background` — an opaque `bg-bg` underlay covers the wallpaper
//     (policy "opaque"). The screen color === the theme base.
//
// This file mounts the REAL <App/> (same harness as App.navigate-view-wiring)
// and fuzzes randomized walks over EVERY builtin tab, returning to the launcher
// (`/views`) between every view, asserting after every transition:
//
//   A. Exactly one background layer renders (shader/image XOR opaque) — the
//      screen color is always defined; never blank, never two conflicting layers.
//   B. When the wallpaper shows, its color === the seeded persisted color —
//      switching views never mutates the user's background color.
//   C. The known-shared surfaces (chat, background, settings, /views,
//      /apps) always show the wallpaper — never the opaque underlay.
//   D. Returning to the launcher (`/views`) always restores the wallpaper,
//      regardless of which (possibly opaque) view preceded it.
//
// Runs the whole fuzz under a shader config AND an image config so both
// wallpaper kinds are proven to survive every transition.

import { act, cleanup, render } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltinTab } from "./navigation";

// ── Live mutable state read by the mocks (mirrors App.navigate-view-wiring) ──
const appState = vi.hoisted(() => ({
  setTab: vi.fn(),
  tab: "chat" as string,
}));

// The persisted background config the root AppBackground renders from. Mutated
// between the two fuzz passes (shader color vs image) and read LIVE by the mock.
const bgState = vi.hoisted(() => ({
  config: { mode: "shader", color: "#059669" } as {
    mode: "shader" | "image";
    color: string;
    imageUrl?: string;
  },
}));

const desktopTabsState = vi.hoisted(() => ({
  tabs: [] as Array<{
    viewId: string;
    label: string;
    path: string;
    icon?: string;
    pinned: boolean;
  }>,
}));

const desktopTabsMock = vi.hoisted(() => ({
  closeTab: vi.fn(),
  openTab: vi.fn(),
}));

const desktopBridgeMock = vi.hoisted(() => ({
  getElectrobunRendererRpc: vi.fn(() => undefined),
  invokeDesktopBridgeRequest: vi.fn(async () => ({ id: "window-1" })),
  subscribeDesktopBridgeEvent: vi.fn(() => vi.fn()),
}));

const dynamicViewLoaderMock = vi.hoisted(() => ({
  render: vi.fn(({ viewId }: { viewId: string }) => (
    <div data-testid="dynamic-view-loader" data-view-id={viewId} />
  )),
}));

// A couple of registered remote views so the registry-resolution branches are
// exercised by the fuzz too (one shares, one is opaque-by-default).
const sharedCanvasView = {
  id: "shared-canvas",
  label: "Shared Canvas",
  available: true,
  pluginName: "@elizaos/plugin-shared-canvas",
  path: "/shared-canvas",
  bundleUrl: "/api/views/shared-canvas/bundle.js",
  viewType: "gui" as const,
  backgroundPolicy: "shared" as const,
};
const documentsView = {
  id: "documents",
  label: "Knowledge",
  available: true,
  pluginName: "@elizaos/plugin-documents",
  path: "/documents",
  bundleUrl: "/api/views/documents/bundle.js",
  viewType: "gui" as const,
};
const mockAvailableViews = [sharedCanvasView, documentsView];

vi.mock("@capacitor/keyboard", () => ({
  Keyboard: { setScroll: vi.fn(async () => undefined) },
}));
vi.mock("./bridge/electrobun-rpc", () => desktopBridgeMock);
vi.mock("./bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => true,
}));
vi.mock("./platform/init", () => ({
  isDesktopPlatform: () => false,
  isIOS: false,
  isNative: false,
  isWebPlatform: () => true,
}));
vi.mock("./hooks/useDesktopTabs", () => ({
  useDesktopTabs: () => ({
    tabs: desktopTabsState.tabs,
    closeTab: desktopTabsMock.closeTab,
    openTab: desktopTabsMock.openTab,
  }),
}));
vi.mock("./hooks/useAvailableViews", () => ({
  useAvailableViews: () => ({ views: mockAvailableViews }),
  useRoutableViews: () => ({ views: mockAvailableViews }),
}));
vi.mock("./hooks/useAuthStatus", () => ({
  useAuthStatus: () => ({
    state: { phase: "authenticated" },
    refetch: vi.fn(),
  }),
}));
vi.mock("./hooks/useActivityEvents", () => ({
  useActivityEvents: () => ({ events: [], clearEvents: vi.fn() }),
}));
vi.mock("./hooks", () => ({
  BugReportProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useBugReportState: () => ({}),
  useContextMenu: () => ({
    closeSaveCommandModal: vi.fn(),
    confirmSaveCommand: vi.fn(),
    saveCommandModalOpen: false,
    saveCommandText: "",
  }),
  useMediaQuery: () => false,
  useRenderGuard: vi.fn(),
  useIntervalWhenDocumentVisible: () => {},
}));
vi.mock("./state", () => {
  const getAppValue = () => ({
    actionNotice: null,
    activeGameViewerUrl: null,
    activeOverlayApp: null,
    agentStatus: null,
    backendConnection: { state: "connected" },
    backgroundConfig: bgState.config,
    setBackgroundConfig: vi.fn(),
    undoBackgroundConfig: vi.fn(),
    canUndoBackground: false,
    copyToClipboard: vi.fn(),
    databaseSubTab: "overview",
    dismissActionBanner: vi.fn(),
    dismissSystemWarning: vi.fn(),
    elizaCloudConnected: false,
    elizaCloudVoiceProxyAvailable: false,
    gameOverlayEnabled: false,
    handlePluginToggle: vi.fn(),
    loadPlugins: vi.fn(async () => undefined),
    loadDropStatus: vi.fn(async () => undefined),
    firstRunComplete: true,
    ownerName: "Test Owner",
    plugins: [],
    retryStartup: vi.fn(),
    setActionNotice: vi.fn(),
    setState: vi.fn(),
    setTab: appState.setTab,
    setUiLanguage: vi.fn(),
    setUiTheme: vi.fn(),
    setUiThemeMode: vi.fn(),
    startupCoordinator: { phase: "ready", retry: vi.fn() },
    startupError: null,
    systemWarnings: [],
    tab: appState.tab,
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? "",
    uiLanguage: "en",
    uiShellMode: "default",
    uiTheme: "light",
    uiThemeMode: "system",
  });
  return {
    useApp: () => getAppValue(),
    useAppSelector: <T,>(
      selector: (s: ReturnType<typeof getAppValue>) => T,
    ): T => selector(getAppValue()),
    useAppSelectorShallow: <T,>(
      selector: (s: ReturnType<typeof getAppValue>) => T,
    ): T => selector(getAppValue()),
    useTranslation: () => ({
      t: (key: string, options?: { defaultValue?: string }) =>
        options?.defaultValue ?? key,
    }),
  };
});
vi.mock("./config/boot-config-react.hooks", () => ({
  useBootConfig: () => ({ companionShell: null }),
}));
vi.mock("./components/shell/ShellControllerContext", () => ({
  ShellControllerProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useShellControllerContext: () => ({
    canSend: true,
    close: vi.fn(),
    messages: [],
    open: vi.fn(),
    phase: "idle",
    recording: false,
    send: vi.fn(),
    toggleRecording: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    waveformMode: "idle",
  }),
}));
vi.mock("./components/views/DynamicViewLoader", () => ({
  DynamicViewLoader: dynamicViewLoaderMock.render,
}));
vi.mock("./components/shell/BugReportModal", () => ({
  BugReportModal: () => null,
}));
vi.mock("./components/shell/ChatSurface", () => ({
  ChatSurface: () => <div data-testid="chat-surface" />,
}));
vi.mock("./components/shell/HomePill", () => ({
  HomePill: () => <button type="button">home pill</button>,
}));
vi.mock("./components/shell/AssistantOverlay", () => ({
  AssistantOverlay: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="assistant-overlay">{children}</div>
  ),
}));
vi.mock("./components/shell/ConnectionFailedBanner", () => ({
  ConnectionFailedBanner: () => null,
}));
vi.mock("./components/shell/SystemWarningBanner", () => ({
  SystemWarningBanner: () => null,
}));
vi.mock("./components/shell/ShellOverlays", () => ({
  ShellOverlays: () => null,
}));
vi.mock("./components/chat/SaveCommandModal", () => ({
  SaveCommandModal: () => null,
}));
vi.mock("./components/pages/ChatView", () => ({
  ChatView: () => <div data-testid="chat-view" />,
  __resetCompanionSpeechMemoryForTests: vi.fn(),
}));
vi.mock("./components/character/CharacterEditor", () => ({
  CharacterEditor: ({ initialPage }: { initialPage?: string }) => (
    <div
      data-initial-page={initialPage ?? ""}
      data-testid={
        initialPage === "documents" ? "documents-view" : "character-editor"
      }
    />
  ),
}));
vi.mock("./components/pages/LauncherSurface", () => ({
  LauncherSurface: () => <div data-testid="launcher-surface" />,
}));
vi.mock("./components/settings/SecretsManagerSection", () => ({
  SecretsManagerModalRoot: () => null,
}));
vi.mock("./components/custom-actions/CustomActionEditor", () => ({
  CustomActionEditor: () => null,
}));
vi.mock("./components/shell/ConnectionLostOverlay", () => ({
  ConnectionLostOverlay: () => null,
}));
vi.mock("./hooks/useSecretsManagerShortcut", () => ({
  useSecretsManagerShortcut: vi.fn(),
}));
vi.mock("./hooks/useIsDeveloperMode", () => ({
  useIsDeveloperMode: () => false,
}));

// AppBackground reads the persisted background through `./state/useBackgroundConfig`
// (which imports `./state/app-store` directly — NOT the `./state` barrel mocked
// above). Mock it here so the root background renders from our seeded config,
// exactly as it would from the user's persisted wallpaper. The persistence /
// undo math is covered by useDisplayPreferences.background.test.tsx; this fuzz
// proves the *view-switch* dimension: every view shows the same persisted color.
vi.mock("./state/useBackgroundConfig", () => ({
  useBackgroundConfig: () => ({
    backgroundConfig: bgState.config,
    setBackgroundConfig: vi.fn(),
    undoBackgroundConfig: vi.fn(),
    canUndoBackground: false,
  }),
}));
vi.mock("./backgrounds/useBackgroundApplyChannel", () => ({
  useBackgroundApplyChannel: () => {},
}));

import { App } from "./App";

// ── The full builtin tab universe (mirrors navigation/index.ts BuiltinTab). ──
// Each entry: the tab id + the route path it activates.
const BUILTIN_TABS: { tab: BuiltinTab; path: string }[] = [
  { tab: "chat", path: "/chat" },
  { tab: "phone", path: "/phone" },
  { tab: "messages", path: "/messages" },
  { tab: "contacts", path: "/contacts" },
  { tab: "camera", path: "/camera" },
  { tab: "tasks", path: "/tasks" },
  { tab: "automations", path: "/automations" },
  { tab: "browser", path: "/browser" },
  { tab: "companion", path: "/companion" },
  { tab: "stream", path: "/stream" },
  { tab: "apps", path: "/apps" },
  { tab: "views", path: "/views" },
  { tab: "character", path: "/character" },
  { tab: "character-select", path: "/character-select" },
  { tab: "inventory", path: "/inventory" },
  { tab: "documents", path: "/documents" },
  { tab: "files", path: "/files" },
  { tab: "triggers", path: "/triggers" },
  { tab: "plugins", path: "/plugins" },
  { tab: "skills", path: "/skills" },
  { tab: "advanced", path: "/advanced" },
  { tab: "fine-tuning", path: "/fine-tuning" },
  { tab: "trajectories", path: "/trajectories" },
  { tab: "transcripts", path: "/transcripts" },
  { tab: "relationships", path: "/relationships" },
  { tab: "memories", path: "/memories" },
  { tab: "rolodex", path: "/rolodex" },
  { tab: "runtime", path: "/runtime" },
  { tab: "database", path: "/database" },
  { tab: "desktop", path: "/desktop" },
  { tab: "settings", path: "/settings" },
  { tab: "tutorial", path: "/tutorial" },
  { tab: "help", path: "/help" },
  { tab: "logs", path: "/logs" },
  { tab: "background", path: "/background" },
];

// The launcher / springboard is the `views` tab on the `/views` route.
const LAUNCHER = { tab: "views" as BuiltinTab, path: "/views" };

// Routes whose policy is explicitly "shared" — the wallpaper MUST show through
// (invariant C). Keyed by `${tab}@${path}` to match builtinRouteBackgroundPolicy.
const ALWAYS_SHARED = new Set([
  "chat@/chat",
  "background@/background",
  "settings@/settings",
  "views@/views",
  "apps@/apps",
]);

// Deterministic PRNG (mulberry32) so the fuzz is reproducible — no Math.random.
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const expectedRgb = (hex: string): string => {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
};

// Read the single painted background layer + assert exactly one exists.
function readBackgroundLayer(container: HTMLElement): {
  kind: "shader" | "image" | "opaque";
  el: HTMLElement;
} {
  const shader = container.querySelector<HTMLElement>(
    '[data-testid="app-background-shader"]',
  );
  const image = container.querySelector<HTMLElement>(
    '[data-testid="app-background-image"]',
  );
  const opaque = container.querySelector<HTMLElement>(
    '[data-testid="app-opaque-background"]',
  );
  const present = [shader, image, opaque].filter(Boolean);
  // Invariant A: exactly one background layer — the screen color is always
  // defined, and never two conflicting layers.
  expect(present.length).toBe(1);
  if (shader) return { kind: "shader", el: shader };
  if (image) return { kind: "image", el: image };
  return { kind: "opaque", el: opaque as HTMLElement };
}

describe("App screen-background fuzz — color invariant across view switching", () => {
  // Walking through EVERY view mounts real view content (PluginsView, LogsView,
  // …) whose deep data deps are not mocked here; those throw and are caught by
  // the views' own error boundaries. They are irrelevant to THIS test — the
  // background policy is a property of the shell, resolved from (tab, path,
  // registry), independent of whether a view's body renders. Swallow that
  // view-content noise so it can't be mistaken for a real unhandled error; the
  // explicit background assertions below are the only signal that matters.
  const swallow = (e: ErrorEvent | PromiseRejectionEvent) => {
    e.preventDefault?.();
  };
  beforeEach(() => {
    appState.tab = "views";
    appState.setTab.mockClear();
    desktopTabsState.tabs = [];
    window.history.replaceState(null, "", "/views");
    Reflect.deleteProperty(window, "__ELIZA_API_BASE__");
    Reflect.deleteProperty(window, "__ELIZAOS_API_BASE__");
    window.addEventListener("error", swallow);
    window.addEventListener("unhandledrejection", swallow);
  });

  afterEach(() => {
    window.removeEventListener("error", swallow);
    window.removeEventListener("unhandledrejection", swallow);
    cleanup();
    vi.unstubAllGlobals();
  });

  async function navigate(
    rerender: (ui: React.ReactElement) => void,
    tab: string,
    path: string,
  ): Promise<void> {
    await act(async () => {
      appState.tab = tab;
      window.history.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
      rerender(<App />);
    });
  }

  // The core fuzz: a random walk over EVERY builtin tab, returning to the
  // launcher between every view, asserting the color invariant at each step.
  async function runFuzzWalk(label: string, seed: number): Promise<void> {
    const rng = makeRng(seed);
    const order = shuffle(BUILTIN_TABS, rng);
    const wallpaperKind = bgState.config.mode === "image" ? "image" : "shader";
    const expectedColor = expectedRgb(bgState.config.color);

    const { container, rerender } = render(<App />);
    // Start clean on the launcher.
    await navigate(rerender, LAUNCHER.tab, LAUNCHER.path);

    const assertWallpaper = (where: string) => {
      const layer = readBackgroundLayer(container);
      expect(layer.kind, `${label} ${where}: wallpaper shows`).toBe(
        wallpaperKind,
      );
      // Invariant B: the wallpaper color is the persisted color, unchanged.
      if (layer.kind === "shader") {
        expect(
          layer.el.style.backgroundColor,
          `${label} ${where}: shader color preserved`,
        ).toBe(expectedColor);
      }
    };

    for (const entry of order) {
      // Switch to the view. The act() inside navigate() flushes the popstate
      // state update + the rerender, so the DOM is settled synchronously after.
      await navigate(rerender, entry.tab, entry.path);
      const layer = readBackgroundLayer(container);
      const key = `${entry.tab}@${entry.path}`;
      if (ALWAYS_SHARED.has(key)) {
        // Invariant C: known-shared surfaces always show the wallpaper.
        expect(
          layer.kind,
          `${label} ${key}: known-shared route shows wallpaper`,
        ).toBe(wallpaperKind);
      }
      // Invariant B everywhere a wallpaper shows: color is preserved.
      if (layer.kind === "shader") {
        expect(
          layer.el.style.backgroundColor,
          `${label} ${key}: shader color preserved`,
        ).toBe(expectedColor);
      }

      // Invariant D: bounce back to the launcher — wallpaper always restored.
      await navigate(rerender, LAUNCHER.tab, LAUNCHER.path);
      assertWallpaper(`after ${entry.tab} → launcher`);
    }
  }

  it("preserves the SHADER wallpaper color across a fuzzed walk of every view ↔ launcher", async () => {
    bgState.config = { mode: "shader", color: "#059669" };
    // Several seeds → several independent random orders, each covering all tabs.
    for (const seed of [1, 7, 42]) {
      await runFuzzWalk(`shader#${seed}`, seed);
      cleanup();
    }
  }, 120_000);

  it("preserves an IMAGE wallpaper across a fuzzed walk of every view ↔ launcher", async () => {
    bgState.config = {
      mode: "image",
      color: "#059669",
      imageUrl: "data:image/svg+xml,<svg/>",
    };
    for (const seed of [3, 99]) {
      await runFuzzWalk(`image#${seed}`, seed);
      cleanup();
    }
  }, 120_000);

  it("never leaves the screen without a defined background on ANY builtin tab", async () => {
    bgState.config = { mode: "shader", color: "#059669" };
    const { container, rerender } = render(<App />);
    // Visit every tab once, in declared order, asserting exactly-one-layer.
    for (const entry of BUILTIN_TABS) {
      await navigate(rerender, entry.tab, entry.path);
      const layer = readBackgroundLayer(container); // throws if !== 1 layer
      expect(["shader", "image", "opaque"]).toContain(layer.kind);
    }
  }, 60_000);
});
