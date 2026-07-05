// @vitest-environment jsdom
// Real jsdom render of the designed-empty surface — asserts the #13588 contract
// that a view's empty state carries a glyph + one terse line and NO tappable
// suggestion chip or setup CTA (the agent suggests in chat, not the view).

import { render } from "@testing-library/react";
import { LifeBuoy } from "lucide-react";
import { describe, expect, it } from "vitest";
import { ViewEmptyState } from "./view-empty-state";

describe("ViewEmptyState", () => {
  it("renders a bare glyph + terse line with no chip/CTA controls", () => {
    const { container } = render(
      <ViewEmptyState icon={LifeBuoy} title="No matches." testId="empty" />,
    );
    const root = container.querySelector('[data-testid="empty"]');
    expect(root).not.toBeNull();
    expect(root?.querySelector("svg")).not.toBeNull();
    expect(root?.querySelector("p")?.textContent).toBe("No matches.");
    // The whole point of #13588: zero suggestion chips / setup CTAs.
    expect(root?.querySelectorAll("button").length).toBe(0);
    expect(root?.querySelectorAll("a").length).toBe(0);
  });

  it("omits the glyph and line when not provided (designed-empty, not a box)", () => {
    const { container } = render(<ViewEmptyState testId="empty" />);
    const root = container.querySelector('[data-testid="empty"]');
    expect(root?.querySelector("svg")).toBeNull();
    expect(root?.querySelector("p")).toBeNull();
    expect(root?.querySelectorAll("button").length).toBe(0);
  });
});
