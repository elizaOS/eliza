/**
 * Verifies segmented controls expose either a pressed-button group or a valid
 * tablist relationship, depending on the semantic role requested by callers.
 */
// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "./segmented-control";

const items = [
  { value: "one", label: "One" },
  { value: "two", label: "Two" },
];

describe("SegmentedControl", () => {
  it("builds a valid tab relationship when used as a tablist", () => {
    render(
      <SegmentedControl
        aria-label="Example views"
        items={items}
        onValueChange={vi.fn()}
        role="tablist"
        value="one"
      />,
    );

    expect(
      screen.getByRole("tab", { name: "One" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: "Two" }).getAttribute("tabindex"),
    ).toBe("-1");
  });

  it("uses pressed state for the default button-group presentation", () => {
    render(
      <SegmentedControl items={items} onValueChange={vi.fn()} value="one" />,
    );

    expect(
      screen.getByRole("button", { name: "One" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
