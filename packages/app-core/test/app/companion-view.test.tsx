// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockUseApp = vi.fn();
const viewerPropsRef: { current: null | Record<string, unknown> } = {
  current: null,
};

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
  getVrmPreviewUrl: () => "/vrms/previews/milady-1.png",
  getVrmUrl: () => "/vrms/milady-1.vrm.gz",
  getVrmBackgroundUrl: (index: number) =>
    `/vrms/backgrounds/milady-${index}.png`,
  getVrmTitle: (index: number) => `MILADY-${index}`,
  VRM_COUNT: 24,
}));

vi.mock("@elizaos/app-core/components/avatar/VrmViewer", () => ({
  VrmViewer: (props: Record<string, unknown>) => {
    viewerPropsRef.current = props;
    return React.createElement("div", null, "VrmViewer");
  },
}));

vi.mock("../../src/components/ChatModalView.js", () => ({
  ChatModalView: () =>
    React.createElement(
      "div",
      { "data-testid": "companion-chat-modal-stub" },
      "ChatModalView",
    ),
}));

const mockUploadCustomVrm = vi.fn(async () => { });
const mockUploadCustomBackground = vi.fn(async () => { });

vi.mock("@elizaos/app-core/api", () => ({
  client: {
    uploadCustomVrm: (...args: unknown[]) => mockUploadCustomVrm(...args),
    uploadCustomBackground: (...args: unknown[]) =>
      mockUploadCustomBackground(...args),
    onWsEvent: vi.fn(() => () => { }),
  },
}));

vi.mock("@elizaos/app-core/utils", () => ({
  resolveApiUrl: (p: string) => p,
  resolveAppAssetUrl: (p: string) => p,
}));

import { CompanionSceneHost } from "@elizaos/app-core/components/CompanionSceneHost";
import { CompanionView } from "../../src/components/CompanionView";

const COMPANION_ZOOM_STORAGE_KEY = "milady.companion.zoom.v1";

function createContext(overrides: Record<string, unknown> = {}) {
  return {
    t: (k: string) => k,
    chatMode: "simple",
    chatAgentVoiceMuted: false,
    setState: vi.fn(),
    handleStartDraftConversation: vi.fn(async () => { }),
    handleNewConversation: vi.fn(async () => { }),
    selectedVrmIndex: 1,
    customVrmUrl: "",
    customBackgroundUrl: "",
    walletAddresses: null,
    walletBalances: null,
    walletNfts: null,
    walletLoading: false,
    walletNftsLoading: false,
    walletError: null,
    loadBalances: vi.fn(async () => { }),
    loadNfts: vi.fn(async () => { }),
    getBscTradePreflight: vi.fn(async () => ({
      ok: false,
      reasons: ["disabled"],
    })),
    getBscTradeQuote: vi.fn(async () => ({
      route: [],
      quoteIn: { amount: "0", symbol: "BNB" },
      quoteOut: { amount: "0", symbol: "BNB" },
      minReceive: { amount: "0", symbol: "BNB" },
      slippageBps: 100,
    })),
    getBscTradeTxStatus: vi.fn(async (hash: string) => ({
      ok: true,
      hash,
      status: "pending",
      explorerUrl: `https://bscscan.com/tx/${hash}`,
      chainId: 56,
      blockNumber: null,
      confirmations: 0,
      nonce: null,
      gasUsed: null,
      effectiveGasPriceWei: null,
    })),
    loadWalletTradingProfile: vi.fn(async () => ({
      window: "30d",
      source: "all",
      generatedAt: new Date().toISOString(),
      summary: {
        totalSwaps: 0,
        buyCount: 0,
        sellCount: 0,
        settledCount: 0,
        successCount: 0,
        revertedCount: 0,
        tradeWinRate: null,
        txSuccessRate: null,
        winningTrades: 0,
        evaluatedTrades: 0,
        realizedPnlBnb: "0",
        volumeBnb: "0",
      },
      pnlSeries: [],
      tokenBreakdown: [],
      recentSwaps: [],
    })),
    executeBscTrade: vi.fn(async () => ({
      executed: false,
      execution: null,
      requiresUserSignature: false,
    })),
    executeBscTransfer: vi.fn(async () => ({
      executed: false,
      execution: null,
      requiresUserSignature: false,
    })),
    setActionNotice: vi.fn(),
    agentStatus: {
      state: "running",
      agentName: "Milady",
      platform: "test",
      pid: null,
    },
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    elizaCloudCredits: null,
    elizaCloudCreditsCritical: false,
    elizaCloudCreditsLow: false,
    elizaCloudTopUpUrl: "",
    lifecycleBusy: false,
    lifecycleAction: null,

    handleRestart: vi.fn(async () => { }),
    copyToClipboard: vi.fn(async () => { }),
    uiLanguage: "en",
    setUiLanguage: vi.fn(),
    uiTheme: "light",
    setUiTheme: vi.fn(),
    uiShellMode: "companion",
    setUiShellMode: vi.fn(),
    switchUiShellMode: vi.fn(),
    switchShellView: vi.fn(),
    setTab: vi.fn(),
    plugins: [],
    ...overrides,
  };
}

