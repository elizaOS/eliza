import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Input } from "./input";

describe("Input", () => {
  it("renders correctly", () => {
    render(<Input placeholder="Test input" />);
    expect(screen.getByPlaceholderText("Test input")).toBeInTheDocument();
  });
});
