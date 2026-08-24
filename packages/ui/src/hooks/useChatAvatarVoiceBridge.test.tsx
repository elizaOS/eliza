/** Verifies useChatAvatarVoiceBridge through the package's configured test harness. */
// @vitest-environment jsdom
//
// useChatAvatarVoiceBridge pushes the chat avatar's lip-sync inputs onto the
// window as CHAT_AVATAR_VOICE_EVENT and forwards speaking-state transitions
// into chat shell state via onSpeakingChange. Covers the consumer contract:
//   • every mouthOpen / isSpeaking change reaches the window event stream,
//     and idle re-renders dispatch nothing;
//   • onSpeakingChange is edge-triggered — never fired for the mount value,
//     once per actual transition, and not spooked by a callback identity change.

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHAT_AVATAR_VOICE_EVENT,
  type ChatAvatarVoiceEventDetail,
} from "../events";
import { useChatAvatarVoiceBridge } from "./useChatAvatarVoiceBridge";

function collectVoiceEvents(): {
  received: ChatAvatarVoiceEventDetail[];
  detach: () => void;
} {
  const received: ChatAvatarVoiceEventDetail[] = [];
  const listener = (event: Event) => {
    received.push((event as CustomEvent<ChatAvatarVoiceEventDetail>).detail);
  };
  window.addEventListener(CHAT_AVATAR_VOICE_EVENT, listener);
  return {
    received,
    detach: () => window.removeEventListener(CHAT_AVATAR_VOICE_EVENT, listener),
  };
}

afterEach(() => {
  cleanup();
});

describe("useChatAvatarVoiceBridge — avatar voice event stream", () => {
  it("dispatches CHAT_AVATAR_VOICE_EVENT with the mount-time mouth/speaking detail", () => {
    const { received, detach } = collectVoiceEvents();

    renderHook(() =>
      useChatAvatarVoiceBridge({
        mouthOpen: 0.25,
        isSpeaking: false,
        onSpeakingChange: vi.fn(),
      }),
    );

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ mouthOpen: 0.25, isSpeaking: false });

    detach();
  });

  it("re-dispatches when mouthOpen changes while speaking state holds", () => {
    const { received, detach } = collectVoiceEvents();

    const { rerender } = renderHook(
      ({ mouthOpen, isSpeaking }: { mouthOpen: number; isSpeaking: boolean }) =>
        useChatAvatarVoiceBridge({
          mouthOpen,
          isSpeaking,
          onSpeakingChange: vi.fn(),
        }),
      { initialProps: { mouthOpen: 0, isSpeaking: true } },
    );
    rerender({ mouthOpen: 0.6, isSpeaking: true });

    expect(received).toEqual([
      { mouthOpen: 0, isSpeaking: true },
      { mouthOpen: 0.6, isSpeaking: true },
    ]);

    detach();
  });

  it("emits exactly one combined event when mouth and speaking change in the same commit", () => {
    const { received, detach } = collectVoiceEvents();

    const { rerender } = renderHook(
      ({ mouthOpen, isSpeaking }: { mouthOpen: number; isSpeaking: boolean }) =>
        useChatAvatarVoiceBridge({
          mouthOpen,
          isSpeaking,
          onSpeakingChange: vi.fn(),
        }),
      { initialProps: { mouthOpen: 0.1, isSpeaking: false } },
    );
    rerender({ mouthOpen: 0.9, isSpeaking: true });

    // The mount dispatch plus one event for the combined commit — never two.
    expect(received).toEqual([
      { mouthOpen: 0.1, isSpeaking: false },
      { mouthOpen: 0.9, isSpeaking: true },
    ]);

    detach();
  });

  it("dispatches nothing when neither input changes between renders", () => {
    const { received, detach } = collectVoiceEvents();
    const onSpeakingChange = vi.fn();

    const { rerender } = renderHook(() =>
      useChatAvatarVoiceBridge({
        mouthOpen: 0.4,
        isSpeaking: true,
        onSpeakingChange,
      }),
    );
    rerender();
    rerender();
    rerender();

    expect(received).toHaveLength(1);
    expect(onSpeakingChange).not.toHaveBeenCalled();

    detach();
  });
});

describe("useChatAvatarVoiceBridge — speaking-state edge detection", () => {
  it("never reports the mount value and reports each real transition once", () => {
    const onSpeakingChange = vi.fn();

    const { rerender } = renderHook(
      ({ isSpeaking }: { isSpeaking: boolean }) =>
        useChatAvatarVoiceBridge({
          mouthOpen: isSpeaking ? 0.5 : 0,
          isSpeaking,
          onSpeakingChange,
        }),
      { initialProps: { isSpeaking: false } },
    );

    expect(onSpeakingChange).not.toHaveBeenCalled();

    rerender({ isSpeaking: true });
    expect(onSpeakingChange).toHaveBeenCalledTimes(1);
    expect(onSpeakingChange).toHaveBeenLastCalledWith(true);

    // Same value again: no duplicate transition report.
    rerender({ isSpeaking: true });
    expect(onSpeakingChange).toHaveBeenCalledTimes(1);

    rerender({ isSpeaking: false });
    expect(onSpeakingChange).toHaveBeenCalledTimes(2);
    expect(onSpeakingChange).toHaveBeenLastCalledWith(false);
  });

  it("does not fire a spurious transition when only the callback identity changes", () => {
    const onSpeakingChange = vi.fn();
    const replacementCallback = vi.fn();

    const { rerender } = renderHook(
      ({ cb }: { cb: (isSpeaking: boolean) => void }) =>
        useChatAvatarVoiceBridge({
          mouthOpen: 0,
          isSpeaking: false,
          onSpeakingChange: cb,
        }),
      { initialProps: { cb: onSpeakingChange } },
    );

    // New identity, same underlying speaking state — the bridge must stay quiet.
    rerender({ cb: replacementCallback });

    expect(onSpeakingChange).not.toHaveBeenCalled();
    expect(replacementCallback).not.toHaveBeenCalled();
  });
});
