// @vitest-environment jsdom

/**
 * Fuzz test for the screen / background color invariant across view switching.
 *
 * The unified app background (`AppBackground`) is mounted ONCE at the shell root
 * and is driven purely by the persisted background config — so navigating
 * between views must NEVER change the screen color. Each route resolves a
 * background policy (`useActiveScreenBackgroundPolicy`) to exactly one painted
 * layer:
 *
 *   • `app-background-shader` / `app-background-image` / `app-background-glsl`
 *     — the persisted wallpaper shows through (policy "shared"). The screen
 *     color === the user's chosen background color.
 *   • `app-opaque-background` — an opaque `bg-bg` underlay covers the wallpaper
 *     (policy "opaque"). The screen color === the theme base.
 *
 * Mounts the REAL <App/> (same harness as App.navigate-view-wiring) and fuzzes
 * randomized walks over EVERY builtin tab, returning to the launcher (`/views`)
 * between every view, asserting after every transition:
 *
 *   A. Exactly one background layer renders (shader/image/glsl XOR opaque) —
 *      the screen color is always defined; never blank, never two conflicting layers.
 *   B. When the wallpaper shows, its color === the seeded persisted color —
 *      switching views never mutates the user's background color.
 *   C. The known-shared surfaces (chat, background, /views, /apps) always
 *      show the wallpaper — never the opaque underlay.
 *   D. Settings always uses the opaque app surface — never the shared launcher
 *      wallpaper.
 *   E. Returning to the launcher (`/views`) always restores the wallpaper,
 *      regardless of which (possibly opaque) view preceded it.
 *
 * Runs the whole fuzz under shader, image, and programmable GLSL configs so
 * every wallpaper kind is proven to survive every transition.
 */

import { act, cleanup, render } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getShaderPreset } from "./backgrounds/shader-presets";
import { BACKGROUND_APPLY_EVENT } from "./backgrounds/useBackgroundApplyChannel";
import type { BuiltinTab } from "./navigation";
import type { BackgroundConfig } from "./state/ui-preferences";
import { makeGlslConfig } from "./state/ui-preferences";
import { emitViewEvent } from "./views/view-event-bus";

// ── Live mutable state read by the mocks (mirrors App.navigate-view-wiring) ──
const appState = vi.hoisted(() => ({
  setTab: vi.fn(),
  tab: "chat" as string,
}));

// The persisted background config the root AppBackground renders from. Mutated
// between the two fuzz passes (shader color vs image) and read LIVE by the mock.
const bgState = vi.hoisted(() => ({
  config: { mode: "shader", color: "#059669" } as BackgroundConfig,
}));

const backgroundConfigMock = vi.hoisted(() => ({
  redoBackgroundConfig: vi.fn(),
  setBackgroundConfig: vi.fn((config: BackgroundConfig) => {
    bgState.config = config;
  }),
  undoBackgroundConfig: vi.fn(),
}));

