import { describe, expect, test } from "bun:test";
import {
  type BreakingNewsWorldEvent,
  isBreakingNewsEvent,
  selectSignificantWorldEvents,
} from "./helpers";

function buildEvent(
  overrides: Partial<BreakingNewsWorldEvent> = {},
): BreakingNewsWorldEvent {
  return {
    eventType: "status:update",
    description: "Routine market color",
    relatedQuestion: null,
    pointsToward: null,
    ...overrides,
  };
}

describe("breaking-news helpers", () => {
  test("marks keyword-driven events as significant", () => {
    expect(
      isBreakingNewsEvent(
        buildEvent({
          eventType: "deal:announced",
          description: "Two organizations finalize a strategic partnership",
        }),
      ),
    ).toBe(true);
  });

  test("marks question-linked events as significant even without keywords", () => {
    expect(
      isBreakingNewsEvent(
        buildEvent({
          eventType: "status:update",
          description: "Quiet movement around the scenario",
          relatedQuestion: 42,
        }),
      ),
    ).toBe(true);
  });

  test("excludes routine events with no significance markers", () => {
    expect(
      isBreakingNewsEvent(
        buildEvent({
          eventType: "status:update",
          description: "Routine market color",
        }),
      ),
    ).toBe(false);
  });

  test("preserves ordering when selecting significant events", () => {
    const selected = selectSignificantWorldEvents(
      [
        buildEvent({ eventType: "status:update", description: "Routine note" }),
        buildEvent({
          eventType: "announcement",
          description: "Launch planned",
        }),
        buildEvent({ relatedQuestion: 12, description: "Key question moved" }),
      ],
      2,
    );

    expect(selected).toHaveLength(2);
    expect(selected[0]?.eventType).toBe("announcement");
    expect(selected[1]?.relatedQuestion).toBe(12);
  });
});
