// @vitest-environment jsdom
/**
 * Exercises the real DOM transport and structural voice/chat adapters that feed
 * versioned transcript envelopes into native platform hosts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatToolCallEvent } from "../api";
import {
  publishNativeAgentText,
  publishNativeToolState,
} from "./chat-event-adapter";
import {
  NATIVE_TRANSCRIPT_RENDERER_EVENT,
  publishNativeTranscriptEvents,
  resetNativeTranscriptSequenceForTests,
} from "./transport";
import { nativeTranscriptInputFromVoiceServerEvent } from "./voice-event-adapter";

describe("native transcript producer transport", () => {
  beforeEach(() => resetNativeTranscriptSequenceForTests());

  it("assigns one monotonic sequence across typed batches and DOM delivery", () => {
    const seen: unknown[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<unknown>).detail);
    };
    window.addEventListener(NATIVE_TRANSCRIPT_RENDERER_EVENT, listener);
    try {
      const first = publishNativeTranscriptEvents([
        { type: "stt.partial", turnId: "t1", text: "hel" },
        { type: "stt.final", turnId: "t1", text: "hello" },
      ]);
      const second = publishNativeTranscriptEvents([
        {
          type: "agent.text",
          messageId: "m1",
          turnId: "t1",
          text: "Hi",
          final: true,
        },
      ]);

      expect(first.events.map((event) => event.seq)).toEqual([1, 2]);
      expect(second.events[0]?.seq).toBe(3);
      expect(seen).toEqual([first, second]);
    } finally {
      window.removeEventListener(NATIVE_TRANSCRIPT_RENDERER_EVENT, listener);
    }
  });

  it("maps real voice control frames using trace identity and structural phases", () => {
    expect(
      nativeTranscriptInputFromVoiceServerEvent({
        t: "stt_partial",
        traceId: "trace-1",
        text: "مرحبا 👋",
      }),
    ).toEqual({
      type: "stt.partial",
      turnId: "trace-1",
      text: "مرحبا 👋",
    });
    expect(
      nativeTranscriptInputFromVoiceServerEvent({
        t: "speaking_start",
        traceId: "trace-1",
      }),
    ).toEqual({
      type: "tts.audio",
      utteranceId: "trace-1",
      phase: "started",
    });
    expect(
      nativeTranscriptInputFromVoiceServerEvent({
        t: "interrupted",
        traceId: "trace-1",
        reason: "acoustic",
      }),
    ).toEqual({
      type: "cancel",
      scope: "turn",
      turnId: "trace-1",
      reason: "acoustic",
    });
  });

  it("maps live chat tokens and tool outcomes without text-derived behavior", () => {
    const dispatch = vi.spyOn(window, "dispatchEvent");
    publishNativeAgentText({
      messageId: "m1",
      turnId: "t1",
      text: "any length is payload",
      final: false,
    });
    const tool: ChatToolCallEvent = {
      phase: "error",
      callId: "c1",
      toolName: "SEARCH",
      error: "permission denied",
    };
    publishNativeToolState(tool, "t1");

    const first = (dispatch.mock.calls[0]?.[0] as CustomEvent).detail;
    const second = (dispatch.mock.calls[1]?.[0] as CustomEvent).detail;
    expect(first.events[0]).toMatchObject({
      type: "agent.text",
      messageId: "m1",
      final: false,
      seq: 1,
    });
    expect(second.events[0]).toMatchObject({
      type: "tool.state",
      callId: "c1",
      phase: "failed",
      detail: "permission denied",
      seq: 2,
    });
    dispatch.mockRestore();
  });
});
