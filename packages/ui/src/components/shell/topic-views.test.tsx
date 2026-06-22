// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationUndoToast } from "./ConversationUndoToast";
import {
  dismissConversationUndo,
  getConversationUndoSnapshot,
  showConversationUndo,
} from "./conversation-undo-store";
import { TopicChipsBar } from "./TopicChipsBar";
import { TopicGroup } from "./TopicGroup";

afterEach(() => {
  cleanup();
  dismissConversationUndo();
});

describe("TopicChipsBar", () => {
  it("renders a chip per topic and reports selection", () => {
    const onSelectTopic = vi.fn();
    render(
      <TopicChipsBar
        topics={["billing", "deployment"]}
        onSelectTopic={onSelectTopic}
      />,
    );
    fireEvent.click(screen.getByTestId("topic-chip-deployment"));
    expect(onSelectTopic).toHaveBeenCalledWith("deployment");
  });

  it("renders nothing when there are no topics", () => {
    const { container } = render(<TopicChipsBar topics={[]} />);
    expect(
      container.querySelector('[data-testid="topic-chips-bar"]'),
    ).toBeNull();
  });
});

describe("TopicGroup", () => {
  it("shows a collapsed pill with the count and expands on click", () => {
    const onCollapsedChange = vi.fn();
    render(
      <TopicGroup
        topic="deployment"
        count={12}
        collapsed
        onCollapsedChange={onCollapsedChange}
      >
        <div data-testid="group-child">hidden</div>
      </TopicGroup>,
    );
    const pill = screen.getByTestId("topic-group-pill");
    expect(pill.textContent).toContain("deployment");
    expect(pill.textContent).toContain("12 messages");
    // Children are hidden while collapsed.
    expect(screen.queryByTestId("group-child")).toBeNull();
    fireEvent.click(pill);
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it("renders children + a divider header when expanded", () => {
    render(
      <TopicGroup
        topic="billing"
        count={2}
        collapsed={false}
        onCollapsedChange={() => {}}
      >
        <div data-testid="group-child">visible</div>
      </TopicGroup>,
    );
    expect(screen.getByTestId("group-child")).toBeTruthy();
    expect(screen.getByTestId("topic-group-header")).toBeTruthy();
  });

  it("renders an untitled run with no header/pill", () => {
    render(
      <TopicGroup
        topic={null}
        count={1}
        collapsed={false}
        onCollapsedChange={() => {}}
      >
        <div data-testid="group-child">bare</div>
      </TopicGroup>,
    );
    expect(screen.getByTestId("topic-group-untitled")).toBeTruthy();
    expect(screen.queryByTestId("topic-group-header")).toBeNull();
  });
});

describe("ConversationUndoToast", () => {
  it("shows the label + action and restores on Undo", () => {
    const onUndo = vi.fn();
    render(<ConversationUndoToast />);
    expect(screen.queryByTestId("conversation-undo-toast")).toBeNull();
    act(() => {
      showConversationUndo({
        label: "Conversation cleared",
        actionLabel: "Undo",
        onUndo,
      });
    });
    const button = screen.getByTestId("conversation-undo-button");
    expect(button.textContent).toBe("Undo");
    expect(screen.getByTestId("conversation-undo-toast").textContent).toContain(
      "Conversation cleared",
    );
    act(() => {
      fireEvent.click(button);
    });
    expect(onUndo).toHaveBeenCalledOnce();
    // Dismissed after undo (store is the source of truth; the toast then
    // exit-animates out of the DOM).
    expect(getConversationUndoSnapshot()).toBeNull();
  });
});
