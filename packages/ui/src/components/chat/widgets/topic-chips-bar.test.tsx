// @vitest-environment jsdom
//
// TopicChipsBar: empty state with no topics, one chip per topic with selection
// reporting, marking the active chip selected, and collapsing chips beyond
// maxVisible into a +N overflow chip. Pure jsdom render over props (no backend).

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type TopicChip, TopicChipsBar } from "./topic-chips-bar";

afterEach(cleanup);

const topics: TopicChip[] = [
  { id: "t1", label: "Travel", count: 3 },
  { id: "t2", label: "Budget", count: 1 },
  { id: "t3", label: "Health" },
];

describe("TopicChipsBar", () => {
  it("renders the empty state when there are no topics", () => {
    render(<TopicChipsBar topics={[]} />);
    expect(screen.getByTestId("topic-chips-bar").textContent).toContain(
      "No topics yet",
    );
  });

  it("renders one chip per topic and reports selection", () => {
    const onSelect = vi.fn();
    render(<TopicChipsBar topics={topics} onSelect={onSelect} />);
    expect(screen.getByTestId("topic-chip-t1").textContent).toContain("Travel");
    fireEvent.click(screen.getByTestId("topic-chip-t2"));
    expect(onSelect).toHaveBeenCalledWith("t2");
  });

  it("marks the active chip as selected", () => {
    render(<TopicChipsBar topics={topics} activeTopicId="t3" />);
    expect(
      screen.getByTestId("topic-chip-t3").getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByTestId("topic-chip-t1").getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("collapses topics beyond maxVisible into a +N overflow chip", () => {
    render(<TopicChipsBar topics={topics} maxVisible={2} />);
    expect(screen.getByTestId("topic-chip-t1")).toBeTruthy();
    expect(screen.getByTestId("topic-chip-t2")).toBeTruthy();
    expect(screen.queryByTestId("topic-chip-t3")).toBeNull();
    expect(screen.getByTestId("topic-chips-overflow").textContent).toContain(
      "+1",
    );
  });
});
