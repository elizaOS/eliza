// @vitest-environment jsdom
import React from "react";
import type { ReactTestRenderer } from "react-test-renderer";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  viewerProps: null as Record<string, unknown> | null,
}));

vi.mock("@elizaos/app-core/events", () => ({
  APP_EMOTE_EVENT: "eliza:app-emote",
  STOP_EMOTE_EVENT: "stop-emote",
}));

vi.mock("@elizaos/app-core/state", () => ({
  getVrmPreviewUrl: vi.fn(() => "/vrms/previews/eliza-1.png"),
  getVrmUrl: vi.fn(() => "/vrms/eliza-1.vrm.gz"),
  useApp: () => ({
    selectedVrmIndex: 1,
    customVrmUrl: null,
  }),
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
    return React.createElement("div", { "data-testid": "vrm-viewer" });
  },
}));

import { ChatAvatar } from "./ChatAvatar";

describe("ChatAvatar", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    testState.viewerProps = null;
    renderer = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (renderer) {
      act(() => {
        renderer?.unmount();
      });
      renderer = null;
    }
    vi.useRealTimers();
  });

  it("keeps the loader visible when avatar loading exceeds four seconds", async () => {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(ChatAvatar));
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
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(ChatAvatar));
    });

    await act(async () => {
      const onEngineState = testState.viewerProps?.onEngineState as
        | ((state: Record<string, unknown>) => void)
        | undefined;
      onEngineState?.({ vrmLoaded: false, loadError: "failed to load" });
    });

    const previewImages = renderer?.root.findAllByType("img") ?? [];
    expect(previewImages).toHaveLength(1);
    expect(previewImages[0]?.props.src).toBe("/vrms/previews/eliza-1.png");
  });
});
