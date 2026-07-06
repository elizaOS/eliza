// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { Circle } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { HomeWidgetCard } from "./home-widget-card";

describe("HomeWidgetCard", () => {
  it("renders as a solid token tile with no per-card backdrop blur", () => {
    render(
      <HomeWidgetCard
        icon={<Circle aria-hidden />}
        label="Needs"
        value="Approve deployment"
        testId="home-widget-card"
        ariaLabel="Needs response: approve deployment"
        onActivate={vi.fn()}
      />,
    );

    const card = screen.getByTestId("home-widget-card");
    expect(card.className).toContain("bg-[var(--brand-black)]");
    expect(card.className).toContain("border-[color:color-mix");
    expect(card.className).not.toContain("backdrop-blur");
    expect(card.className).not.toMatch(/bg-black\/35/);
  });
});
