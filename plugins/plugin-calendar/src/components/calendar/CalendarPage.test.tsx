/**
 * Verifies that Calendar owns the native top inset required by its fullscreen route chrome.
 *
 * @vitest-environment jsdom
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarPage } from "./CalendarPage.tsx";

vi.mock("./SimpleCalendarView.tsx", () => ({
  SimpleCalendarView: () => <div data-testid="calendar-body" />,
}));

describe("CalendarPage", () => {
  afterEach(async () => {
    await act(async () => cleanup());
  });

  it("keeps its fullscreen header below the native safe area", () => {
    const { container } = render(<CalendarPage />);

    expect(container.firstElementChild?.className).toContain(
      "pt-[var(--safe-area-top,0px)]",
    );
  });
});
