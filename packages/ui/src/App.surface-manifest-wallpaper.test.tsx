// @vitest-environment jsdom

/**
 * Manifest-driven wallpaper-grant invariant for the real <App/> shell (#13452).
 *
 * The App.screen-background-fuzz suite proves navigation never leaks a
 * background and that the shell-owned SHARED tabs cannot bleed into opaque
 * routes. THIS suite proves the new manifest contract that closes the issue's
 * remaining scope: the resolved surface manifest is the ONLY thing that admits
 * the wallpaper, gated on the `wallpaper` capability grant. A registered plugin
 * view that DECLARES `background: "shared"` but was not granted `wallpaper`
 * NEVER paints the wallpaper — regardless of what global background state a rogue
 * view mutates — while its twin WITH the grant does. Asserted against the real
 * <App/> and its real `resolveActiveScreenBackgroundPolicy` → AppBackground
 * pipeline, not a mock of the resolver.
 *
 * Kept in a dedicated file (not appended to the fuzz suite) because the fuzz
 * file's 34-tab × multi-seed shader walk already sits at the single-worker heap
 * ceiling; this suite mounts <App/> only a handful of times so it stays light.
 */

import { act, cleanup, render } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_APPLY_EVENT } from "./backgrounds/useBackgroundApplyChannel";
import type { BuiltinTab } from "./navigation";
import type { BackgroundConfig } from "./state/ui-preferences";
import { emitViewEvent } from "./views/view-event-bus";

const appState = vi.hoisted(() => ({
  setTab: vi.fn(),
  tab: "views" as string,
}));

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

// The two manifest fixtures the invariant turns on: a shared-declaring view
// WITHOUT the wallpaper grant (must resolve opaque) and its twin WITH the grant
// (paints the wallpaper). Both are registered remote views resolved by the
// shell's findRemoteViewForRoute path.
const ungrantedSharedView = {
  id: "ungranted-shared",
  label: "Ungranted Shared",
  available: true,
  pluginName: "@elizaos/plugin-ungranted",
  path: "/ungranted-shared",
  bundleUrl: "/api/views/ungranted-shared/bundle.js",
  viewType: "gui" as const,
  surface: { background: "shared" as const, capabilities: [] as const },
};
const grantedWallpaperView = {
  id: "granted-wallpaper",
  label: "Granted Wallpaper",
  available: true,
  pluginName: "@elizaos/plugin-granted",
  path: "/granted-wallpaper",
  bundleUrl: "/api/views/granted-wallpaper/bundle.js",
  viewType: "gui" as const,
  surface: {
    background: "shared" as const,
    capabilities: ["wallpaper"] as const,
  },
};
const mockAvailableViews = [ungrantedSharedView, grantedWallpaperView];

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
  isStandalonePwa: () => false,
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
  fetchAvailableViews: async () => mockAvailableViews,
}));
vi.mock("./hooks/useAuthStatus", () => ({
  useAuthStatus: () => ({
    state: { phase: "authenticated" },
    refetch: vi.fn(),
  }),
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
  CharacterEditor: () => <div data-testid="character-editor" />,
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

// AppBackground reads the persisted config through this hook (not the ./state
// barrel above). Seed it so the root background renders from our config.
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

// Minimal three.js shim so the real ProgrammableShaderBackground can mount.
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
import { shellHistory } from "./surface-realm-channel";

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
  expect(present.length).toBe(1);
  if (shader) return { kind: "shader", el: shader };
  if (image) return { kind: "image", el: image };
  if (glsl) return { kind: "glsl", el: glsl };
  return { kind: "opaque", el: opaque as HTMLElement };
}

describe("App wallpaper-grant invariant — manifest gates the wallpaper (#13452)", () => {
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
    // No backend serves this suite, yet mounted pages (e.g. AutomationsFeed)
    // fire real on-mount fetches; their socket errors can settle after vitest
    // tears down the file's jsdom environment, where the late setState makes
    // react-dom read the deleted `window` (unhandled teardown rejection on
    // loaded CI workers). Forever-pending requests keep every page in its
    // designed loading state with nothing left to settle after teardown.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
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
      shellHistory.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
      rerender(<App />);
    });
  }

  async function rogueApply(
    rerender: (ui: React.ReactElement) => void,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await act(async () => {
      emitViewEvent(BACKGROUND_APPLY_EVENT, payload, "view");
      rerender(<App />);
    });
  }

  // Every hostile global-state mutation a rogue view might broadcast to try to
  // conjure the wallpaper onto a route that was never granted it.
  const MUTATIONS: Record<string, unknown>[] = [
    { op: "set", mode: "image", imageUrl: "data:image/svg+xml,<svg/>" },
    { op: "set", mode: "glsl", presetId: "aurora", color: "#ff0000" },
    { op: "set", color: "#ff00ff" },
    { op: "set", color: "javascript:alert(1)" },
  ];

  const VIEWS_TAB = "views" as BuiltinTab;

  it("a view declaring shared WITHOUT the wallpaper grant NEVER renders the wallpaper — even under a global-state mutation storm", async () => {
    const { container, rerender } = render(<App />);

    // Despite its manifest saying `background: "shared"`, the grant gate forces
    // the ungranted view opaque.
    await navigate(rerender, VIEWS_TAB, "/ungranted-shared");
    expect(
      readBackgroundLayer(container).kind,
      "ungranted shared view is opaque (grant gate)",
    ).toBe("opaque");

    // A rogue view fires every global background mutation while we sit on the
    // ungranted route. None can make the wallpaper paint here — the manifest,
    // not global state, decides.
    for (const payload of MUTATIONS) {
      await rogueApply(rerender, payload);
      expect(
        readBackgroundLayer(container).kind,
        `ungranted view stays opaque after ${JSON.stringify(payload)}`,
      ).toBe("opaque");
    }
  }, 60_000);

  it("a view WITH the wallpaper grant paints the wallpaper (the gate is a real switch, not always-closed)", async () => {
    const { container, rerender } = render(<App />);

    await navigate(rerender, VIEWS_TAB, "/granted-wallpaper");
    // Exactly one background layer, and it is the wallpaper — proving the grant
    // admits the shared background where the ungranted twin was forced opaque.
    expect(
      readBackgroundLayer(container).kind,
      "granted-wallpaper view paints the wallpaper",
    ).toBe("shader");
  }, 60_000);

  it("the ungranted and granted twins differ ONLY by the grant — same declared shared background, opposite rendered result", async () => {
    const { container, rerender } = render(<App />);

    // Ungranted twin → opaque.
    await navigate(rerender, VIEWS_TAB, "/ungranted-shared");
    expect(readBackgroundLayer(container).kind).toBe("opaque");

    // Granted twin → wallpaper. Same `background: "shared"` declaration; the
    // single differentiator is `capabilities: ["wallpaper"]`.
    await navigate(rerender, VIEWS_TAB, "/granted-wallpaper");
    expect(readBackgroundLayer(container).kind).not.toBe("opaque");

    // Back to the ungranted twin → opaque again (no carry-over from the granted
    // route's wallpaper).
    await navigate(rerender, VIEWS_TAB, "/ungranted-shared");
    expect(readBackgroundLayer(container).kind).toBe("opaque");
  }, 60_000);
});
