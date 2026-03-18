// @vitest-environment jsdom

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

type TestWindow = Window & {
  __electrobunWindowId?: number;
};

const mockUseApp = vi.fn(() => ({
  t: (key: string) => key,
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
}));

import { StatusBar } from "../../src/components/stream/StatusBar";

function renderStatusBar() {
  let tree: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(StatusBar, {
        agentName: "Eliza",
        mode: "idle",
        viewerCount: null,
        isPip: false,
        onTogglePip: vi.fn(),
        streamAvailable: true,
        streamLive: false,
        streamLoading: false,
        onToggleStream: vi.fn(),
        volume: 100,
        muted: false,
        onVolumeChange: vi.fn(),
        onToggleMute: vi.fn(),
        destinations: [],
        activeDestination: null,
        onDestinationChange: vi.fn(),
        uptime: 0,
        frameCount: 0,
        audioSource: "",
        streamSource: { type: "stream-tab" },
        activeGameViewerUrl: "",
        onSourceChange: vi.fn(),
        onOpenSettings: vi.fn(),
      }),
    );
  });
  if (!tree) {
    throw new Error("Expected StatusBar test renderer to be created.");
  }
  return tree;
}

describe("StatusBar stream popout button", () => {
  afterEach(() => {
    delete (window as TestWindow).__electrobunWindowId;
    vi.restoreAllMocks();
  });

  it("hides the browser popout control inside Electrobun", () => {
    (window as TestWindow).__electrobunWindowId = 1;

    const tree = renderStatusBar();

    expect(
      tree.root.findAll(
        (node) =>
          node.type === "button" &&
          node.props.title === "statusbar.PopOutStreamView",
      ),
    ).toHaveLength(0);
  });

  it("keeps the browser popout control on the web", () => {
    const tree = renderStatusBar();

    expect(
      tree.root.findAll(
        (node) =>
          node.type === "button" &&
          node.props.title === "statusbar.PopOutStreamView",
      ),
    ).toHaveLength(1);
  });
});
