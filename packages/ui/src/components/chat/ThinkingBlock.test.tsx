// @vitest-environment jsdom
//
// ThinkingBlock: collapsed by default and toggles the reasoning body, renders
// nothing for empty/whitespace reasoning, and uses the shared accent treatment
// with no blue classes. Pure jsdom render — presentational component, no backend.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThinkingBlock } from "./ThinkingBlock";

describe("ThinkingBlock (#10712)", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders collapsed by default and toggles the reasoning body", () => {
    render(<ThinkingBlock reasoning="Checked the plan before answering." />);

    const toggle = screen.getByRole("button", { name: /thinking/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Checked the plan before answering.")).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Checked the plan before answering.")).toBeTruthy();
  });

  it("renders nothing for empty or whitespace reasoning", () => {
    const { container, rerender } = render(<ThinkingBlock reasoning="   " />);
    expect(container.firstChild).toBeNull();

    rerender(<ThinkingBlock reasoning={"\n\t"} />);
    expect(container.firstChild).toBeNull();
  });

  it("uses the shared accent treatment without blue classes", () => {
    const { container } = render(<ThinkingBlock reasoning="Accent only." />);
    const html = container.innerHTML;

    expect(html).toContain("border-accent");
    expect(html).toContain("text-accent");
    expect(html).not.toMatch(/blue/i);
  });
});