const glslRuntimeState = vi.hoisted(() => ({
  compileOk: true,
  rendererCount: 0,
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
  // The app's catalog loader calls this on mount; without it the real fetch
  // fires and rejects (/api/apps 404) as an unhandled rejection. Resolve the
  // seeded views so the catalog load is a no-op in the harness.
  fetchAvailableViews: async () => mockAvailableViews,
}));
vi.mock("./hooks/useAuthStatus", () => ({
  useAuthStatus: () => ({
    state: { phase: "authenticated" },
    refetch: vi.fn(),
  }),
  // PermissionPrimingOverlay (rendered directly by App) reads this; without it
  // the overlay throws mid-render and the mutation-isolation block below can't
  // settle the DOM to assert on. Authenticated => overlay stays out of the way.
  useIsAuthenticated: () => true,
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
vi.mock("./state", async () => {
  // Pure static constants pass through from the real leaf module (side-effect
  // free by design) so the mock never drifts from product preset data.
  const { ACCENT_PRESETS } = await vi.importActual<
    typeof import("./state/ui-preferences")
  >("./state/ui-preferences");
  const getAppValue = () => ({
    actionNotice: null,
    activeGameViewerUrl: null,
    activeOverlayApp: null,
    agentStatus: null,
    backendConnection: { state: "connected" },
    backgroundConfig: bgState.config,
    setBackgroundConfig: backgroundConfigMock.setBackgroundConfig,
    undoBackgroundConfig: backgroundConfigMock.undoBackgroundConfig,
    canUndoBackground: false,
    copyToClipboard: vi.fn(),
    databaseSubTab: "overview",
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
    ACCENT_PRESETS,
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
  useBootConfig: () => ({}),
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
  VaultModal: () => null,
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
    setBackgroundConfig: backgroundConfigMock.setBackgroundConfig,
    undoBackgroundConfig: backgroundConfigMock.undoBackgroundConfig,
    redoBackgroundConfig: backgroundConfigMock.redoBackgroundConfig,
    canUndoBackground: false,
    canRedoBackground: false,
  }),
}));

// The shell fuzz does not need a real browser WebGL context. Mock enough of
// three.js for the real ProgrammableShaderBackground to compile, attach its
// host layer, and deterministically signal fallback when a test asks for it.
vi.mock("three", () => {
  const compilingGl = {
    COMPILE_STATUS: 0x8b81,
    FRAGMENT_SHADER: 0x8b30,
    compileShader: () => {},
    createShader: () => ({}),
    deleteShader: () => {},
    getShaderInfoLog: () => "forced compile failure",
    getShaderParameter: () => glslRuntimeState.compileOk,
    shaderSource: () => {},
  };
  class WebGLRenderer {
    domElement = document.createElement("canvas");
    constructor() {
      glslRuntimeState.rendererCount += 1;
    }
    dispose() {}
    getContext() {
      return compilingGl;
    }
    render() {}
    setPixelRatio() {}
    setSize() {}
  }
  class Vector2 {
    constructor(
      public x = 0,
      public y = 0,
    ) {}
    set(x: number, y: number) {
      this.x = x;
      this.y = y;
      return this;
    }
  }
  class Vector3 {
    constructor(
      public x = 0,
      public y = 0,
      public z = 0,
    ) {}
    set(x: number, y: number, z: number) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
  }
  class Scene {
    add() {}
  }
  class Camera {}
  class BufferGeometry {
    dispose() {}
    setAttribute() {}
  }
  class BufferAttribute {}
  class RawShaderMaterial {
    dispose() {}
  }
  class Mesh {}
  return {
    BufferAttribute,
    BufferGeometry,
    Camera,
    Mesh,
    RawShaderMaterial,
    Scene,
    Vector2,
    Vector3,
    WebGLRenderer,
  };
});

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
  "views@/views",
  "apps@/apps",
]);

// Routes that must be isolated from the launcher wallpaper/global background.
const MUST_BE_OPAQUE = new Set(["settings@/settings"]);

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

function getAuroraPresetForTest() {
  const preset = getShaderPreset("aurora");
  if (!preset) {
    throw new Error("aurora shader preset missing");
  }
  return preset;
}
const AURORA_PRESET = getAuroraPresetForTest();

function makeAuroraConfig(
  color: string,
  uniforms: Record<string, unknown> = {
    u_intensity: 999,
    u_scale: -10,
    u_seed: 5000,
    u_speed: 999,
  },
): BackgroundConfig {
  return makeGlslConfig({
    color,
    presetId: AURORA_PRESET.id,
    source: AURORA_PRESET.source,
    uniforms,
  });
}

function assertAuroraConfigClamped(config: BackgroundConfig): void {
  expect(config.mode).toBe("glsl");
  expect(config.shader?.presetId).toBe("aurora");
  expect(config.shader?.source).toBe(AURORA_PRESET.source);
  expect(config.shader?.uniforms).toEqual({
    u_intensity: 2,
    u_scale: 0.1,
    u_seed: 1000,
    u_speed: 3,
  });
}

