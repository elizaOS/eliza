// @vitest-environment jsdom
//
// Render test for TopicGroupedTranscript: empty state, per-group header with
// message count, expand/collapse of a group's preview lines, and the
// collapsed-state toggle callback. jsdom + Testing Library over fixture groups.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type TopicGroup,
  TopicGroupedTranscript,
} from "./topic-grouped-transcript";

afterEach(cleanup);

const groups: TopicGroup[] = [
  {
    id: "g1",
    topic: "Travel",
    messageCount: 4,
    previewLines: ["Booked the flight", "Hotel confirmed"],
  },
  {
    id: "g2",
    topic: "Budget",
    messageCount: 2,
    previewLines: ["Set the cap"],
    collapsed: true,
  },
];

describe("TopicGroupedTranscript", () => {
  it("renders the empty state with no groups", () => {
    render(<TopicGroupedTranscript groups={[]} />);
    expect(
      screen.getByTestId("topic-grouped-transcript").textContent,
    ).toContain("No transcript yet");
  });

  it("renders each group header with its message count", () => {
    render(<TopicGroupedTranscript groups={groups} />);
    expect(screen.getByTestId("topic-group-g1").textContent).toContain(
      "Travel",
    );
    expect(screen.getByTestId("topic-group-g1").textContent).toContain("4 msg");
  });

  it("shows preview lines for an expanded group, hides them when collapsed", () => {
    render(<TopicGroupedTranscript groups={groups} />);
    // g1 starts expanded -> preview visible.
    expect(screen.getByTestId("topic-group-g1").textContent).toContain(
      "Booked the flight",
    );
    // g2 seeded collapsed -> preview hidden.
    expect(screen.getByTestId("topic-group-g2").textContent).not.toContain(
      "Set the cap",
    );
  });

  it("toggles a group and reports the new collapsed state", () => {
    const onToggle = vi.fn();
    render(<TopicGroupedTranscript groups={groups} onToggle={onToggle} />);
    const toggle = screen.getByTestId("topic-group-toggle-g1");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith("g1", true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("topic-group-g1").textContent).not.toContain(
      "Booked the flight",
    );
  });
});
