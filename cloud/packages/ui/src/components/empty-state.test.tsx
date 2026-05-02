import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("renders title", () => {
    render(<EmptyState title="No items yet" />);
    expect(screen.getByText("No items yet")).toBeDefined();
  });

  it("renders description when provided", () => {
    render(<EmptyState title="Empty" description="Some description" />);
    expect(screen.getByText("Some description")).toBeDefined();
  });

  it("renders action when provided", () => {
    render(<EmptyState title="Empty" action={<button>Create</button>} />);
    expect(screen.getByRole("button", { name: "Create" })).toBeDefined();
  });

  it("renders icon when provided", () => {
    render(<EmptyState title="Empty" icon={<span data-testid="icon">🔑</span>} />);
    expect(screen.getByTestId("icon")).toBeDefined();
  });

  it("applies dashed variant class", () => {
    const { container } = render(<EmptyState title="Empty" variant="dashed" />);
    expect(container.querySelector("[data-slot='empty-state']")?.className).toContain(
      "border-dashed",
    );
  });
});