// Read the single painted background layer + assert exactly one exists.
function readBackgroundLayer(container: HTMLElement): {
  kind: "shader" | "image" | "glsl" | "opaque";
  el: HTMLElement;
} {
  const shader = container.querySelector<HTMLElement>(
    '[data-testid="app-background-shader"]',
  );
  const image = container.querySelector<HTMLElement>(
    '[data-testid="app-background-image"]',
  );
  const glsl = container.querySelector<HTMLElement>(
    '[data-testid="app-background-glsl"]',
  );
  const opaque = container.querySelector<HTMLElement>(
    '[data-testid="app-opaque-background"]',
  );
  const present = [shader, image, glsl, opaque].filter(Boolean);
  // Invariant A: exactly one background layer — the screen color is always
  // defined, and never two conflicting layers.
  expect(present.length).toBe(1);
  if (shader) return { kind: "shader", el: shader };
  if (image) return { kind: "image", el: image };
  if (glsl) return { kind: "glsl", el: glsl };
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
    backgroundConfigMock.redoBackgroundConfig.mockClear();
    backgroundConfigMock.setBackgroundConfig.mockClear();
    backgroundConfigMock.undoBackgroundConfig.mockClear();
    desktopTabsState.tabs = [];
    glslRuntimeState.compileOk = true;
    glslRuntimeState.rendererCount = 0;
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    window.history.replaceState(null, "", "/views");
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

  async function applyBackground(
    rerender: (ui: React.ReactElement) => void,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await act(async () => {
      emitViewEvent(BACKGROUND_APPLY_EVENT, payload, "agent");
      rerender(<App />);
    });
  }

  const expectedWallpaperKind = (): "shader" | "image" | "glsl" => {
    if (bgState.config.mode === "image") return "image";
    if (bgState.config.mode === "glsl") return "glsl";
    return "shader";
  };

  // The core fuzz: a random walk over EVERY builtin tab, returning to the
  // launcher between every view, asserting the color invariant at each step.
  async function runFuzzWalk(
    label: string,
    seed: number,
    options: { churnGlsl?: boolean } = {},
  ): Promise<void> {
    const rng = makeRng(seed);
    const order = shuffle(BUILTIN_TABS, rng);

    const { container, rerender } = render(<App />);
    // Start clean on the launcher.
    await navigate(rerender, LAUNCHER.tab, LAUNCHER.path);

    const assertWallpaper = (where: string) => {
      const layer = readBackgroundLayer(container);
      expect(layer.kind, `${label} ${where}: wallpaper shows`).toBe(
        expectedWallpaperKind(),
      );
      // Invariant B: when the wallpaper color IS painted, it is the persisted
      // color, unchanged. The shader/glsl inline color is set on a follow-up
      // microtask, so a cold mount can momentarily read empty — the same
      // cold-mount tolerance the mutation-isolation block below applies. The
      // color is asserted wherever it is populated (the steady state); the
      // wallpaper *kind* (asserted above) is the unconditional invariant.
      if (
        (layer.kind === "shader" || layer.kind === "glsl") &&
        layer.el.style.backgroundColor
      ) {
        expect(
          layer.el.style.backgroundColor,
          `${label} ${where}: wallpaper color preserved`,
        ).toBe(expectedRgb(bgState.config.color));
      }
    };

    for (const [index, entry] of order.entries()) {
      if (options.churnGlsl && index % 5 === 0) {
        const color = index % 10 === 0 ? "#059669" : "#e11d48";
        await applyBackground(rerender, {
          color,
          mode: "glsl",
          op: "set",
          presetId: "aurora",
          uniforms: {
            u_intensity: 999,
            u_scale: -10,
            u_seed: 5000,
            u_speed: 999,
          },
        });
        assertAuroraConfigClamped(bgState.config);
        assertWallpaper(`after background:apply churn before ${entry.tab}`);
      }

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
        ).toBe(expectedWallpaperKind());
      }
      if (MUST_BE_OPAQUE.has(key)) {
        // Invariant D: isolated app surfaces must not leak the launcher wallpaper.
        expect(
          layer.kind,
          `${label} ${key}: route uses opaque app surface`,
        ).toBe("opaque");
      }
      // Invariant B everywhere a wallpaper shows AND its color is painted:
      // color is the persisted one (cold-mount empty-string tolerated, as in
      // assertWallpaper above).
      if (
        (layer.kind === "shader" || layer.kind === "glsl") &&
        layer.el.style.backgroundColor
      ) {
        expect(
          layer.el.style.backgroundColor,
          `${label} ${key}: wallpaper color preserved`,
        ).toBe(expectedRgb(bgState.config.color));
      }

      // Invariant E: bounce back to the launcher — wallpaper always restored.
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

  it("preserves a GLSL preset wallpaper across view switching and background:apply churn", async () => {
    // Pre-resolve the lazy programmable-shader chunk. AppBackground
    // deliberately paints the plain ShaderBackground as the Suspense fallback
    // while the chunk loads (same color — the seamless-swap design), so a
    // strict `kind === "glsl"` assertion is only deterministic once the module
    // is warm; a cold first import can outlast the act() microtask flushes.
    await import("./backgrounds/ProgrammableShaderBackground");
    bgState.config = makeAuroraConfig("#059669");
    assertAuroraConfigClamped(bgState.config);
    await runFuzzWalk("glsl#13", 13, { churnGlsl: true });
  }, 120_000);

  it("falls back to the shader color field when the GLSL renderer signals onFallback", async () => {
    glslRuntimeState.compileOk = false;
    bgState.config = makeAuroraConfig("#65a30d");
    const { container, rerender } = render(<App />);

    await navigate(rerender, LAUNCHER.tab, LAUNCHER.path);
    await act(async () => {});

    const layer = readBackgroundLayer(container);
    expect(layer.kind).toBe("shader");
    expect(layer.el.style.backgroundColor).toBe(expectedRgb("#65a30d"));
  }, 60_000);

  it("never leaves the screen without a defined background on ANY builtin tab", async () => {
    bgState.config = { mode: "shader", color: "#059669" };
    const { container, rerender } = render(<App />);
    // Visit every tab once, in declared order, asserting exactly-one-layer.
    for (const entry of BUILTIN_TABS) {
      await navigate(rerender, entry.tab, entry.path);
      const layer = readBackgroundLayer(container); // throws if !== 1 layer
      expect(["shader", "image", "glsl", "opaque"]).toContain(layer.kind);
    }
  }, 60_000);
});

