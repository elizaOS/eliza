// @vitest-environment jsdom
//
// Behavioral + regression coverage for HomeWidgetCard, the whole-card-clickable
// building block every home widget renders (#10719). Before this, the card had
// only a Storybook render smoke — no test exercised activation, the a11y
// contract, tone rendering, or the hover-feedback rule, and it shipped a real
// hover bug (resting `bg-black/55` === `hover:bg-black/55`, i.e. no feedback).

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Bell } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeWidgetCard } from "./home-widget-card";

afterEach(cleanup);

/** Pull the resting `bg-*` and the `hover:bg-*` utilities off the class list. */
function bgClasses(el: HTMLElement): { resting: string[]; hover: string[] } {
  const classes = el.className.split(/\s+/);
  return {
    resting: classes.filter((c) => /^bg-/.test(c)),
    hover: classes.filter((c) => /^hover:bg-/.test(c)),
  };
}

describe("HomeWidgetCard", () => {
  it("renders label, value, and fires onActivate on click", () => {
    const onActivate = vi.fn();
    render(
      <HomeWidgetCard
        icon={<Bell />}
        label="Bills"
        value="3 due"
        onActivate={onActivate}
        ariaLabel="Bills — 3 due"
        testId="wc-bills"
      />,
    );
    const card = screen.getByTestId("wc-bills");
    expect(card.tagName).toBe("BUTTON");
    expect(card.getAttribute("aria-label")).toBe("Bills — 3 due");
    expect(screen.getByText("3 due")).toBeTruthy();

    fireEvent.click(card);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("renders as a native <button type=button> so the browser handles Enter/Space", () => {
    const onActivate = vi.fn();
    render(
      <HomeWidgetCard
        icon={<Bell />}
        label="Goals"
        onActivate={onActivate}
        ariaLabel="Goals"
        testId="wc-goals"
      />,
    );
    const card = screen.getByTestId("wc-goals");
    // A native <button> is what makes Enter/Space work without extra handlers —
    // assert the element type rather than synthesizing browser key semantics.
    expect(card.tagName).toBe("BUTTON");
    expect(card.getAttribute("type")).toBe("button");
  });

  it("gives real (distinct) hover feedback — resting bg !== hover bg", () => {
    render(
      <HomeWidgetCard
        icon={<Bell />}
        label="Sleep"
        value="7h"
        onActivate={vi.fn()}
        ariaLabel="Sleep — 7h"
        testId="wc-sleep"
      />,
    );
    const { resting, hover } = bgClasses(screen.getByTestId("wc-sleep"));
    expect(resting.length, "card must have a resting bg").toBeGreaterThan(0);
    expect(hover.length, "clickable card must declare a hover bg").toBeGreaterThan(0);

    // The regression this guards: `hover:bg-black/55` on a `bg-black/55` card is
    // a no-op. The hover fill must differ from every resting fill so the whole-
    // card button actually reacts to pointer hover (neutral-hover rule).
    const hoverFills = hover.map((c) => c.replace(/^hover:/, ""));
    for (const hoverFill of hoverFills) {
      expect(
        resting,
        `hover fill ${hoverFill} is identical to a resting fill — no hover feedback`,
      ).not.toContain(hoverFill);
    }
    // And it stays neutral: no orange/blue accent on a neutral card hover.
    for (const hoverFill of hoverFills) {
      expect(hoverFill).not.toMatch(/accent|orange|blue|primary/i);
    }
  });

  it("renders tone-specific value + badge-dot styling for danger/warn", () => {
    const { rerender } = render(
      <HomeWidgetCard
        icon={<Bell />}
        label="Alerts"
        value="2"
        tone="danger"
        onActivate={vi.fn()}
        ariaLabel="Alerts — 2 (danger)"
        testId="wc-alerts"
      />,
    );
    // The value adopts the danger tone class (not the default white).
    expect(screen.getByText("2").className).toMatch(/text-danger/);

    rerender(
      <HomeWidgetCard
        icon={<Bell />}
        label="Alerts"
        value="1"
        tone="warn"
        onActivate={vi.fn()}
        ariaLabel="Alerts — 1 (warn)"
        testId="wc-alerts"
      />,
    );
    expect(screen.getByText("1").className).toMatch(/text-warn/);
  });

  it("omits the value node entirely when no datum is provided (glanceable, not empty)", () => {
    render(
      <HomeWidgetCard
        icon={<Bell />}
        label="Calendar"
        onActivate={vi.fn()}
        ariaLabel="Calendar"
        testId="wc-cal"
      />,
    );
    // Label is folded into aria-label / title, never shown as visible text.
    const card = screen.getByTestId("wc-cal");
    expect(card.getAttribute("title")).toBe("Calendar");
    expect(card.textContent?.trim()).toBe("");
  });
});
