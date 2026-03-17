// @vitest-environment jsdom
import React from "react";
import type { ReactTestInstance, ReactTestRenderer } from "react-test-renderer";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const AVATAR_SWAP_SETTLE_MS = 650;

const testState = vi.hoisted(() => ({
  viewerStatusByPath: new Map<string, { active: boolean }>(),
  viewerPropsByPath: new Map<string, Record<string, unknown>>(),
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
    const vrmPath = props.vrmPath ?? "";
    testState.viewerStatusByPath.set(vrmPath, {
      active: (props.active as boolean | undefined) ?? true,
    });
    testState.viewerPropsByPath.set(vrmPath, props);
    return React.createElement("div", {
      "data-testid": "vrm-viewer",
      "data-vrm-path": vrmPath,
      "data-active": String((props.active as boolean | undefined) ?? true),
    });
  },
}));

import { VrmStage, type VrmStageAvatarEntry } from "./VrmStage";

function getViewerNodes(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(
    (node) => node.props["data-testid"] === "vrm-viewer",
  );
}

function getActiveMap(
  renderer: ReactTestRenderer | null,
): Record<string, string> {
  if (!renderer) return {};
  return Object.fromEntries(
    getViewerNodes(renderer).map((node) => [
      String(node.props["data-vrm-path"]),
      String(node.props["data-active"]),
    ]),
  );
}

function renderStage(props: {
  vrmPath: string;
  fallbackPreviewUrl: string;
  preloadAvatars: readonly VrmStageAvatarEntry[];
}): React.ReactElement {
  return React.createElement(VrmStage, {
    ...props,
    t: (key: string) => key,
  });
}

describe("VrmStage", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    testState.viewerStatusByPath.clear();
    testState.viewerPropsByPath.clear();
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

  it("preloads additional avatars without activating them", async () => {
    const preloadAvatars: readonly VrmStageAvatarEntry[] = [
      {
        vrmPath: "/vrms/milady-4.vrm.gz",
        fallbackPreviewUrl: "/vrms/previews/milady-4.png",
      },
      {
        vrmPath: "/vrms/milady-5.vrm.gz",
        fallbackPreviewUrl: "/vrms/previews/milady-5.png",
      },
    ];

    await act(async () => {
      renderer = TestRenderer.create(
        renderStage({
          vrmPath: "/vrms/milady-1.vrm.gz",
          fallbackPreviewUrl: "/vrms/previews/milady-1.png",
          preloadAvatars,
        }),
      );
    });

    expect(getActiveMap(renderer)).toEqual({
      "/vrms/milady-1.vrm.gz": "true",
      "/vrms/milady-4.vrm.gz": "false",
      "/vrms/milady-5.vrm.gz": "false",
    });
  });

  it("keeps the outgoing avatar alive until the synced swap finishes", async () => {
    const preloadAvatars: readonly VrmStageAvatarEntry[] = [
      {
        vrmPath: "/vrms/milady-4.vrm.gz",
        fallbackPreviewUrl: "/vrms/previews/milady-4.png",
      },
    ];

    await act(async () => {
      renderer = TestRenderer.create(
        renderStage({
          vrmPath: "/vrms/milady-1.vrm.gz",
          fallbackPreviewUrl: "/vrms/previews/milady-1.png",
          preloadAvatars,
        }),
      );
    });

    await act(async () => {
      renderer.update(
        renderStage({
          vrmPath: "/vrms/milady-4.vrm.gz",
          fallbackPreviewUrl: "/vrms/previews/milady-4.png",
          preloadAvatars,
        }),
      );
    });

    expect(getActiveMap(renderer)).toEqual({
      "/vrms/milady-1.vrm.gz": "true",
      "/vrms/milady-4.vrm.gz": "true",
    });

    await act(async () => {
      vi.advanceTimersByTime(AVATAR_SWAP_SETTLE_MS);
    });

    expect(getActiveMap(renderer)).toEqual({
      "/vrms/milady-4.vrm.gz": "true",
    });
  });

  it("keeps the loader visible when avatar loading exceeds four seconds", async () => {
    await act(async () => {
      renderer = TestRenderer.create(
        renderStage({
          vrmPath: "/vrms/milady-1.vrm.gz",
          fallbackPreviewUrl: "/vrms/previews/milady-1.png",
          preloadAvatars: [],
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
    const vrmPath = "/vrms/milady-1.vrm.gz";
    const fallbackPreviewUrl = "/vrms/previews/milady-1.png";

    await act(async () => {
      renderer = TestRenderer.create(
        renderStage({
          vrmPath,
          fallbackPreviewUrl,
          preloadAvatars: [],
        }),
      );
    });

    await act(async () => {
      const onEngineState = testState.viewerPropsByPath.get(vrmPath)
        ?.onEngineState as
        | ((state: Record<string, unknown>) => void)
        | undefined;
      onEngineState?.({ vrmLoaded: false, loadError: "failed to load" });
    });

    const previewImages = renderer?.root.findAllByType("img") ?? [];
    expect(previewImages).toHaveLength(1);
    expect(previewImages[0]?.props.src).toBe(fallbackPreviewUrl);
  });
});