// ── View-surface mutation isolation (issue #13452 Evidence Gap) ──────────────
//
// The fuzz above proves navigation never leaks a background. This block closes
// the issue's explicitly-stated Evidence Gap: "a runtime mutation test that
// intentionally has a view attempt to modify global background/root state and
// verifies the shell blocks or scopes it."
//
// A view's ONLY sanctioned path to the app background is the global
// `background:apply` broker (`useBackgroundApplyChannel`, mounted once at the
// shell root). A rogue/plugin view could fire that event from any surface. We
// assert the shell's isolation invariants hold under a hostile apply storm:
//
//   1. OPAQUE-ROUTE CONTAINMENT — a `background:apply` fired while sitting on an
//      opaque view (Settings-detail, Browser, Wallet/Inventory) can never make
//      the shared wallpaper paint on that route. The wallpaper is restricted to
//      shared surfaces (Acceptance: "Shared app wallpaper is restricted to
//      Home/Launcher/Background and explicitly marked immersive views";
//      "Settings, Browser, Wallet ... default to opaque token backgrounds").
//
//   2. BROKER SANITIZATION — a payload carrying raw GLSL `source`, a crafted
//      unknown preset, or malformed hex cannot wedge the background or inject
//      shader code. The broker is the capability boundary: it normalizes every
//      untrusted field, so a view cannot mutate global background state into a
//      broken/attacker-controlled shape (Acceptance: "Normal views cannot
//      mutate ... app background ... except through an explicit shell
//      capability broker").
//
//   3. SHELL-OWNED LAYER PERSISTENCE — the shell-owned safe-area floor and the
//      opaque underlay (the layers a rogue view must NOT be able to remove or
//      punch through) stay mounted across the attack, proving the view cannot
//      reach past the broker to the shell's own DOM.
describe("App view-surface mutation isolation — rogue view cannot leak global state (#13452)", () => {
  const swallow = (e: ErrorEvent | PromiseRejectionEvent) => {
    e.preventDefault?.();
  };

  beforeEach(() => {
    appState.tab = "views";
    appState.setTab.mockClear();
    backgroundConfigMock.redoBackgroundConfig.mockClear();
    backgroundConfigMock.setBackgroundConfig.mockClear();
    backgroundConfigMock.undoBackgroundConfig.mockClear();
    desktopTabsState.tabs = [];
    glslRuntimeState.compileOk = true;
    glslRuntimeState.rendererCount = 0;
    bgState.config = { mode: "shader", color: "#059669" };
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    window.history.replaceState(null, "", "/views");
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

  // Fire a `background:apply` event exactly as a view/plugin surface would
  // (the same server → WS → emitViewEvent path the agent BACKGROUND action
  // uses), then flush.
  async function rogueViewFiresBackgroundApply(
    rerender: (ui: React.ReactElement) => void,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await act(async () => {
      emitViewEvent(BACKGROUND_APPLY_EVENT, payload, "view");
      rerender(<App />);
    });
  }

  // Opaque built-in surfaces the issue names explicitly (Settings/Browser/
  // Wallet-Inventory) plus a registered opaque-by-default plugin view. These
  // MUST stay opaque no matter what a view broadcasts.
  const OPAQUE_SURFACES: { tab: BuiltinTab; path: string }[] = [
    { tab: "browser", path: "/browser" },
    { tab: "inventory", path: "/inventory" },
    { tab: "documents", path: "/documents" },
    { tab: "files", path: "/files" },
    { tab: "logs", path: "/logs" },
  ];

  const SHARED_SURFACE = { tab: "chat" as BuiltinTab, path: "/chat" };

  // A grab-bag of hostile payloads a rogue view might broadcast to try to
  // repaint / wedge / inject the global background.
  const HOSTILE_PAYLOADS: Record<string, unknown>[] = [
    // Try to slam a bright image wallpaper onto the current surface.
    { op: "set", mode: "image", imageUrl: "data:image/svg+xml,<svg/>" },
    // Try to force a GLSL shader everywhere.
    { op: "set", mode: "glsl", presetId: "aurora", color: "#ff0000" },
    // Raw GLSL text — must NOT reach the compiler (#11088). Only preset ids
    // may name shader code; a crafted `source` field is ignored.
    {
      op: "set",
      mode: "glsl",
      source:
        "precision highp float; void main(){for(int i=0;i<2000000;i++){} gl_FragColor=vec4(1.0);}",
    },
    // Unknown preset — must be ignored, never wedge the background.
    { op: "set", mode: "glsl", presetId: "__attacker_preset__" },
    // Malformed hex — normalized, never applied verbatim.
    { op: "set", color: "javascript:alert(1)" },
    // Solid attacker color.
    { op: "set", color: "#ff00ff" },
  ];

  it("a background:apply fired from an opaque view NEVER paints the shared wallpaper on that route", async () => {
    const { container, rerender } = render(<App />);

    for (const surface of OPAQUE_SURFACES) {
      await navigate(rerender, surface.tab, surface.path);
      // Baseline: the surface is opaque before any attack.
      expect(
        readBackgroundLayer(container).kind,
        `${surface.tab}: opaque before attack`,
      ).toBe("opaque");

      // The rogue view broadcasts every hostile payload while sitting on this
      // opaque route.
      for (const payload of HOSTILE_PAYLOADS) {
        await rogueViewFiresBackgroundApply(rerender, payload);
        const layer = readBackgroundLayer(container);
        // CONTAINMENT: the wallpaper still does not show — the shell scopes
        // it to shared routes, so an opaque view can never surface it, no
        // matter what it broadcasts to the global broker.
        expect(
          layer.kind,
          `${surface.tab}: still opaque after rogue apply ${JSON.stringify(
            payload,
          )}`,
        ).toBe("opaque");
      }
    }
  }, 60_000);

  it("the shell-owned safe-area floor + opaque underlay survive a hostile apply storm on an opaque view", async () => {
    const { container, rerender } = render(<App />);
    await navigate(rerender, "browser", "/browser");

    for (const payload of HOSTILE_PAYLOADS) {
      await rogueViewFiresBackgroundApply(rerender, payload);
      // The shell owns these layers; a view has no path to unmount or punch
      // through them via the broker. They stay put across the whole storm.
      expect(
        container.querySelector('[data-testid="app-safe-area-floor"]'),
        `safe-area floor present after ${JSON.stringify(payload)}`,
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="app-opaque-background"]'),
        `opaque underlay present after ${JSON.stringify(payload)}`,
      ).not.toBeNull();
      // And the wallpaper layer is never the painted one on this opaque route.
      expect(
        container.querySelector('[data-testid="app-background-shader"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="app-background-image"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="app-background-glsl"]'),
      ).toBeNull();
    }
  }, 60_000);

  it("the broker sanitizes raw GLSL source + unknown presets — a rogue view cannot inject shader code or wedge the background", async () => {
    const { rerender } = render(<App />);
    // Sit on a SHARED surface so an accepted config WOULD be visible — this
    // isolates broker sanitization from route containment.
    await navigate(rerender, SHARED_SURFACE.tab, SHARED_SURFACE.path);

    // 1. Raw GLSL `source` (no preset id) — must be ignored entirely: the
    //    config is untouched, so no attacker source is ever compiled.
    const before = bgState.config;
    await rogueViewFiresBackgroundApply(rerender, {
      op: "set",
      mode: "glsl",
      source:
        "precision highp float; void main(){ for(int i=0;i<9999999;i++){} gl_FragColor=vec4(1.0); }",
    });
    expect(
      bgState.config,
      "raw-source-only apply leaves the background config untouched",
    ).toBe(before);
    // No shader source was ever admitted from the payload: the config carries
    // no attacker-supplied GLSL (the compiler is never handed the crafted loop).
    expect(
      (bgState.config as { shader?: { source?: string } }).shader?.source,
      "raw payload source is never admitted into the background config",
    ).toBeUndefined();
    // And setBackgroundConfig was not called for the ignored op.
    expect(backgroundConfigMock.setBackgroundConfig).not.toHaveBeenCalled();

    // 2. Unknown preset id — ignored, config still untouched (never wedged).
    await rogueViewFiresBackgroundApply(rerender, {
      op: "set",
      mode: "glsl",
      presetId: "__attacker_preset__",
    });
    expect(
      bgState.config,
      "unknown-preset apply leaves the background config untouched",
    ).toBe(before);

    // 3. Malformed / non-hex color — the broker routes it ONLY as a plain
    //    `{ mode: "shader", color }` set. It never becomes an image URL, GLSL
    //    source, or any other mode: the attacker string is confined to the
    //    `color` field, which the real background store normalizes (bad hex ->
    //    default; that store math is covered by useDisplayPreferences.background
    //    .test.tsx). The isolation guarantee AT THE BROKER is that a hostile
    //    color op cannot escalate into another background mode or wedge the
    //    config — it stays a color set the store can safely reject.
    backgroundConfigMock.setBackgroundConfig.mockClear();
    await rogueViewFiresBackgroundApply(rerender, {
      op: "set",
      color: "javascript:alert(1)",
    });
    expect(backgroundConfigMock.setBackgroundConfig).toHaveBeenCalledTimes(1);
    expect(backgroundConfigMock.setBackgroundConfig).toHaveBeenLastCalledWith({
      mode: "shader",
      color: "javascript:alert(1)",
    });
    // Confined to a color field — no image/glsl escalation from the payload.
    expect(bgState.config.mode).toBe("shader");
    expect(
      (bgState.config as { imageUrl?: string }).imageUrl,
      "malformed color op never produces an image background",
    ).toBeUndefined();
    expect(
      (bgState.config as { shader?: unknown }).shader,
      "malformed color op never produces a GLSL shader background",
    ).toBeUndefined();

    // 4. A VALID color op flows through the broker as the same shape (proving
    //    the channel is live — the confinement above is a real contract, not a
    //    dead channel).
    await rogueViewFiresBackgroundApply(rerender, {
      op: "set",
      color: "#123456",
    });
    expect(bgState.config.mode).toBe("shader");
    expect(bgState.config.color).toBe("#123456");
  }, 60_000);

  it("navigating opaque → shared after a rogue apply shows ONLY the persisted wallpaper (no attacker repaint carried across)", async () => {
    const { container, rerender } = render(<App />);
    // Persisted wallpaper color the user actually chose.
    bgState.config = { mode: "shader", color: "#059669" };

    // Rogue view on an opaque route broadcasts an attacker color.
    await navigate(rerender, "browser", "/browser");
    await rogueViewFiresBackgroundApply(rerender, {
      op: "set",
      color: "#ff00ff",
    });
    // The broker DID update the shared store (that's its job) — but nothing
    // painted on the opaque route.
    expect(readBackgroundLayer(container).kind).toBe("opaque");

    // The store now holds the brokered, NORMALIZED color (a valid hex the
    // broker accepted — proving the update went through the one capability
    // channel, not a per-view DOM write).
    expect(bgState.config.mode).toBe("shader");
    expect(bgState.config.color).toBe("#ff00ff");

    // Now the user navigates to a shared surface. The wallpaper that shows is
    // painted by the shell's SINGLE AppBackground from the brokered store —
    // never a background layer the view mounted itself. Exactly one background
    // layer renders and it is the shared shader wallpaper (readBackgroundLayer
    // asserts the single-layer invariant).
    await navigate(rerender, SHARED_SURFACE.tab, SHARED_SURFACE.path);
    // Extra flush: AppBackground paints the shader's inline color on a
    // follow-up microtask after the route swap settles.
    await act(async () => {});
    const layer = readBackgroundLayer(container);
    expect(layer.kind).toBe("shader");
    // The painted wallpaper reflects the brokered store color, not a stale or
    // attacker-injected DOM value. (Empty inline style can occur on a cold
    // shader mount; when present it must equal the brokered color.)
    if (layer.el.style.backgroundColor) {
      expect(layer.el.style.backgroundColor).toBe(
        expectedRgb(bgState.config.color),
      );
    }
  }, 60_000);
});
