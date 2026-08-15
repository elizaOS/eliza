/** Deterministic streaming-display and exact-interruption reconciliation. */

import { describe, expect, it } from "vitest";
import {
  EMPTY_REALTIME_VOICE_DISPLAY_STATE,
  projectRealtimeVoiceDisplayMessages,
  realtimeVoiceDisplayIsAnimating,
  reduceRealtimeVoiceDisplay,
} from "./realtime-voice-display";
import type { ShellMessage } from "./shell-state";

const canonical: ShellMessage = {
  id: "assistant-1",
  role: "assistant",
  content: "The whole answer that was persisted.",
  createdAt: 1_000,
};

function stream(text: string) {
  return reduceRealtimeVoiceDisplay(EMPTY_REALTIME_VOICE_DISPLAY_STATE, {
    type: "stream",
    traceId: "trace-1",
    text,
    atMs: 1_000,
  });
}

describe("realtime voice display", () => {
  it("shows cumulative model text immediately before terminal output", () => {
    let state = stream("The answer");
    expect(projectRealtimeVoiceDisplayMessages([], state)[0]?.content).toBe(
      "The answer",
    );
    state = reduceRealtimeVoiceDisplay(state, {
      type: "stream",
      traceId: "trace-1",
      text: "The answer is arriving incrementally.",
      atMs: 1_010,
    });
    expect(projectRealtimeVoiceDisplayMessages([], state)[0]?.content).toBe(
      "The answer is arriving incrementally.",
    );
  });

  it("bounds an unexpectedly large stream snapshot before revealing it", () => {
    const longSnapshot = "B".repeat(640);
    let state = stream(longSnapshot);
    expect(projectRealtimeVoiceDisplayMessages([], state)[0]?.content).toBe(
      "B".repeat(48),
    );
    expect(realtimeVoiceDisplayIsAnimating(state)).toBe(true);
    state = reduceRealtimeVoiceDisplay(state, { type: "tick", atMs: 2_000 });
    expect(projectRealtimeVoiceDisplayMessages([], state)[0]?.content).toBe(
      "B".repeat(96),
    );
    expect(realtimeVoiceDisplayIsAnimating(state)).toBe(true);
  });

  it("binds terminal output to the exact row and keeps pacing after local playout drains", () => {
    const longAnswer = `The visible prefix ${"continues with useful detail. ".repeat(24)}`;
    const exactRow = { ...canonical, content: longAnswer };
    let state = stream("The visible prefix ");
    state = reduceRealtimeVoiceDisplay(state, {
      type: "output",
      traceId: "trace-1",
      messageId: exactRow.id,
      displayMarkdown: exactRow.content,
      speechText: exactRow.content,
      displayTruncated: false,
      atMs: 1_020,
    });
    expect(realtimeVoiceDisplayIsAnimating(state)).toBe(true);
    expect(
      projectRealtimeVoiceDisplayMessages([exactRow], state)[0],
    ).toMatchObject({ id: exactRow.id, content: "The visible prefix " });

    state = reduceRealtimeVoiceDisplay(state, {
      type: "speaking_start",
      traceId: "trace-1",
      atMs: 1_025,
    });
    state = reduceRealtimeVoiceDisplay(state, {
      type: "turn_end",
      traceId: "trace-1",
      outcome: "spoken",
      atMs: 1_030,
    });
    expect(realtimeVoiceDisplayIsAnimating(state)).toBe(true);
    state = reduceRealtimeVoiceDisplay(state, {
      type: "tick",
      atMs: 2_500,
    });
    expect(realtimeVoiceDisplayIsAnimating(state)).toBe(true);
    expect(
      projectRealtimeVoiceDisplayMessages([exactRow], state)[0]?.content,
    ).not.toBe(exactRow.content);

    state = reduceRealtimeVoiceDisplay(state, {
      type: "playback_drained",
      traceId: "trace-1",
      atMs: 2_510,
    });
    expect(realtimeVoiceDisplayIsAnimating(state)).toBe(true);
    expect(
      projectRealtimeVoiceDisplayMessages([exactRow], state)[0],
    ).toMatchObject({ id: exactRow.id });
    expect(
      projectRealtimeVoiceDisplayMessages([exactRow], state)[0]?.content,
    ).not.toBe(exactRow.content);

    state = reduceRealtimeVoiceDisplay(state, {
      type: "tick",
      atMs: 30_000,
    });
    expect(realtimeVoiceDisplayIsAnimating(state)).toBe(false);
    expect(
      projectRealtimeVoiceDisplayMessages([exactRow], state)[0],
    ).toMatchObject({ id: exactRow.id, content: exactRow.content });
  });

  it("keeps a display-only terminal response on the paced reveal clock", () => {
    const longAnswer = "D".repeat(640);
    const exactRow = { ...canonical, content: longAnswer };
    let state = reduceRealtimeVoiceDisplay(EMPTY_REALTIME_VOICE_DISPLAY_STATE, {
      type: "output",
      traceId: "trace-display-only",
      messageId: exactRow.id,
      displayMarkdown: longAnswer,
      speechText: null,
      displayTruncated: false,
      atMs: 1_000,
    });

    state = reduceRealtimeVoiceDisplay(state, {
      type: "turn_end",
      traceId: "trace-display-only",
      outcome: "displayed",
      atMs: 1_010,
    });
    expect(
      projectRealtimeVoiceDisplayMessages([exactRow], state)[0]?.content,
    ).toBe("D".repeat(48));
    expect(realtimeVoiceDisplayIsAnimating(state)).toBe(true);

    state = reduceRealtimeVoiceDisplay(state, { type: "tick", atMs: 2_010 });
    expect(
      projectRealtimeVoiceDisplayMessages([exactRow], state)[0]?.content,
    ).toBe("D".repeat(96));
    expect(realtimeVoiceDisplayIsAnimating(state)).toBe(true);
  });

  it.each(["stopped", "error", "no_response"] as const)(
    "freezes the already displayed prefix on turn_end(%s) and suppresses its hidden suffix",
    (outcome) => {
      const longAnswer = `Visible terminal prefix. ${"Hidden suffix. ".repeat(30)}`;
      const exactRow = { ...canonical, content: longAnswer };
      let state = reduceRealtimeVoiceDisplay(
        EMPTY_REALTIME_VOICE_DISPLAY_STATE,
        {
          type: "output",
          traceId: `trace-${outcome}`,
          messageId: exactRow.id,
          displayMarkdown: longAnswer,
          speechText: longAnswer,
          displayTruncated: false,
          atMs: 1_000,
        },
      );
      state = reduceRealtimeVoiceDisplay(state, {
        type: "tick",
        atMs: 1_500,
      });
      const visibleAtTerminal = state.turns[0]?.visibleText;
      expect(visibleAtTerminal).not.toBe(longAnswer);

      state = reduceRealtimeVoiceDisplay(state, {
        type: "turn_end",
        traceId: `trace-${outcome}`,
        outcome,
        atMs: 1_501,
      });
      state = reduceRealtimeVoiceDisplay(state, {
        type: "output",
        traceId: `trace-${outcome}`,
        messageId: exactRow.id,
        displayMarkdown: longAnswer,
        speechText: longAnswer,
        displayTruncated: false,
        atMs: 1_502,
      });
      state = reduceRealtimeVoiceDisplay(state, {
        type: "tick",
        atMs: 50_000,
      });

      expect(state.turns[0]).toMatchObject({
        displayMarkdown: visibleAtTerminal,
        visibleText: visibleAtTerminal,
        speechText: null,
        phase: "interrupted",
        serverOutcome: outcome,
      });
      expect(
        projectRealtimeVoiceDisplayMessages([exactRow], state)[0],
      ).toMatchObject({
        content: visibleAtTerminal,
        interrupted: true,
      });
    },
  );

  it("suppresses an interrupted canonical row when no assistant text was ever displayed", () => {
    let state = reduceRealtimeVoiceDisplay(EMPTY_REALTIME_VOICE_DISPLAY_STATE, {
      type: "output",
      traceId: "trace-empty-error",
      messageId: canonical.id,
      displayMarkdown: "",
      speechText: null,
      displayTruncated: false,
      atMs: 1_000,
    });
    state = reduceRealtimeVoiceDisplay(state, {
      type: "turn_end",
      traceId: "trace-empty-error",
      outcome: "error",
      atMs: 1_001,
    });

    expect(projectRealtimeVoiceDisplayMessages([canonical], state)).toEqual([]);
  });

  it("never dumps a long terminal-only response into an empty overlay", () => {
    const longAnswer = "A".repeat(640);
    const state = reduceRealtimeVoiceDisplay(
      EMPTY_REALTIME_VOICE_DISPLAY_STATE,
      {
        type: "output",
        traceId: "trace-terminal-only",
        messageId: "assistant-terminal-only",
        displayMarkdown: longAnswer,
        speechText: longAnswer,
        displayTruncated: false,
        atMs: 1_000,
      },
    );
    const projected = projectRealtimeVoiceDisplayMessages(
      [
        {
          ...canonical,
          id: "assistant-terminal-only",
          content: longAnswer,
        },
      ],
      state,
    );
    expect(projected[0]?.content).toHaveLength(48);
    expect(projected[0]?.content).not.toBe(longAnswer);
    expect(realtimeVoiceDisplayIsAnimating(state)).toBe(true);
  });

  it("freezes the exact streamed prefix and rejects late text after interruption", () => {
    let state = stream("The visible prefix");
    state = reduceRealtimeVoiceDisplay(state, {
      type: "interrupted",
      traceId: "trace-1",
      atMs: 1_010,
    });
    state = reduceRealtimeVoiceDisplay(state, {
      type: "stream",
      traceId: "trace-1",
      text: "The visible prefix plus an unheard remainder.",
      atMs: 1_020,
    });
    state = reduceRealtimeVoiceDisplay(state, {
      type: "output",
      traceId: "trace-1",
      messageId: canonical.id,
      displayMarkdown: canonical.content,
      speechText: canonical.content,
      displayTruncated: false,
      atMs: 1_030,
    });
    expect(
      projectRealtimeVoiceDisplayMessages([canonical], state)[0],
    ).toMatchObject({ content: "The visible prefix", interrupted: true });
  });

  it("freezes during a terminal reveal and ignores every later tick", () => {
    const longAnswer = `Visible start. ${"Unheard remainder. ".repeat(30)}`;
    let state = stream("Visible start. ");
    state = reduceRealtimeVoiceDisplay(state, {
      type: "output",
      traceId: "trace-1",
      messageId: canonical.id,
      displayMarkdown: longAnswer,
      speechText: longAnswer,
      displayTruncated: false,
      atMs: 1_010,
    });
    state = reduceRealtimeVoiceDisplay(state, { type: "tick", atMs: 1_110 });
    const visibleAtCut = state.turns[0]?.visibleText;
    expect(visibleAtCut?.length).toBeGreaterThan("Visible start. ".length);
    expect(visibleAtCut).not.toBe(longAnswer);
    state = reduceRealtimeVoiceDisplay(state, {
      type: "interrupted",
      traceId: "trace-1",
      atMs: 1_111,
    });
    state = reduceRealtimeVoiceDisplay(state, { type: "tick", atMs: 9_999 });
    expect(state.turns[0]?.visibleText).toBe(visibleAtCut);
    expect(state.turns[0]?.phase).toBe("interrupted");
  });

  it("masks an already-resynced canonical row before terminal message ownership arrives", () => {
    const fullAnswer =
      "The streamed prefix has a much longer persisted remainder.";
    const state = stream("The streamed prefix");
    const projected = projectRealtimeVoiceDisplayMessages(
      [{ ...canonical, content: fullAnswer }],
      state,
    );
    expect(projected).toHaveLength(1);
    expect(projected[0]?.content).toBe("The streamed prefix");
  });

  it("never lets a different same-text row steal exact message ownership", () => {
    const older = { ...canonical, id: "assistant-older", createdAt: 100 };
    let state = stream(canonical.content);
    state = reduceRealtimeVoiceDisplay(state, {
      type: "output",
      traceId: "trace-1",
      messageId: canonical.id,
      displayMarkdown: canonical.content,
      speechText: canonical.content,
      displayTruncated: false,
      atMs: 1_020,
    });
    const projected = projectRealtimeVoiceDisplayMessages(
      [older, canonical],
      state,
    );
    expect(projected[0]).toBe(older);
    expect(projected[1]?.content).toBe(canonical.content);
  });

  it("fails safe onto the newest matching canonical row for legacy output", () => {
    const prefix = "A".repeat(32_768);
    const older = {
      ...canonical,
      id: "assistant-older",
      content: `${prefix} old suffix`,
      createdAt: 100,
    };
    const latest = {
      ...canonical,
      id: "assistant-latest",
      content: `${prefix} current suffix`,
    };
    const state = reduceRealtimeVoiceDisplay(
      EMPTY_REALTIME_VOICE_DISPLAY_STATE,
      {
        type: "output",
        traceId: "trace-legacy",
        displayMarkdown: prefix,
        speechText: "A safe spoken summary.",
        displayTruncated: true,
        atMs: 1_000,
      },
    );
    const projected = projectRealtimeVoiceDisplayMessages(
      [older, latest],
      state,
    );
    expect(projected[0]).toBe(older);
    expect(projected[1]?.content).toBe(prefix.slice(0, 48));
  });

  it("freezes the active response on confirmed user speech even without an exact interrupt frame", () => {
    const longAnswer = `Visible response. ${"Unheard detail. ".repeat(20)}`;
    let state = reduceRealtimeVoiceDisplay(EMPTY_REALTIME_VOICE_DISPLAY_STATE, {
      type: "output",
      traceId: "trace-old",
      messageId: "assistant-old",
      displayMarkdown: longAnswer,
      speechText: longAnswer,
      displayTruncated: false,
      atMs: 1_000,
    });
    state = reduceRealtimeVoiceDisplay(state, {
      type: "speaking_start",
      traceId: "trace-old",
      atMs: 1_010,
    });
    state = reduceRealtimeVoiceDisplay(state, { type: "tick", atMs: 1_510 });
    const visibleAtCut = state.turns[0]?.visibleText;

    state = reduceRealtimeVoiceDisplay(state, {
      type: "user_speech",
      atMs: 1_511,
    });
    state = reduceRealtimeVoiceDisplay(state, { type: "tick", atMs: 9_999 });

    expect(state.turns[0]).toMatchObject({
      traceId: "trace-old",
      visibleText: visibleAtCut,
      phase: "interrupted",
      playbackActive: false,
    });
  });

  it("retains the frozen old response while the replacement turn arrives", () => {
    const oldAnswer = `Old visible answer. ${"Old hidden text. ".repeat(20)}`;
    let state = reduceRealtimeVoiceDisplay(EMPTY_REALTIME_VOICE_DISPLAY_STATE, {
      type: "output",
      traceId: "trace-old",
      messageId: "assistant-old",
      displayMarkdown: oldAnswer,
      speechText: oldAnswer,
      displayTruncated: false,
      atMs: 1_000,
    });
    state = reduceRealtimeVoiceDisplay(state, {
      type: "speaking_start",
      traceId: "trace-old",
      atMs: 1_010,
    });
    state = reduceRealtimeVoiceDisplay(state, { type: "tick", atMs: 1_510 });
    state = reduceRealtimeVoiceDisplay(state, {
      type: "interrupted",
      traceId: "trace-old",
      atMs: 1_511,
    });
    const frozenOld = state.turns[0]?.visibleText;

    // Ink may attribute the first partial to the old response until the new
    // final transcript receives its own response trace. This must be harmless.
    state = reduceRealtimeVoiceDisplay(state, {
      type: "user_speech",
      atMs: 1_512,
    });
    state = reduceRealtimeVoiceDisplay(state, {
      type: "output",
      traceId: "trace-new",
      messageId: "assistant-new",
      displayMarkdown: "pineapple",
      speechText: "pineapple",
      displayTruncated: false,
      atMs: 2_000,
    });
    state = reduceRealtimeVoiceDisplay(state, {
      type: "output",
      traceId: "trace-old",
      messageId: "assistant-old",
      displayMarkdown: oldAnswer,
      speechText: oldAnswer,
      displayTruncated: false,
      atMs: 2_010,
    });

    expect(state.turns).toHaveLength(2);
    expect(state.turns[0]).toMatchObject({
      traceId: "trace-old",
      visibleText: frozenOld,
      phase: "interrupted",
    });
    expect(state.turns[1]).toMatchObject({
      traceId: "trace-new",
      visibleText: "pineapple",
      phase: "pending",
    });
  });

  it("retains every frozen canonical prefix while its conversation remains active", () => {
    let state = EMPTY_REALTIME_VOICE_DISPLAY_STATE;
    const canonicalRows: ShellMessage[] = [];
    const frozenPrefixes = new Map<string, string>();

    for (let index = 1; index <= 6; index += 1) {
      const traceId = `trace-interrupted-${index}`;
      const messageId = `assistant-interrupted-${index}`;
      const fullAnswer = `Answer ${index}: ${"hidden canonical suffix ".repeat(8)}`;
      canonicalRows.push({
        id: messageId,
        role: "assistant",
        content: fullAnswer,
        createdAt: index,
      });
      state = reduceRealtimeVoiceDisplay(state, {
        type: "output",
        traceId,
        messageId,
        displayMarkdown: fullAnswer,
        speechText: fullAnswer,
        displayTruncated: false,
        atMs: index * 1_000,
      });
      const visibleText = state.turns.find(
        (turn) => turn.traceId === traceId,
      )?.visibleText;
      expect(visibleText).toBeTruthy();
      expect(visibleText).not.toBe(fullAnswer);
      frozenPrefixes.set(messageId, visibleText as string);
      state = reduceRealtimeVoiceDisplay(state, {
        type: "interrupted",
        traceId,
        atMs: index * 1_000 + 1,
      });
    }

    expect(state.turns).toHaveLength(canonicalRows.length);
    const projected = projectRealtimeVoiceDisplayMessages(canonicalRows, state);
    expect(projected).toHaveLength(canonicalRows.length);
    for (const message of projected) {
      expect(message).toMatchObject({
        content: frozenPrefixes.get(message.id),
        interrupted: true,
      });
    }
  });

  it("still marks a fully revealed but audibly playing answer interrupted", () => {
    let state = stream("A short complete answer.");
    state = reduceRealtimeVoiceDisplay(state, {
      type: "speaking_start",
      traceId: "trace-1",
      atMs: 1_010,
    });
    expect(state.turns[0]?.phase).toBe("speaking");
    state = reduceRealtimeVoiceDisplay(state, {
      type: "user_speech",
      atMs: 1_020,
    });
    expect(state.turns[0]).toMatchObject({
      phase: "interrupted",
      playbackActive: false,
    });
  });

  it("keeps a completed projection stable until the next voice response", () => {
    let state = stream("First response.");
    state = reduceRealtimeVoiceDisplay(state, {
      type: "turn_end",
      traceId: "trace-1",
      outcome: "spoken",
      atMs: 1_100,
    });
    expect(projectRealtimeVoiceDisplayMessages([], state)[0]?.content).toBe(
      "First response.",
    );
    state = reduceRealtimeVoiceDisplay(state, {
      type: "interrupted",
      traceId: "trace-1",
      atMs: 1_101,
    });
    expect(state.turns[0]?.phase).toBe("complete");
    expect(projectRealtimeVoiceDisplayMessages([], state)[0]).toMatchObject({
      content: "First response.",
      interrupted: false,
    });
    state = reduceRealtimeVoiceDisplay(state, {
      type: "stream",
      traceId: "trace-2",
      text: "Second response.",
      atMs: 2_000,
    });
    expect(projectRealtimeVoiceDisplayMessages([], state)).toHaveLength(1);
    expect(projectRealtimeVoiceDisplayMessages([], state)[0]?.content).toBe(
      "Second response.",
    );
  });
});