function text(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : text(child)))
    .join("");
}

function _countByClass(
  node: TestRenderer.ReactTestInstance,
  className: string,
): number {
  return node.findAll(
    (candidate) =>
      typeof candidate.props.className === "string" &&
      candidate.props.className.split(/\s+/).includes(className),
  ).length;
}

describe("CompanionView", () => {
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;

  beforeEach(() => {
    viewerPropsRef.current = null;
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: vi.fn((key: string) => storage.get(String(key)) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage.set(String(key), String(value));
        }),
        removeItem: vi.fn((key: string) => {
          storage.delete(String(key));
        }),
        clear: vi.fn(() => {
          storage.clear();
        }),
      },
      configurable: true,
      writable: true,
    });

    Object.defineProperty(globalThis, "window", {
      value: {
        innerWidth: 1440,
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      configurable: true,
    });
    Object.assign(document, {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    Object.defineProperty(globalThis, "fetch", {
      value: vi.fn(async () => ({
        ok: false,
        json: async () => ({}),
      })),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "activeElement");
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: originalLocalStorage,
      configurable: true,
      writable: true,
    });
  });

  it("renders CompanionView containing VrmStage, Header, and HubNav", async () => {
    mockUseApp.mockReturnValue(createContext());

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(CompanionView));
    });

    const content = text(tree?.root);
    // Should render the mock VrmViewer text
    expect(content).toContain("VrmViewer");
    // Should render the mock ChatModalView text
    expect(content).toContain("ChatModalView");
  });

  it("renders centered companion header chat controls", async () => {
    const setState = vi.fn();
    const handleStartDraftConversation = vi.fn(async () => { });
    const handleNewConversation = vi.fn(async () => { });
    mockUseApp.mockReturnValue(
      createContext({
        setState,
        handleStartDraftConversation,
        handleNewConversation,
      }),
    );

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(CompanionView));
    });

    const controls = tree?.root.findByProps({
      "data-testid": "companion-header-chat-controls",
    });
    const voiceButton = tree?.root.find(
      (node) =>
        node.type === "button" && node.props["aria-label"] === "Agent voice on",
    );
    const newChatButton = tree?.root.find(
      (node) =>
        node.type === "button" && node.props["aria-label"] === "New Chat",
    );

    expect(controls).toBeDefined();
    expect(String(controls.props.className)).not.toContain("rounded-full");
    expect(String(controls.props.className)).not.toContain("border");
    expect(voiceButton).toBeDefined();
    expect(newChatButton).toBeDefined();
    expect(String(newChatButton.props.className)).toContain("text-black");

    await act(async () => {
      voiceButton?.props.onClick();
    });
    expect(setState).toHaveBeenCalledWith("chatAgentVoiceMuted", true);

    await act(async () => {
      newChatButton?.props.onClick();
    });
    expect(handleStartDraftConversation).toHaveBeenCalledTimes(1);
    expect(handleNewConversation).not.toHaveBeenCalled();
  });

  it("keeps the shared companion scene wrapper height-bounded", async () => {
    mockUseApp.mockReturnValue(createContext());

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(
          CompanionSceneHost,
          { active: false },
          React.createElement("div", null, "Child"),
        ),
      );
    });

    const root = tree?.root.findByProps({ "data-testid": "companion-root" });
    expect(String(root?.props.className)).toContain("h-full");
    expect(String(root?.props.className)).toContain("min-h-0");
    expect(String(root?.props.className)).toContain("flex");
    expect(String(root?.props.className)).toContain("overflow-hidden");
  });

  it("pins companion mode to fast and hides the fast/pro toggle", async () => {
    const context = createContext();
    mockUseApp.mockReturnValue(context);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(CompanionView));
    });

    expect(
      tree?.root.findAllByProps({
        "data-testid": "chat-mode-toggle-companion",
      }),
    ).toHaveLength(0);
    expect(context.setState).toHaveBeenCalledWith("chatMode", "simple");
  });

  it("orbits the companion camera from transcript drag and resets on release", async () => {
    mockUseApp.mockReturnValue(createContext());

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(CompanionView));
    });

    const setDragOrbitTarget = vi.fn();
    const resetDragOrbit = vi.fn();
    const setCompanionZoomNormalized = vi.fn();
    await act(async () => {
      const ready = viewerPropsRef.current?.onEngineReady as
        | ((value: unknown) => void)
        | undefined;
      ready?.({
        setPaused: vi.fn(),
        setCameraAnimation: vi.fn(),
        setPointerParallaxEnabled: vi.fn(),
        setDragOrbitTarget,
        resetDragOrbit,
        setCompanionZoomNormalized,
      });
    });

    expect(setCompanionZoomNormalized).toHaveBeenCalledWith(0.95);
    setDragOrbitTarget.mockClear();
    resetDragOrbit.mockClear();

    expect(tree).not.toBeNull();
    const root = tree?.root.findByProps({
      "data-testid": "companion-camera-drag-surface",
    });
    const currentTarget = {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      clientWidth: 1440,
      clientHeight: 900,
    };
    const preventDefault = vi.fn();

    await act(async () => {
      root?.props.onPointerDownCapture({
        target: document.createElement("div"),
        currentTarget,
        pointerId: 7,
        clientX: 200,
        clientY: 300,
      });
      root?.props.onPointerMoveCapture({
        target: document.createElement("div"),
        currentTarget,
        pointerId: 7,
        clientX: 560,
        clientY: 120,
        preventDefault,
      });
      root?.props.onPointerUpCapture({
        target: document.createElement("div"),
        currentTarget,
        pointerId: 7,
      });
    });

    expect(currentTarget.setPointerCapture).toHaveBeenCalledWith(7);
    expect(setDragOrbitTarget).toHaveBeenCalledTimes(1);
    const [yaw, pitch] = setDragOrbitTarget.mock.calls[0];
    expect(yaw).toBeCloseTo(0.3375);
    expect(pitch).toBeCloseTo(0.17);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(resetDragOrbit).toHaveBeenCalledTimes(1);
    expect(currentTarget.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("ignores drag capture inside marked no-camera-drag controls", async () => {
    mockUseApp.mockReturnValue(createContext());

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(CompanionView));
    });

    const setDragOrbitTarget = vi.fn();
    await act(async () => {
      const ready = viewerPropsRef.current?.onEngineReady as
        | ((value: unknown) => void)
        | undefined;
      ready?.({
        setPaused: vi.fn(),
        setCameraAnimation: vi.fn(),
        setPointerParallaxEnabled: vi.fn(),
        setDragOrbitTarget,
        resetDragOrbit: vi.fn(),
        setCompanionZoomNormalized: vi.fn(),
      });
    });
    setDragOrbitTarget.mockClear();

    const root = tree?.root.findByProps({
      "data-testid": "companion-camera-drag-surface",
    });
    const currentTarget = {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      clientWidth: 1440,
      clientHeight: 900,
    };
    const composerControl = document.createElement("div");
    composerControl.setAttribute("data-no-camera-drag", "true");

    await act(async () => {
      root?.props.onPointerDownCapture({
        target: composerControl,
        currentTarget,
        pointerId: 7,
        clientX: 200,
        clientY: 300,
      });
      root?.props.onPointerMoveCapture({
        target: composerControl,
        currentTarget,
        pointerId: 7,
        clientX: 560,
        clientY: 120,
        preventDefault: vi.fn(),
      });
    });

    expect(currentTarget.setPointerCapture).not.toHaveBeenCalled();
    expect(setDragOrbitTarget).not.toHaveBeenCalled();
  });

  it("zooms the companion camera from root wheel input, including over overlay UI", async () => {
    mockUseApp.mockReturnValue(createContext());

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(CompanionView));
    });

    const setCompanionZoomNormalized = vi.fn();
    await act(async () => {
      const ready = viewerPropsRef.current?.onEngineReady as
        | ((value: unknown) => void)
        | undefined;
      ready?.({
        setPaused: vi.fn(),
        setCameraAnimation: vi.fn(),
        setPointerParallaxEnabled: vi.fn(),
        setDragOrbitTarget: vi.fn(),
        resetDragOrbit: vi.fn(),
        setCompanionZoomNormalized,
      });
    });
    setCompanionZoomNormalized.mockClear();

    expect(tree).not.toBeNull();
    const root = tree?.root.findByProps({
      "data-testid": "companion-camera-drag-surface",
    });
    const preventDefault = vi.fn();

    await act(async () => {
      root?.props.onWheelCapture({
        deltaY: 120,
        deltaMode: 0,
        preventDefault,
      });
    });

    const lastZoom =
      setCompanionZoomNormalized.mock.calls.at(-1)?.[0] ?? Number.NaN;
    expect(lastZoom).toBeCloseTo(0.95 - 120 / 720, 5);
    expect(localStorage.setItem).toHaveBeenLastCalledWith(
      COMPANION_ZOOM_STORAGE_KEY,
      String(lastZoom),
    );
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("does not zoom the companion camera while a text entry is focused", async () => {
    mockUseApp.mockReturnValue(createContext());

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(CompanionView));
    });

    const setCompanionZoomNormalized = vi.fn();
    await act(async () => {
      const ready = viewerPropsRef.current?.onEngineReady as
        | ((value: unknown) => void)
        | undefined;
      ready?.({
        setPaused: vi.fn(),
        setCameraAnimation: vi.fn(),
        setPointerParallaxEnabled: vi.fn(),
        setDragOrbitTarget: vi.fn(),
        resetDragOrbit: vi.fn(),
        setCompanionZoomNormalized,
      });
    });
    setCompanionZoomNormalized.mockClear();

    const root = tree?.root.findByProps({
      "data-testid": "companion-camera-drag-surface",
    });
    const focusedTextEntry = document.createElement("textarea");
    Object.defineProperty(document, "activeElement", {
      configurable: true,
      value: focusedTextEntry,
    });
    const preventDefault = vi.fn();

    await act(async () => {
      root?.props.onWheelCapture({
        ctrlKey: true,
        deltaY: -90,
        deltaMode: 0,
        preventDefault,
      });
    });

    expect(setCompanionZoomNormalized).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("zooms the companion camera from pinch input", async () => {
    mockUseApp.mockReturnValue(createContext());

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(CompanionView));
    });

    const setCompanionZoomNormalized = vi.fn();
    const resetDragOrbit = vi.fn();
    const currentTarget = {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      clientWidth: 1440,
      clientHeight: 900,
    };

    await act(async () => {
      const ready = viewerPropsRef.current?.onEngineReady as
        | ((value: unknown) => void)
        | undefined;
      ready?.({
        setPaused: vi.fn(),
        setCameraAnimation: vi.fn(),
        setPointerParallaxEnabled: vi.fn(),
        setDragOrbitTarget: vi.fn(),
        resetDragOrbit,
        setCompanionZoomNormalized,
      });
    });

    const root = tree?.root.findByProps({
      "data-testid": "companion-camera-drag-surface",
    });

    await act(async () => {
      root?.props.onPointerDownCapture({
        currentTarget,
        pointerType: "touch",
        pointerId: 11,
        clientX: 200,
        clientY: 300,
        preventDefault: vi.fn(),
      });
      root?.props.onPointerDownCapture({
        currentTarget,
        pointerType: "touch",
        pointerId: 12,
        clientX: 320,
        clientY: 300,
        preventDefault: vi.fn(),
      });
      root?.props.onPointerMoveCapture({
        currentTarget,
        pointerType: "touch",
        pointerId: 12,
        clientX: 260,
        clientY: 300,
        preventDefault: vi.fn(),
      });
    });

    const zoomCalls = setCompanionZoomNormalized.mock.calls
      .map(([value]: [number]) => value)
      .filter((value) => value < 1);
    expect(resetDragOrbit).toHaveBeenCalledTimes(1);
    expect(zoomCalls.at(-1)).toBeLessThan(0.9);
  });

  it("restores persisted companion zoom on mount", async () => {
    localStorage.setItem(COMPANION_ZOOM_STORAGE_KEY, "0.62");
    mockUseApp.mockReturnValue(createContext());

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(CompanionView));
    });

    const setCompanionZoomNormalized = vi.fn();
    await act(async () => {
      const ready = viewerPropsRef.current?.onEngineReady as
        | ((value: unknown) => void)
        | undefined;
      ready?.({
        setPaused: vi.fn(),
        setCameraAnimation: vi.fn(),
        setPointerParallaxEnabled: vi.fn(),
        setDragOrbitTarget: vi.fn(),
        resetDragOrbit: vi.fn(),
        setCompanionZoomNormalized,
      });
    });

    expect(tree).not.toBeNull();
    expect(setCompanionZoomNormalized).toHaveBeenCalledWith(0.62);
  });

  it("uses a dedicated non-selectable drag surface for camera orbit", async () => {
    mockUseApp.mockReturnValue(createContext());

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(CompanionView));
    });

    const dragLayer = tree?.root.findByProps({
      "data-testid": "companion-camera-drag-surface",
    });

    expect(dragLayer?.props.className).toContain("select-none");
    expect(dragLayer?.props.style).toMatchObject({
      touchAction: "none",
      userSelect: "none",
      WebkitUserSelect: "none",
    });
  });
});
