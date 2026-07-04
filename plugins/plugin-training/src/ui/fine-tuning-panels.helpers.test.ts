// Exercises fine-tuning dashboard helper behavior.
import { describe, expect, it } from "vitest";
import {
  asTrainingEvent,
  formatDate,
  formatProgress,
  summarizeAvailability,
} from "./fine-tuning-panels.helpers.js";

/**
 * Fine-tuning panel formatters + the training-event parser. The parser is the
 * trust boundary for streamed envelopes — it must reject anything that isn't a
 * well-formed training_event so the dashboard never renders garbage.
 */

describe("formatProgress", () => {
  it("clamps to 0..1 and renders a whole percent", () => {
    expect(formatProgress(0.5)).toBe("50%");
    expect(formatProgress(0)).toBe("0%");
    expect(formatProgress(1)).toBe("100%");
    expect(formatProgress(-1)).toBe("0%");
    expect(formatProgress(2)).toBe("100%");
    expect(formatProgress(0.333)).toBe("33%");
  });
});

describe("formatDate", () => {
  it("handles null and invalid input deterministically", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("not-a-date")).toBe("not-a-date");
  });
});

describe("asTrainingEvent", () => {
  const valid = {
    type: "training_event" as const,
    payload: {
      kind: "job_progress",
      ts: 123,
      message: "halfway",
      progress: 0.5,
    },
  };

  it("parses a well-formed training_event and carries optional fields", () => {
    const out = asTrainingEvent(valid);
    expect(out).toMatchObject({
      kind: "job_progress",
      ts: 123,
      message: "halfway",
      progress: 0.5,
    });
  });

  it("rejects wrong type, unknown kind, or missing required fields", () => {
    expect(
      asTrainingEvent({ type: "other", payload: valid.payload }),
    ).toBeNull();
    expect(
      asTrainingEvent({
        type: "training_event",
        payload: { kind: "bogus", ts: 1, message: "x" },
      }),
    ).toBeNull();
    expect(
      asTrainingEvent({
        type: "training_event",
        payload: { kind: "job_log", message: "x" },
      }),
    ).toBeNull(); // missing ts
    expect(
      asTrainingEvent({ type: "training_event", payload: null }),
    ).toBeNull();
  });
});

describe("summarizeAvailability", () => {
  const t = (k: string) => k;
  it("maps known reasons to i18n keys, passes unknown reasons through", () => {
    expect(summarizeAvailability(undefined, t)).toBe(
      "finetuningview.Unavailable",
    );
    expect(summarizeAvailability("runtime_not_started", t)).toBe(
      "finetuningview.RuntimeNotStarted",
    );
    expect(summarizeAvailability("trajectories_table_missing", t)).toBe(
      "finetuningview.NoTrajectoriesTableFound",
    );
    expect(summarizeAvailability("some other reason", t)).toBe(
      "some other reason",
    );
  });
});
