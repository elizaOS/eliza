import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Skeleton } from "./skeleton";

describe("Skeleton", () => {
  it("renders correctly", () => {
    const { container } = render(<Skeleton data-testid="skeleton" />);
    expect(container.firstChild).toHaveClass("animate-pulse");
  });
});
