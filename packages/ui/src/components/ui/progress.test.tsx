/**
 * Verifies determinate progress values and accessible naming reach the Radix
 * root rather than being consumed only by the visual indicator transform.
 */
// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Progress } from "./progress";

describe("Progress", () => {
  it("exposes its value and default accessible name", () => {
    render(<Progress value={42} />);

    expect(
      screen
        .getByRole("progressbar", { name: "Progress" })
        .getAttribute("aria-valuenow"),
    ).toBe("42");
  });
});
