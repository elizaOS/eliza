import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "./status-badge";

describe("StatusBadge", () => {
  it("renders label", () => {
    render(<StatusBadge status="success" label="Ready" />);
    expect(screen.getByText("Ready")).toBeDefined();
  });

  it("applies success variant", () => {
    const { container } = render(<StatusBadge status="success" label="Active" />);
    const el = container.querySelector("[data-slot='status-badge']");
    expect(el?.getAttribute("data-status")).toBe("success");
    expect(el?.className).toContain("text-green-500");
  });

  it("applies error variant", () => {
    const { container } = render(<StatusBadge status="error" label="Failed" />);
    const el = container.querySelector("[data-slot='status-badge']");
    expect(el?.className).toContain("text-red-500");
  });

  it("shows spinner for processing variant", () => {
    const { container } = render(<StatusBadge status="processing" label="Processing" />);
    expect(container.querySelector(".animate-spin")).toBeDefined();
  });

  it("renders custom icon", () => {
    render(
      <StatusBadge status="info" label="Info" icon={<span data-testid="custom-icon">ℹ️</span>} />,
    );
    expect(screen.getByTestId("custom-icon")).toBeDefined();
  });
});
