// @vitest-environment jsdom
//
// Rendering + interaction for the topic UI (#8928): TopicChipsBar renders a chip
// per topic and reports selection (nothing when empty); TopicGroup collapses to a
// count pill and expands on click. Real components in jsdom.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopicChipsBar } from "./TopicChipsBar";
import { TopicGroup } from "./TopicGroup";

afterEach(() => {
  cleanup();
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

  it("humanizes machine slug labels but keeps the raw slug as identity", () => {
    const onSelectTopic = vi.fn();
    render(
      <TopicChipsBar
        topics={["user_greeting", "deploy-status"]}
        onSelectTopic={onSelectTopic}
      />,
    );
    // Display is humanized …
    expect(screen.getByText("User Greeting")).toBeTruthy();
    expect(screen.getByText("Deploy Status")).toBeTruthy();
    // … while the testid (and the scroll-to lookup) stays on the raw slug.
    fireEvent.click(screen.getByTestId("topic-chip-user_greeting"));
    expect(onSelectTopic).toHaveBeenCalledWith("user_greeting");
  });

  it("keeps the chip rail scrollbar-free (touch never shows chrome)", () => {
    render(<TopicChipsBar topics={["billing", "deployment"]} />);
    const rail = screen.getByTestId("topic-chips-bar");
    // The horizontal overflow rail must hide its scrollbar on every engine:
    // Firefox (`scrollbar-width:none`) and WebKit (`::-webkit-scrollbar`).
    expect(rail.className).toContain("[scrollbar-width:none]");
    expect(rail.className).toContain("[&::-webkit-scrollbar]:hidden");
    expect(rail.className).toContain("overflow-x-auto");
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
    // Label is humanized for display; the group keeps the raw slug in data-topic.
    expect(pill.textContent).toContain("Deployment");
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

  it("humanizes the divider label while keeping data-topic raw", () => {
    render(
      <TopicGroup
        topic="deploy_status"
        count={2}
        collapsed={false}
        onCollapsedChange={() => {}}
      >
        <div data-testid="group-child">visible</div>
      </TopicGroup>,
    );
    const group = screen.getByTestId("topic-group");
    // Raw slug persists as the scroll-into-view + collapse identity.
    expect(group.getAttribute("data-topic")).toBe("deploy_status");
    // Divider shows the human label, not the slug.
    expect(screen.getByTestId("topic-group-header").textContent).toContain(
      "Deploy Status",
    );
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
