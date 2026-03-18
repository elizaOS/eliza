// @vitest-environment jsdom
import { StrictMode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/app-core/utils", () => ({
  resolveAppAssetUrl: (path: string) => path,
}));

vi.mock("@elizaos/app-core/components/avatar/VrmEngine", () => {
  class MockVrmEngine {
    static instances: MockVrmEngine[] = [];

    loadVrmFromUrl = vi.fn(async () => {});
    getState = vi.fn(() => ({
      vrmLoaded: true,
      vrmName: "eliza-1.vrm.gz",
      loadError: null,
      idlePlaying: false,
      idleTime: 0,
      idleTracks: 0,
    }));
    setInteractionEnabled = vi.fn();
    setCameraProfile = vi.fn();
    setInteractionMode = vi.fn();
    setPaused = vi.fn();
    setPointerParallaxEnabled = vi.fn();
    setPointerParallaxTarget = vi.fn();
    resetPointerParallax = vi.fn();
    setWorldUrl = vi.fn(async () => {});
    resize = vi.fn();
    dispose = vi.fn();
    isInitialized = vi.fn(() => false);

    private readyPromise: Promise<void>;
    private resolveReadyPromise: () => void = () => {};

    constructor() {
      this.readyPromise = new Promise<void>((resolve) => {
        this.resolveReadyPromise = resolve;
      });
      MockVrmEngine.instances.push(this);
    }

    setup = vi.fn(() => {});

    whenReady = vi.fn(() => this.readyPromise);

    resolveReady(): void {
      this.resolveReadyPromise();
    }
  }

  (
    globalThis as {
      __elizaVrmViewerMock?: { instances: MockVrmEngine[] };
    }
  ).__elizaVrmViewerMock = { instances: MockVrmEngine.instances };

  return {
    VrmEngine: MockVrmEngine,
  };
});

import { VrmViewer } from "@elizaos/app-core/components/avatar/VrmViewer";

type MockVrmEngineInstance = {
  setWorldUrl: ReturnType<typeof vi.fn>;
  loadVrmFromUrl: ReturnType<typeof vi.fn>;
  resolveReady: () => void;
};

function getMockInstances(): MockVrmEngineInstance[] {
  const store = (
    globalThis as {
      __elizaVrmViewerMock?: { instances: MockVrmEngineInstance[] };
    }
  ).__elizaVrmViewerMock;

  if (!store) {
    throw new Error("Expected VRM viewer mock store to be initialized.");
  }

  return store.instances;
}

describe("VrmViewer", () => {
  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = undefined;
    const mockWindow = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window & typeof globalThis;
    globalThis.window = mockWindow;

    (
      globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }
    ).requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame;
    (
      globalThis as { cancelAnimationFrame?: typeof cancelAnimationFrame }
    ).cancelAnimationFrame = ((id: number) =>
      clearTimeout(id)) as unknown as typeof cancelAnimationFrame;
    getMockInstances().length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads the same VRM path after StrictMode abort/remount", async () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      renderer = TestRenderer.create(
        <StrictMode>
          <VrmViewer vrmPath="/vrms/eliza-1.vrm.gz" mouthOpen={0} />
        </StrictMode>,
        {
          createNodeMock: (element) => {
            if (element.type === "canvas") {
              return {
                getBoundingClientRect: () => ({
                  width: 640,
                  height: 480,
                  top: 0,
                  left: 0,
                  bottom: 480,
                  right: 640,
                  x: 0,
                  y: 0,
                  toJSON: () => ({}),
                }),
              };
            }
            return null;
          },
        },
      );
    });

    const instances = getMockInstances();

    expect(instances.length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      for (const instance of instances) {
        instance.resolveReady();
      }
      await Promise.resolve();
      await Promise.resolve();
    });

    const totalLoadCalls = instances.reduce(
      (count, instance) => count + instance.loadVrmFromUrl.mock.calls.length,
      0,
    );
    expect(totalLoadCalls).toBe(1);
    expect(instances.at(-1)?.loadVrmFromUrl).toHaveBeenCalledWith(
      "/vrms/eliza-1.vrm.gz",
      "eliza-1.vrm.gz",
    );

    await act(async () => {
      renderer?.unmount();
    });
  });

  it("waits for the world load before revealing the VRM on initial world stages", async () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      renderer = TestRenderer.create(
        <VrmViewer
          vrmPath="/vrms/eliza-1.vrm.gz"
          worldUrl="/worlds/companion-day.spz"
          mouthOpen={0}
        />,
        {
          createNodeMock: (element) => {
            if (element.type === "canvas") {
              return {
                getBoundingClientRect: () => ({
                  width: 640,
                  height: 480,
                  top: 0,
                  left: 0,
                  bottom: 480,
                  right: 640,
                  x: 0,
                  y: 0,
                  toJSON: () => ({}),
                }),
              };
            }
            return null;
          },
        },
      );
    });

    const [instance] = getMockInstances();
    expect(instance).toBeTruthy();

    await act(async () => {
      instance?.resolveReady();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(instance?.setWorldUrl).toHaveBeenCalledWith(
      "/worlds/companion-day.spz",
    );
    expect(instance?.loadVrmFromUrl).toHaveBeenCalledWith(
      "/vrms/eliza-1.vrm.gz",
      "eliza-1.vrm.gz",
    );

    const worldCallOrder =
      instance?.setWorldUrl.mock.invocationCallOrder.at(-1) ?? 0;
    const vrmCallOrder =
      instance?.loadVrmFromUrl.mock.invocationCallOrder.at(-1) ?? 0;
    expect(worldCallOrder).toBeLessThan(vrmCallOrder);

    await act(async () => {
      renderer?.unmount();
    });
  });

  it("does not reload the VRM when only the world changes", async () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      renderer = TestRenderer.create(
        <VrmViewer
          vrmPath="/vrms/eliza-1.vrm.gz"
          worldUrl="/worlds/companion-day.spz"
          mouthOpen={0}
        />,
        {
          createNodeMock: (element) => {
            if (element.type === "canvas") {
              return {
                getBoundingClientRect: () => ({
                  width: 640,
                  height: 480,
                  top: 0,
                  left: 0,
                  bottom: 480,
                  right: 640,
                  x: 0,
                  y: 0,
                  toJSON: () => ({}),
                }),
              };
            }
            return null;
          },
        },
      );
    });

    const [instance] = getMockInstances();
    expect(instance).toBeTruthy();

    await act(async () => {
      instance?.resolveReady();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(instance?.loadVrmFromUrl).toHaveBeenCalledTimes(1);
    expect(instance?.setWorldUrl).toHaveBeenCalledWith(
      "/worlds/companion-day.spz",
    );

    await act(async () => {
      renderer?.update(
        <VrmViewer
          vrmPath="/vrms/eliza-1.vrm.gz"
          worldUrl="/worlds/companion-night.spz"
          mouthOpen={0}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(instance?.loadVrmFromUrl).toHaveBeenCalledTimes(1);
    expect(instance?.setWorldUrl).toHaveBeenLastCalledWith(
      "/worlds/companion-night.spz",
    );

    await act(async () => {
      renderer?.unmount();
    });
  });
});
