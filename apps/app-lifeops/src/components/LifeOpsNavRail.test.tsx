// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LifeOpsNavRail } from "./LifeOpsNavRail";

describe("LifeOpsNavRail", () => {
  it("renders a compact section switcher and routes button presses", () => {
    const onNavigate = vi.fn();

    render(
      <LifeOpsNavRail
        activeSection="overview"
        onNavigate={onNavigate}
        layout="compact"
      />,
    );

    expect(screen.getByTestId("lifeops-nav-compact")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Overview" }).getAttribute(
        "aria-current",
      ),
    ).toBe("page");

    fireEvent.click(screen.getByRole("button", { name: "Screen Time" }));

    expect(onNavigate).toHaveBeenCalledWith("screen-time");
  });
});
