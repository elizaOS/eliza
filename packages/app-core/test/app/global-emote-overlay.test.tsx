// @vitest-environment jsdom

import { APP_EMOTE_EVENT } from "@elizaos/app-core/events";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalEmoteOverlay } from "../../src/components/GlobalEmoteOverlay";

describe("GlobalEmoteOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows an emoji burst for app-wide emote events and fades it out", async () => {
    let tree: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(GlobalEmoteOverlay));
    });

    expect(
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "global-emote-overlay",
      ),
    ).toHaveLength(0);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(APP_EMOTE_EVENT, {
          detail: {
            emoteId: "wave",
            path: "/animations/emotes/waving-both-hands.glb",
            duration: 2.5,
            loop: false,
          },
        }),
      );
    });

    const overlaysAfterEvent =
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "global-emote-overlay",
      ) ?? [];
    expect(overlaysAfterEvent).toHaveLength(1);
    expect(overlaysAfterEvent[0]?.props["data-emote-id"]).toBe("wave");
    expect(
      tree?.root.findAll(
        (node) =>
          typeof node.props.className === "string" &&
          node.props.className.includes("text-[88px]") &&
          node.props.className.includes("h-32") &&
          node.props.className.includes("w-32"),
      ),
    ).toHaveLength(1);
    expect(
      tree?.root.findAll(
        (node) =>
          node.type === "span" &&
          node.children.some((child) => child === "\u{1F44B}"),
      ),
    ).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(2400);
    });

    expect(
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "global-emote-overlay",
      ),
    ).toHaveLength(0);
  });

  it("skips rendering the emoji burst when the emote disables overlays", async () => {
    let tree: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(GlobalEmoteOverlay));
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(APP_EMOTE_EVENT, {
          detail: {
            emoteId: "wave",
            path: "/animations/emotes/waving-both-hands.glb",
            duration: 2.5,
            loop: false,
            showOverlay: false,
          },
        }),
      );
    });

    expect(
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "global-emote-overlay",
      ),
    ).toHaveLength(0);
  });
});
