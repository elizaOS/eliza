/**
 * Verifies that Calendar owns the native top inset required by its fullscreen route chrome.
 *
 * @vitest-environment jsdom
 */

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CalendarPage } from "./CalendarPage.tsx";

vi.mock("../CalendarSection.tsx", () => ({
  CalendarSection: () => <div data-testid="calendar-body" />,
}));

describe("CalendarPage", () => {
  it("keeps its fullscreen header below the native safe area", () => {
    const { container } = render(<CalendarPage />);

    expect(container.firstElementChild?.className).toContain(
      "pt-[var(--safe-area-top,0px)]",
    );
  });
});
