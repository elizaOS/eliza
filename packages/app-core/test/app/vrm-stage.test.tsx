// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const viewerPropsRef: {
  current: null | Record<string, unknown>;
} = { current: null };
let viewerRenderCount = 0;

vi.mock("@elizaos/app-core/api", () => ({
  client: {
    onWsEvent: vi.fn(() => () => {}),
  },
}));

vi.mock("@elizaos/app-core/events", () => ({
  APP_EMOTE_EVENT: "eliza:app-emote",
  CHAT_AVATAR_VOICE_EVENT: "eliza:chat-avatar-voice",
  STOP_EMOTE_EVENT: "stop-emote",
}));

vi.mock("@elizaos/app-core/utils", () => ({
  resolveAppAssetUrl: (path: string) => path,
}));

vi.mock("@elizaos/app-core/components/avatar/VrmViewer", () => ({
  VrmViewer: (props: Record<string, unknown>) => {
    viewerRenderCount++;
    viewerPropsRef.current = props;
    return React.createElement("div", null, "VrmViewer");
  },
}));

vi.mock("@elizaos/app-core/components/AvatarLoader", () => ({
  AvatarLoader: () => React.createElement("div", null, "AvatarLoader"),
}));

import { VrmStage } from "@elizaos/app-core/components/VrmStage";

