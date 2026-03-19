// @vitest-environment jsdom

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseApp = vi.fn();

vi.mock("@elizaos/app-core/hooks", () => ({
  useRenderGuard: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
  getVrmPreviewUrl: () => "/vrms/previews/milady-1.png",
  getVrmUrl: () => "/vrms/milady-1.vrm.gz",
  VRM_COUNT: 24,
}));

vi.mock("@elizaos/app-core/utils", () => ({
  resolveAppAssetUrl: (value: string) => value,
}));

vi.mock("../../src/components/VrmStage.js", () => ({
  VrmStage: () =>
    React.createElement("div", { "data-testid": "companion-vrm-stage" }),
}));

import { CompanionSceneHost } from "@elizaos/app-core/components/CompanionSceneHost";

describe("CompanionSceneHost", () => {
  beforeEach(() => {
    mockUseApp.mockReturnValue({
      selectedVrmIndex: 1,
      customVrmUrl: "",
      uiTheme: "light",
      t: (key: string) => key,
      tab: "chat",
    });

    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
      },
      configurable: true,
      writable: true,
    });

    Object.defineProperty(globalThis, "window", {
      value: {
        innerWidth: 1440,
        innerHeight: 900,
      },
      configurable: true,
    });
  });

  it("binds drag capture handlers to the drag surface instead of the root shell", () => {
    let tree: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      tree = TestRenderer.create(
        <CompanionSceneHost active>
          <div data-testid="companion-child">child</div>
        </CompanionSceneHost>,
      );
    });

    const root = tree?.root.findByProps({ "data-testid": "companion-root" });
    const dragSurface = tree?.root.findByProps({
      "data-testid": "companion-camera-drag-surface",
    });

    expect(root.props.onPointerDownCapture).toBeUndefined();
    expect(root.props.onPointerMoveCapture).toBeUndefined();
    expect(root.props.onWheelCapture).toBeUndefined();

    expect(typeof dragSurface.props.onPointerDownCapture).toBe("function");
    expect(typeof dragSurface.props.onPointerMoveCapture).toBe("function");
    expect(typeof dragSurface.props.onPointerUpCapture).toBe("function");
    expect(typeof dragSurface.props.onWheelCapture).toBe("function");
  });
});
