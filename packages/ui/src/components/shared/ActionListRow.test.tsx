/** Verifies ActionListRow native semantics, states, slots, and activation. */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionListRow } from "./ActionListRow";

afterEach(cleanup);

describe("ActionListRow", () => {
  it("renders and activates a native button with every content slot", () => {
    const onClick = vi.fn();
    render(
      <ActionListRow
        element="button"
        title="Calendar sync"
        description="Keep calendars synchronized."
        metadata="Connected"
        leading={<span>Icon</span>}
        trailing={<span>Active</span>}
        selected
        onClick={onClick}
      />,
    );

    const row = screen.getByRole("button", { name: /Calendar sync/ });
    expect(row.tagName).toBe("BUTTON");
    expect(row.getAttribute("data-state")).toBe("on");
    expect(row.textContent).toContain("Connected");
    expect(row.textContent).toContain("Active");
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("uses native disabled button behavior", () => {
    const onClick = vi.fn();
    render(
      <ActionListRow
        element="button"
        title="Unavailable action"
        disabled
        onClick={onClick}
      />,
    );

    const row = screen.getByRole("button", { name: "Unavailable action" });
    expect(row.hasAttribute("disabled")).toBe(true);
    fireEvent.click(row);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders a real link and suppresses navigation when disabled", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <ActionListRow
        element="link"
        href="/settings"
        title="Open settings"
        onClick={onClick}
      />,
    );

    const link = screen.getByRole("link", { name: "Open settings" });
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/settings");

    rerender(
      <ActionListRow
        element="link"
        href="/settings"
        title="Open settings"
        disabled
        onClick={onClick}
      />,
    );
    const disabledLink = screen.getByText("Open settings").closest("a");
    expect(disabledLink?.hasAttribute("href")).toBe(false);
    expect(disabledLink?.getAttribute("aria-disabled")).toBe("true");
    expect(disabledLink?.getAttribute("tabindex")).toBe("-1");
  });

  it("renders static content without interactive semantics", () => {
    render(
      <ActionListRow
        element="static"
        title="Runtime status"
        metadata="Connected"
        data-testid="status-row"
      />,
    );

    const row = screen.getByTestId("status-row");
    expect(row.tagName).toBe("DIV");
    expect(row.getAttribute("role")).toBeNull();
  });
});