describe("VrmStage", () => {
  beforeEach(() => {
    viewerPropsRef.current = null;
    viewerRenderCount = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the stage layer without a stage-level opacity gate", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(VrmStage, {
          vrmPath: "/vrms/eliza-1.vrm.gz",
          worldUrl: "/worlds/companion-day.spz",
          fallbackPreviewUrl: "/vrms/previews/eliza-1.png",
          t: (key: string) => key,
        }),
      );
    });

    expect(tree).not.toBeNull();
    const stageLayer = tree?.root.find(
      (node) =>
        node.type === "div" &&
        node.props.style &&
        Object.hasOwn(node.props.style, "opacity"),
    );
    expect(stageLayer?.props.style.opacity).toBe(1);
  });

  it("passes the shared chat voice state through to the companion avatar", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(VrmStage, {
          vrmPath: "/vrms/eliza-1.vrm.gz",
          fallbackPreviewUrl: "/vrms/previews/eliza-1.png",
          t: (key: string) => key,
        }),
      );
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("eliza:chat-avatar-voice", {
          detail: { mouthOpen: 0.42, isSpeaking: false },
        }),
      );
    });

    expect(tree).not.toBeNull();
    expect(viewerPropsRef.current).toMatchObject({
      mouthOpen: 0.42,
      isSpeaking: false,
    });
  });

  it("ignores duplicate chat voice events with the same payload", async () => {
    await act(async () => {
      TestRenderer.create(
        React.createElement(VrmStage, {
          vrmPath: "/vrms/eliza-1.vrm.gz",
          fallbackPreviewUrl: "/vrms/previews/eliza-1.png",
          t: (key: string) => key,
        }),
      );
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("eliza:chat-avatar-voice", {
          detail: { mouthOpen: 0.4, isSpeaking: false },
        }),
      );
    });

    const renderCountAfterFirstEvent = viewerRenderCount;

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("eliza:chat-avatar-voice", {
          detail: { mouthOpen: 0.4, isSpeaking: false },
        }),
      );
    });

    expect(viewerRenderCount).toBe(renderCountAfterFirstEvent);
  });

  it("disables canvas parallax and forwards the ready engine callback", async () => {
    const handleEngineReady = vi.fn();
    const setPaused = vi.fn();
    const setCameraAnimation = vi.fn();
    const setPointerParallaxEnabled = vi.fn();
    const engine = {
      setPaused,
      setCameraAnimation,
      setPointerParallaxEnabled,
    };

    await act(async () => {
      TestRenderer.create(
        React.createElement(VrmStage, {
          vrmPath: "/vrms/eliza-1.vrm.gz",
          fallbackPreviewUrl: "/vrms/previews/eliza-1.png",
          onEngineReady: handleEngineReady,
          t: (key: string) => key,
        }),
      );
    });

    expect(viewerPropsRef.current).not.toBeNull();
    expect(viewerPropsRef.current?.pointerParallax).toBeUndefined();

    await act(async () => {
      const ready = viewerPropsRef.current?.onEngineReady as
        | ((value: unknown) => void)
        | undefined;
      ready?.(engine);
    });

    expect(setPaused).toHaveBeenCalledWith(false);
    expect(setCameraAnimation).toHaveBeenCalledTimes(1);
    expect(setPointerParallaxEnabled).toHaveBeenCalledWith(false);
    expect(handleEngineReady).toHaveBeenCalledWith(engine);
  });

  it("plays emotes from the shared app emote event", async () => {
    const playEmote = vi.fn();
    const engine = {
      playEmote,
      setPaused: vi.fn(),
      setCameraAnimation: vi.fn(),
      setPointerParallaxEnabled: vi.fn(),
    };

    await act(async () => {
      TestRenderer.create(
        React.createElement(VrmStage, {
          vrmPath: "/vrms/eliza-1.vrm.gz",
          fallbackPreviewUrl: "/vrms/previews/eliza-1.png",
          t: (key: string) => key,
        }),
      );
    });

    await act(async () => {
      const ready = viewerPropsRef.current?.onEngineReady as
        | ((value: unknown) => void)
        | undefined;
      const state = viewerPropsRef.current?.onEngineState as
        | ((value: unknown) => void)
        | undefined;
      ready?.(engine);
      state?.({ vrmLoaded: true });
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("eliza:app-emote", {
          detail: {
            emoteId: "wave",
            path: "/animations/emotes/waving-both-hands.glb",
            duration: 2.5,
            loop: false,
          },
        }),
      );
    });

    expect(playEmote).toHaveBeenCalledWith(
      "/animations/emotes/waving-both-hands.glb",
      2.5,
      false,
    );
  });

  it("waves after the initial avatar reveal starts when enabled", async () => {
    vi.useFakeTimers();
    const playEmote = vi.fn();
    const engine = {
      playEmote,
      setPaused: vi.fn(),
      setCameraAnimation: vi.fn(),
      setPointerParallaxEnabled: vi.fn(),
    };

    let tree: TestRenderer.ReactTestRenderer | null = null;

    try {
      await act(async () => {
        tree = TestRenderer.create(
          React.createElement(VrmStage, {
            vrmPath: "/vrms/eliza-1.vrm.gz",
            fallbackPreviewUrl: "/vrms/previews/eliza-1.png",
            playWaveOnAvatarChange: true,
            t: (key: string) => key,
          }),
        );
      });

      await act(async () => {
        const ready = viewerPropsRef.current?.onEngineReady as
          | ((value: unknown) => void)
          | undefined;
        ready?.(engine);
      });

      await act(async () => {
        const onRevealStart = viewerPropsRef.current?.onRevealStart as
          | (() => void)
          | undefined;
        onRevealStart?.();
      });

      expect(playEmote).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(650);
      });

      expect(playEmote).toHaveBeenCalledTimes(1);
      expect(playEmote).toHaveBeenCalledWith(
        "/animations/emotes/waving-both-hands.glb",
        2.5,
        false,
      );
    } finally {
      await act(async () => {
        tree?.unmount();
      });
    }
  });

  it("waves after the avatar reveal starts when the stage switches characters", async () => {
    vi.useFakeTimers();
    const playEmote = vi.fn();
    const engine = {
      playEmote,
      setPaused: vi.fn(),
      setCameraAnimation: vi.fn(),
      setPointerParallaxEnabled: vi.fn(),
    };

    let tree: TestRenderer.ReactTestRenderer | null = null;

    try {
      await act(async () => {
        tree = TestRenderer.create(
          React.createElement(VrmStage, {
            vrmPath: "/vrms/eliza-1.vrm.gz",
            fallbackPreviewUrl: "/vrms/previews/eliza-1.png",
            playWaveOnAvatarChange: true,
            t: (key: string) => key,
          }),
        );
      });

      await act(async () => {
        const ready = viewerPropsRef.current?.onEngineReady as
          | ((value: unknown) => void)
          | undefined;
        ready?.(engine);
      });

      await act(async () => {
        tree?.update(
          React.createElement(VrmStage, {
            vrmPath: "/vrms/eliza-2.vrm.gz",
            fallbackPreviewUrl: "/vrms/previews/eliza-2.png",
            playWaveOnAvatarChange: true,
            t: (key: string) => key,
          }),
        );
      });

      await act(async () => {
        const onRevealStart = viewerPropsRef.current?.onRevealStart as
          | (() => void)
          | undefined;
        onRevealStart?.();
      });

      expect(playEmote).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(649);
      });

      expect(playEmote).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(1);
      });

      expect(playEmote).toHaveBeenCalledTimes(1);
      expect(playEmote).toHaveBeenCalledWith(
        "/animations/emotes/waving-both-hands.glb",
        2.5,
        false,
      );
    } finally {
      await act(async () => {
        tree?.unmount();
      });
    }
  });
});
