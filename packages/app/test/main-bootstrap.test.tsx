/**
 * Exercise the actual entrypoint bootstrap with real React roots in jsdom.
 * Like cloud-pair-session-token.test, isolate source from main's native/plugin
 * imports; select whole declarations with the TS AST, not copied boot logic.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mainSource = ts.createSourceFile(
  "main.tsx",
  readFileSync(join(import.meta.dirname, "../src/main.tsx"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

const bootstrapSource = mainSource.statements
  .filter((node) => {
    if (ts.isVariableStatement(node)) {
      return node.declarationList.declarations.some(
        (declaration) =>
          declaration.name.getText(mainSource) === "rendererBootstrap",
      );
    }
    if (ts.isFunctionDeclaration(node)) {
      return ["buildAppBootConfig", "mountReactApp", "main", "boot"].includes(
        node.name?.text ?? "",
      );
    }
    if (ts.isExpressionStatement(node)) {
      return (
        node.getText(mainSource) === "rendererBootstrap.mount = mountReactApp;"
      );
    }
    if (ts.isIfStatement(node)) {
      return [
        "import.meta.hot",
        "isNative && !rendererBootstrap.deepLinksInitialized",
        'document.readyState === "loading"',
      ].includes(node.expression.getText(mainSource));
    }
    return false;
  })
  .map((node) => node.getText(mainSource))
  .join("\n");

// Only substitute Vite's hot/env contexts; ownership, config construction, real
// main() awaits/mount sites, failure handling, DOM-ready and JSX remain production code.
const compiledBootstrap = ts.transpileModule(bootstrapSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React,
  },
  transformers: {
    before: [
      (context) => {
        const visit: ts.Visitor = (node) => {
          if (
            ts.isPropertyAccessExpression(node) &&
            ts.isMetaProperty(node.expression) &&
            ["hot", "env"].includes(node.name.text)
          ) {
            return context.factory.createIdentifier(node.name.text);
          }
          return ts.visitEachChild(node, visit, context);
        };
        return (source) => ts.visitNode(source, visit) as ts.SourceFile;
      },
    ],
  },
}).outputText;

type BootstrapState = {
  root: Root | null;
  bootPromise: Promise<void> | null;
  mount: () => void;
};
type BootstrapModule = {
  boot: () => void;
  state: BootstrapState;
  dispose: () => void;
};

const roots: Root[] = [];
const disposals: Array<() => void> = [];

function Children({ children }: React.PropsWithChildren) {
  return <>{children}</>;
}

function AppProvider({
  children,
  branding,
}: React.PropsWithChildren<{ branding: { version: string } }>) {
  return <div data-bootstrap-version={branding.version}>{children}</div>;
}

function App() {
  return (
    <main data-app-shell-root>
      <section aria-label="Notes" />
      <textarea aria-label="Chat composer" defaultValue="draft" />
    </main>
  );
}

function createHarness(overrides: Record<string, unknown> = {}) {
  const hotData: { rendererBootstrap?: BootstrapState } = {};
  let bootConfig: Record<string, unknown> = {
    apiBase: "http://runtime.example",
    apiToken: "test-runtime-token",
    runtimeOwned: { value: "preserve" },
  };
  const getBootConfig = () => bootConfig;
  const setBootConfig = (config: Record<string, unknown>) => {
    bootConfig = config;
  };
  const appRender = vi.fn();
  const initializeAppModules = vi.fn(async () => {});
  const initializeStorageBridge = vi.fn(async () => {});
  const initializePlatform = vi.fn(async () => {});
  const initializeDeepLinks = vi.fn();
  const renderBootFailure = vi.fn(() => {
    document
      .getElementById("root")
      ?.replaceChildren(document.createTextNode("Reload app"));
  });
  const rootFactory = vi.fn((element: HTMLElement) => {
    const root = createRoot(element);
    roots.push(root);
    return root;
  });
  const bindings: Record<string, unknown> = {
    ...Object.fromEntries(
      [
        "markStartup",
        "measureStartup",
        "setupPlatformStyles",
        "applyBuildTimeIosConnection",
        "applyLaunchConnectionFromUrl",
        "injectWaifuChatAccessToken",
        "injectPopoutApiBase",
        "injectDetachedShellApiBase",
        "applyStoredDetachedShellTheme",
        "initializeCapacitorBridge",
        "installIosLocalAgentNativeRequestBridge",
        "installIosLocalAgentFetchBridge",
        "runIosFullBunSmokeFromDesktopShell",
        "scheduleDeferredAppModuleLoadsAfterPaint",
      ].map((name) => [name, vi.fn()]),
    ),
    React,
    StrictMode: React.StrictMode,
    Suspense: React.Suspense,
    document,
    createRoot: rootFactory,
    initializeAppModules,
    initializeStorageBridge,
    initializePlatform,
    renderBootFailure,
    getBootConfig,
    setBootConfig,
    env: {},
    APP_CONFIG: { defaultApps: ["notes"] },
    IOS_RUNTIME_ENV_CONFIG: {},
    APP_VRM_ASSETS: [],
    APP_STYLE_PRESETS: [],
    APP_CHARACTER_CATALOG: {},
    APP_ENV_ALIASES: [],
    CodingAgentSettingsSection: () => null,
    CodingAgentControlChip: () => null,
    AppBlockerSettingsCard: () => null,
    WebsiteBlockerSettingsCard: () => null,
    shouldInstallMainWindowFirstRunPatches: () => false,
    getMobileLifecycle: () => ({ initializeDeepLinks }),
    App: function BootstrapApp() {
      appRender();
      return <App />;
    },
    AppProvider,
    ErrorBoundary: Children,
    RenderTelemetryProfiler: Children,
    ShellModalityProvider: Children,
    ShellRoleProvider: Children,
    DesktopSurfaceNavigationRuntime: () => null,
    DesktopTrayRuntime: () => null,
    MarketingHomePage: () => null,
    MarketingDownloadsPage: () => null,
    CloudRouterShell: ({ appElement }: { appElement: React.ReactNode }) =>
      appElement,
    APP_LOG_PREFIX: "[bootstrap-test]",
    __ELIZA_CHAT_UI_HARNESS__: false,
    __ELIZA_SERVICE_WORKER__: false,
    isNative: false,
    isIOS: false,
    isAndroid: false,
    platform: "web",
    isDesktopPlatform: () => false,
    isPhoneCompanionMode: () => false,
    isDetachedWindowShell: () => false,
    resolveAppWindowSlug: () => null,
    shouldMountWebShell: () => true,
    isPopoutWindow: () => false,
    isStandaloneWindowShell: () => false,
    isChatOverlayWindowShell: () => false,
    windowShellRoute: null,
    client: {},
    runEmbedHandshake: vi.fn(async () => {}),
    runIosFullBunEntrypoint: vi.fn(async () => false),
    startVoiceModuleLoad: vi.fn(async () => null),
    ...overrides,
  };

  function evaluate(version: string, hotEnabled = true): BootstrapModule {
    let dispose = () => {};
    const injected = {
      ...bindings,
      exports: {},
      APP_BRANDING: { version },
      CodingAgentTasksPanel: () => null,
      hot: hotEnabled
        ? {
            data: hotData,
            dispose: (callback: () => void) => {
              dispose = callback;
            },
          }
        : undefined,
    };
    const module = new Function(
      ...Object.keys(injected),
      `${compiledBootstrap}\nreturn { boot, state: rendererBootstrap };`,
    )(...Object.values(injected)) as BootstrapModule;
    module.dispose = dispose;
    disposals.push(dispose);
    return module;
  }

  return {
    evaluate,
    rootFactory,
    initializeAppModules,
    initializeStorageBridge,
    initializePlatform,
    initializeDeepLinks,
    renderBootFailure,
    getBootConfig,
    appRender,
  };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
});

afterEach(async () => {
  for (const dispose of disposals.splice(0)) dispose();
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.restoreAllMocks();
});

describe("main renderer bootstrap ownership", () => {
  it.each([true, false])(
    "initializes and mounts once (hot context: %s)",
    async (hotEnabled) => {
      const harness = createHarness();
      await act(async () => {
        const module = harness.evaluate("first", hotEnabled);
        module.boot();
        module.boot();
        await module.state.bootPromise;
      });
      expect(harness.initializeAppModules).toHaveBeenCalledTimes(1);
      expect(harness.initializeStorageBridge).toHaveBeenCalledTimes(1);
      expect(harness.initializePlatform).toHaveBeenCalledTimes(1);
      expect(harness.rootFactory).toHaveBeenCalledTimes(1);
      expect(harness.appRender).toHaveBeenCalledTimes(2); // StrictMode stays enabled.
      expect(document.querySelectorAll("[data-app-shell-root]")).toHaveLength(
        1,
      );
      expect(
        document.querySelectorAll('[aria-label="Chat composer"]'),
      ).toHaveLength(1);
    },
  );

  it("reuses a completed boot and root across HMR without losing the composer draft", async () => {
    const harness = createHarness();
    let first!: BootstrapModule;
    await act(async () => {
      first = harness.evaluate("first");
      await first.state.bootPromise;
    });
    const root = first.state.root;
    const promise = first.state.bootPromise;
    const firstConfig = harness.getBootConfig();
    const composer = document.querySelector("textarea") as HTMLTextAreaElement;
    composer.value = "unsent user draft";
    first.dispose();
    await act(async () => {
      const next = harness.evaluate("second");
      expect(next.state.root).toBe(root);
      expect(next.state.bootPromise).toBe(promise);
    });
    expect(harness.rootFactory).toHaveBeenCalledTimes(1);
    expect(harness.initializePlatform).toHaveBeenCalledTimes(1);
    expect(harness.initializeAppModules).toHaveBeenCalledTimes(1);
    expect(harness.getBootConfig()).toMatchObject({
      branding: { version: "second" },
      apiBase: "http://runtime.example",
      apiToken: "test-runtime-token",
    });
    expect(harness.getBootConfig().runtimeOwned).toBe(firstConfig.runtimeOwned);
    expect(harness.getBootConfig().codingAgentTasksPanel).not.toBe(
      firstConfig.codingAgentTasksPanel,
    );
    expect(
      document.querySelector('[data-bootstrap-version="second"]'),
    ).not.toBeNull();
    expect(document.querySelector("textarea")).toBe(composer);
    expect(composer.value).toBe("unsent user draft");
    expect(document.querySelectorAll("[data-app-shell-root]")).toHaveLength(1);
  });

  it.each(["normal", "standalone", "popout"])(
    "finishes one pending %s boot through the latest HMR mount",
    async (route) => {
      const pending = Promise.withResolvers<void>();
      const initializeAppModules = vi.fn(() => pending.promise);
      const harness = createHarness({
        initializeAppModules,
        isPopoutWindow: () => route === "popout",
        isStandaloneWindowShell: () => route === "standalone",
      });
      await act(async () => {
        const first = harness.evaluate("first");
        const promise = first.state.bootPromise;
        await Promise.resolve();
        first.dispose();
        const next = harness.evaluate("second");
        expect(next.state.bootPromise).toBe(promise);
        expect(next.state.root).toBeNull();
        pending.resolve();
        await promise;
      });
      expect(initializeAppModules).toHaveBeenCalledTimes(1);
      expect(harness.rootFactory).toHaveBeenCalledTimes(1);
      expect(
        document.querySelector('[data-bootstrap-version="second"]'),
      ).not.toBeNull();
      expect(document.querySelectorAll("[data-app-shell-root]")).toHaveLength(
        1,
      );
      expect(harness.renderBootFailure).not.toHaveBeenCalled();
    },
  );

  it("removes an obsolete DOM-ready listener and captures native deep links once", async () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const removeListener = vi.spyOn(document, "removeEventListener");
    const harness = createHarness({ isNative: true });
    const first = harness.evaluate("first");
    expect(first.state.bootPromise).toBeNull();
    first.dispose();
    expect(removeListener).toHaveBeenCalledWith("DOMContentLoaded", first.boot);
    const next = harness.evaluate("second");
    await act(async () => {
      document.dispatchEvent(new Event("DOMContentLoaded"));
      document.dispatchEvent(new Event("DOMContentLoaded"));
      await next.state.bootPromise;
    });
    expect(harness.initializeDeepLinks).toHaveBeenCalledTimes(1);
    expect(harness.initializeAppModules).toHaveBeenCalledTimes(1);
    expect(harness.rootFactory).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-bootstrap-version="second"]'),
    ).not.toBeNull();
  });

  it.each(["before mount", "after mount"])(
    "delivers a boot failure once %s and keeps the reload card across HMR",
    async (stage) => {
      const failure = new Error(`failed ${stage}`);
      const fail = vi.fn(async () => {
        throw failure;
      });
      const harness = createHarness({
        [stage === "before mount"
          ? "initializeAppModules"
          : "initializePlatform"]: fail,
      });
      await act(async () => {
        const first = harness.evaluate("first");
        await first.state.bootPromise;
        expect(first.state.root).toBeNull();
        first.dispose();
        const next = harness.evaluate("second");
        next.boot();
        await next.state.bootPromise;
      });
      expect(fail).toHaveBeenCalledTimes(1);
      expect(harness.renderBootFailure).toHaveBeenCalledExactlyOnceWith(
        failure,
      );
      expect(document.getElementById("root")?.textContent).toBe("Reload app");
      expect(document.querySelectorAll("[data-app-shell-root]")).toHaveLength(
        0,
      );
    },
  );
});
