/** View chrome stays absent while real page actions remain usable. */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewHeader } from "./ViewHeader";
afterEach(cleanup);
describe("ViewHeader", () => {
  it("does not render a title, back button, or empty row", () => {
    const { container } = render(
      <ViewHeader title="Knowledge" onBack={vi.fn()} />,
    );
    expect(container.childElementCount).toBe(0);
  });
  it("preserves page actions without restoring title or navigation chrome", () => {
    const add = vi.fn();
    render(
      <ViewHeader
        title="Notes"
        right={<button onClick={add}>Add note</button>}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(add).toHaveBeenCalledOnce();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
  });
});
