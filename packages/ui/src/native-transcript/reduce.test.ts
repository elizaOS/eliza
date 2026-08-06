/**
 * Reducer unit tests for the structural guarantees that the golden fixture
 * exercises end-to-end but that are worth pinning in isolation: dedupe is a true
 * no-op, late updates never regress a row, a partial never downgrades a final,
 * TTS playback is transient, and a very long snapshot is handled as plain text.
 * Deterministic; no I/O.
 */

import { describe, expect, it } from "vitest";
import type { TranscriptEvent } from "./contract";
import {
  applyTranscriptEvent,
  initialReducerState,
  reduceTranscriptEvents,
  toViewModel,
} from "./reduce";

function reduce(events: TranscriptEvent[]) {
  return reduceTranscriptEvents(events);
}

describe("applyTranscriptEvent", () => {
  it("treats a repeated seq as a no-op (returns the same state reference)", () => {
    const first = applyTranscriptEvent(initialReducerState(), {
      type: "stt.final",
      seq: 1,
      turnId: "t",
      text: "hi",
    });
    const again = applyTranscriptEvent(first, {
      type: "stt.partial",
      seq: 1,
      turnId: "t",
      text: "ignored",
    });
    expect(again).toBe(first);
  });

  it("does not let a partial downgrade an already-final row", () => {
    const view = reduce([
      { type: "stt.final", seq: 1, turnId: "t", text: "final" },
      { type: "stt.partial", seq: 2, turnId: "t", text: "later partial" },
    ]);
    // A higher-seq partial after a final is unusual but must not un-finalize.
    expect(view.items).toEqual([
      { kind: "user", id: "t", status: "final", text: "final", words: [] },
    ]);
  });

  it("keeps same-valued ids from different row kinds independent", () => {
    const view = reduce([
      { type: "stt.final", seq: 1, turnId: "shared", text: "question" },
      {
        type: "agent.text",
        seq: 2,
        messageId: "shared",
        text: "answer",
        final: true,
      },
      {
        type: "tool.state",
        seq: 3,
        callId: "shared",
        name: "search",
        phase: "succeeded",
      },
    ]);
    expect(view.items.map(({ kind, id }) => ({ kind, id }))).toEqual([
      { kind: "user", id: "shared" },
      { kind: "agent", id: "shared" },
      { kind: "tool", id: "shared" },
    ]);
  });

  it("does not regress completed agent or tool rows to in-flight", () => {
    const view = reduce([
      {
        type: "agent.text",
        seq: 1,
        messageId: "m",
        text: "complete",
        final: true,
      },
      {
        type: "agent.text",
        seq: 2,
        messageId: "m",
        text: "late stream",
        final: false,
      },
      {
        type: "tool.state",
        seq: 3,
        callId: "c",
        name: "search",
        phase: "succeeded",
      },
      {
        type: "tool.state",
        seq: 4,
        callId: "c",
        name: "search",
        phase: "started",
      },
    ]);
    expect(view.items).toEqual([
      {
        kind: "agent",
        id: "m",
        status: "final",
        text: "complete",
      },
      {
        kind: "tool",
        id: "c",
        status: "succeeded",
        name: "search",
      },
    ]);
  });

  it("clears the speaking indicator only when `ended` names the active utterance", () => {
    const view = reduce([
      { type: "tts.audio", seq: 1, utteranceId: "u1", phase: "started" },
      { type: "tts.audio", seq: 2, utteranceId: "u2", phase: "ended" },
    ]);
    // u2 ended does not clear u1's playback.
    expect(view.speaking).toEqual({ utteranceId: "u1" });
  });

  it("projects an empty accumulator to the designed empty view", () => {
    expect(toViewModel(initialReducerState())).toEqual({
      items: [],
      speaking: null,
      connection: "live",
      lastSeq: 0,
    });
  });

  it("carries a very long snapshot as plain text with no length bucketing", () => {
    const long = "speech ".repeat(5000).trim();
    const view = reduce([
      { type: "agent.text", seq: 1, messageId: "m", text: long, final: true },
    ]);
    expect(view.items).toEqual([
      { kind: "agent", id: "m", status: "final", text: long },
    ]);
  });

  it("advances lastSeq to the max applied seq even for dropped late events", () => {
    const view = reduce([
      { type: "stt.final", seq: 9, turnId: "t", text: "done" },
      { type: "stt.partial", seq: 4, turnId: "t", text: "late" },
    ]);
    expect(view.lastSeq).toBe(9);
  });
});
