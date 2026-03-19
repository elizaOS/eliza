// @vitest-environment jsdom
import React from "react";
import type { ReactTestRenderer } from "react-test-renderer";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  viewerProps: null as Record<string, unknown> | null,
}));

vi.mock("@elizaos/app-core/hooks", () => ({
  useChatAvatarVoiceState: () => ({ mouthOpen: 0, isSpeaking: false }),
  useRenderGuard: () => {},
}));

vi.mock("@elizaos/app-core/utils", () => ({
  resolveAppAssetUrl: (path: string) => path,
}));

vi.mock("./AvatarLoader", () => ({
  AvatarLoader: () => React.createElement("div", null, "AvatarLoader"),
}));

vi.mock("./avatar/VrmViewer", () => ({
  VrmViewer: (props: Record<string, unknown>) => {
    testState.viewerProps = props;
    return React.createElement("div", {
      "data-testid": "vrm-viewer",
      "data-vrm-path": props.vrmPath ?? "",
      "data-world-url": props.worldUrl ?? "",
      "data-active": String((props.active as boolean | undefined) ?? true),
    });
  },
}));

import { VrmStage } from "./VrmStage";

function getViewerNode(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    (node) => node.props["data-testid"] === "vrm-viewer",
  );
}

function renderStage(props: {
  vrmPath: string;
  worldUrl?: string;
  fallbackPreviewUrl: string;
}): React.ReactElement {
  return React.createElement(VrmStage, {
    ...props,
    t: (key: string) => key,
  });
}

describe("VrmStage", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    testState.viewerProps = null;
    renderer = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers();
    });
    if (renderer) {
      act(() => {
        renderer?.unmount();
      });
      renderer = null;
    }
    vi.useRealTimers();
  });

  it("renders a single VrmViewer with vrmPath and worldUrl", async () => {
    await act(async () => {
      renderer = TestRenderer.create(
        renderStage({
          vrmPath: "/vrms/eliza-1.vrm.gz",
          worldUrl: "/worlds/companion-day.spz",
          fallbackPreviewUrl: "/vrms/previews/eliza-1.png",
        }),
      );
    });

    const viewers = getViewerNode(renderer!);
    expect(viewers).toHaveLength(1);
    expect(viewers[0]!.props["data-vrm-path"]).toBe("/vrms/eliza-1.vrm.gz");
    expect(viewers[0]!.props["data-world-url"]).toBe(
      "/worlds/companion-day.spz",
    );
  });

  it("keeps the same single VrmViewer when vrmPath changes (world stays stable)", async () => {
    await act(async () => {
      renderer = TestRenderer.create(
        renderStage({
          vrmPath: "/vrms/eliza-1.vrm.gz",
          worldUrl: "/worlds/companion-day.spz",
          fallbackPreviewUrl: "/vrms/previews/eliza-1.png",
        }),
      );
    });

    await act(async () => {
      renderer!.update(
        renderStage({
          vrmPath: "/vrms/eliza-4.vrm.gz",
          worldUrl: "/worlds/companion-day.spz",
          fallbackPreviewUrl: "/vrms/previews/eliza-4.png",
        }),
      );
    });

    // Still only one VrmViewer — same engine, just different vrmPath
    const viewers = getViewerNode(renderer!);
    expect(viewers).toHaveLength(1);
    expect(viewers[0]!.props["data-vrm-path"]).toBe("/vrms/eliza-4.vrm.gz");
    // worldUrl stays the same — background is decoupled from character
    expect(viewers[0]!.props["data-world-url"]).toBe(
      "/worlds/companion-day.spz",
    );
  });

  it("keeps the loader visible when avatar loading exceeds four seconds", async () => {
    await act(async () => {
      renderer = TestRenderer.create(
        renderStage({
          vrmPath: "/vrms/eliza-1.vrm.gz",
          fallbackPreviewUrl: "/vrms/previews/eliza-1.png",
        }),
      );
    });

    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });

    expect(renderer?.root.findAllByType("img")).toHaveLength(0);
    expect(
      renderer?.root.findAll(
        (node) =>
          node.type === "div" &&
          Array.isArray(node.children) &&
          node.children.includes("AvatarLoader"),
      ),
    ).toHaveLength(1);
  });

  it("shows the static preview only after a real avatar load error", async () => {
    const vrmPath = "/vrms/eliza-1.vrm.gz";
    const fallbackPreviewUrl = "/vrms/previews/eliza-1.png";

    await act(async () => {
      renderer = TestRenderer.create(
        renderStage({
          vrmPath,
          fallbackPreviewUrl,
        }),
      );
    });

    await act(async () => {
      const onEngineState = testState.viewerProps?.onEngineState as
        | ((state: Record<string, unknown>) => void)
        | undefined;
      onEngineState?.({ vrmLoaded: false, loadError: "failed to load" });
    });

    const previewImages = renderer?.root.findAllByType("img") ?? [];
    expect(previewImages).toHaveLength(1);
    expect(previewImages[0]?.props.src).toBe(fallbackPreviewUrl);
  });
});
