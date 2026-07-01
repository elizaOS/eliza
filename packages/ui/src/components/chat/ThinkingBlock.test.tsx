// @vitest-environment jsdom
//
// #10712: the collapsible "Thinking" (reasoning) disclosure. Collapsed by
// default, toggles on click (aria-expanded + body reveal), renders nothing for
// empty/whitespace reasoning, accent-only styling (no blue).

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThinkingBlock } from "./ThinkingBlock";

afterEach(cleanup);

describe("ThinkingBlock (#10712)", () => {
  it("renders nothing for empty or whitespace-only reasoning", () => {
    const empty = render(<ThinkingBlock reasoning="" />);
    expect(empty.container.firstChild).toBeNull();
    empty.unmount();
    const blank = render(<ThinkingBlock reasoning={"   \n\t  "} />);
    expect(blank.container.firstChild).toBeNull();
  });

  it("is collapsed by default: shows the toggle but not the reasoning body", () => {
    const { getByRole, queryByText } = render(
      <ThinkingBlock reasoning="weighing options A and B" />,
    );
    const toggle = getByRole("button", { name: /thinking/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(queryByText("weighing options A and B")).toBeNull();
  });

  it("reveals the reasoning body on click and collapses again on a second click", () => {
    const { getByRole, queryByText } = render(
      <ThinkingBlock reasoning="weighing options A and B" />,
    );
    const toggle = getByRole("button", { name: /thinking/i });

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(queryByText("weighing options A and B")).not.toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(queryByText("weighing options A and B")).toBeNull();
  });

  it("trims the reasoning it displays", () => {
    const { getByRole, getByText } = render(
      <ThinkingBlock reasoning="   padded thought   " />,
    );
    fireEvent.click(getByRole("button", { name: /thinking/i }));
    // The rendered body is the trimmed text (exact match).
    expect(getByText("padded thought")).not.toBeNull();
  });

  it("is accent-only — no blue anywhere in the rendered tree", () => {
    const { container } = render(<ThinkingBlock reasoning="hmm" />);
    const html = container.innerHTML;
    expect(html).toContain("text-accent");
    expect(html).not.toMatch(/blue|indigo|sky|cyan/);
  });
});
