/** Verifies the log viewer renders malformed present timestamps as unavailable. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogViewer } from "./log-viewer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LogViewer timestamps", () => {
  it("renders malformed refresh and entry timestamps as explicitly unavailable", () => {
    render(
      <LogViewer
        title="Runtime logs"
        fetchedAt="not-a-date"
        entries={[
          {
            id: "invalid",
            timestamp: "not-a-date",
            message: "Malformed entry",
          },
          { id: "missing", message: "Missing entry timestamp" },
        ]}
      />,
    );

    expect(screen.getByText("Refreshed at —")).toBeTruthy();
    expect(screen.getByText("Malformed entry").parentElement?.textContent).toBe(
      "—Malformed entry",
    );
    expect(
      screen.getByText("Missing entry timestamp").parentElement?.textContent,
    ).toBe("Missing entry timestamp");
    expect(screen.queryByText("Invalid Date")).toBeNull();
  });

  it("preserves valid timestamps, including the Unix epoch", () => {
    const localeSpy = vi
      .spyOn(Date.prototype, "toLocaleTimeString")
      .mockReturnValue("12:34:56 PM");

    render(
      <LogViewer
        title="Runtime logs"
        fetchedAt={0}
        entries={[{ id: "valid", timestamp: 0, message: "Valid entry" }]}
      />,
    );

    expect(screen.getByText("Refreshed at 12:34:56 PM")).toBeTruthy();
    expect(screen.getByText("Valid entry").parentElement?.textContent).toBe(
      "12:34:56 PMValid entry",
    );
    expect(localeSpy).toHaveBeenCalledTimes(2);
  });
});
