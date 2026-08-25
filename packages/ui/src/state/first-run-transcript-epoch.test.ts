/** Verifies first-run transcript mount authority is scoped to one epoch. */

import { describe, expect, it } from "vitest";
import {
  createFirstRunTranscriptEpoch,
  observeFirstRunTranscriptEpoch,
} from "./first-run-transcript-epoch";

const staleTurn = { id: "first-run:greeting", source: "first_run" };

describe("first-run transcript epochs", () => {
  it("does not authorize a stale synthetic turn present at epoch entry", () => {
    let state = createFirstRunTranscriptEpoch([staleTurn], false);
    state = observeFirstRunTranscriptEpoch(state, [staleTurn], true);
    state = observeFirstRunTranscriptEpoch(state, [staleTurn], true);

    expect(state.transcriptMounted).toBe(false);
  });

  it("authorizes only a new first-run turn committed in the active epoch", () => {
    let state = createFirstRunTranscriptEpoch([staleTurn], false);
    state = observeFirstRunTranscriptEpoch(state, [staleTurn], true);
    state = observeFirstRunTranscriptEpoch(
      state,
      [staleTurn, { id: "first-run:runtime", source: "first_run" }],
      true,
    );

    expect(state.transcriptMounted).toBe(true);
  });

  it("requires another new turn after a completed epoch resets", () => {
    let state = createFirstRunTranscriptEpoch([], true);
    state = observeFirstRunTranscriptEpoch(
      state,
      [{ id: "first-run:runtime", source: "first_run" }],
      true,
    );
    expect(state.transcriptMounted).toBe(true);

    state = observeFirstRunTranscriptEpoch(state, [staleTurn], false);
    state = observeFirstRunTranscriptEpoch(state, [staleTurn], true);
    expect(state.transcriptMounted).toBe(false);

    state = observeFirstRunTranscriptEpoch(
      state,
      [staleTurn, { id: "first-run:provider", source: "first_run" }],
      true,
    );
    expect(state.transcriptMounted).toBe(true);
  });
});
