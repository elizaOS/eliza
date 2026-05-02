import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Switch } from "./switch";

describe("Switch", () => {
  it("renders correctly", () => {
    render(<Switch />);
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });
});
