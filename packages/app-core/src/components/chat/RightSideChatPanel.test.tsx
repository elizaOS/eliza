// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RightSideChatPanel } from "./RightSideChatPanel";

const STORAGE_KEY = "test-panel-state";

describe("RightSideChatPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("renders children when not collapsed", () => {
    render(
      <RightSideChatPanel storageKey={STORAGE_KEY}>
        <div>panel content</div>
      </RightSideChatPanel>,
    );
    expect(screen.getByText("panel content")).toBeTruthy();
  });

  it("hides children when collapsed by default", () => {
    render(
      <RightSideChatPanel storageKey={STORAGE_KEY} collapsedByDefault>
        <div>panel content</div>
      </RightSideChatPanel>,
    );
    expect(screen.queryByText("panel content")).toBeNull();
  });

  it("collapses on collapse button click and hides children", () => {
    render(
      <RightSideChatPanel storageKey={STORAGE_KEY}>
        <div>panel content</div>
      </RightSideChatPanel>,
    );

    expect(screen.getByText("panel content")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Collapse panel" }));

    expect(screen.queryByText("panel content")).toBeNull();
  });

  it("expands after collapse on expand button click", () => {
    render(
      <RightSideChatPanel storageKey={STORAGE_KEY} collapsedByDefault>
        <div>panel content</div>
      </RightSideChatPanel>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand panel" }));

    expect(screen.getByText("panel content")).toBeTruthy();
  });

  it("persists collapsed state to localStorage", () => {
    render(
      <RightSideChatPanel storageKey={STORAGE_KEY}>
        <div>panel content</div>
      </RightSideChatPanel>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Collapse panel" }));

    const stored = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "{}",
    ) as { collapsed?: boolean };
    expect(stored.collapsed).toBe(true);
  });

  it("calls onCollapsedChange when collapsing", () => {
    const onCollapsedChange = vi.fn();
    render(
      <RightSideChatPanel
        storageKey={STORAGE_KEY}
        onCollapsedChange={onCollapsedChange}
      >
        <div>panel content</div>
      </RightSideChatPanel>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Collapse panel" }));

    expect(onCollapsedChange).toHaveBeenCalledWith(true);
  });

  it("hydrates collapsed state from localStorage", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ width: 384, collapsed: true }),
    );

    render(
      <RightSideChatPanel storageKey={STORAGE_KEY}>
        <div>panel content</div>
      </RightSideChatPanel>,
    );

    // Children should be hidden because localStorage says collapsed
    expect(screen.queryByText("panel content")).toBeNull();
  });

  it("keyboard [ toggles collapse when panel receives keydown", () => {
    const { container } = render(
      <RightSideChatPanel storageKey={STORAGE_KEY}>
        <div>panel content</div>
      </RightSideChatPanel>,
    );

    // The outer panel div is the first child of the container
    const panel = container.firstElementChild as HTMLElement;

    fireEvent.keyDown(panel, { key: "[" });

    expect(screen.queryByText("panel content")).toBeNull();

    fireEvent.keyDown(panel, { key: "[" });

    expect(screen.getByText("panel content")).toBeTruthy();
  });
});
