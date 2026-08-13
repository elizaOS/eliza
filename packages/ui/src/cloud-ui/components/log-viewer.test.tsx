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
  it("renders every malformed present timestamp as explicitly unavailable", () => {
    render(
      <LogViewer
        title="Runtime logs"
        fetchedAt="2026-02-31T00:00:00Z"
        entries={[
          {
            id: "malformed",
            timestamp: "not-a-date",
            message: "Malformed entry",
          },
          {
            id: "nan",
            timestamp: Number.NaN,
            message: "NaN entry",
          },
          {
            id: "invalid-date",
            timestamp: new Date(Number.NaN),
            message: "Invalid object entry",
          },
          {
            id: "time-clip",
            timestamp: 8.64e15 + 1,
            message: "Out-of-TimeClip entry",
          },
          {
            id: "calendar-invalid",
            timestamp: "2026-02-31T00:00:00Z",
            message: "Calendar-invalid entry",
          },
          { id: "missing", message: "Missing entry timestamp" },
          { id: "empty", timestamp: "", message: "Empty entry timestamp" },
        ]}
      />,
    );

    expect(screen.getByText("Refreshed at —")).toBeTruthy();
    for (const message of [
      "Malformed entry",
      "NaN entry",
      "Invalid object entry",
      "Out-of-TimeClip entry",
      "Calendar-invalid entry",
    ]) {
      expect(screen.getByText(message).parentElement?.textContent).toBe(
        `—${message}`,
      );
    }
    expect(
      screen.getByText("Missing entry timestamp").parentElement?.textContent,
    ).toBe("Missing entry timestamp");
    expect(
      screen.getByText("Empty entry timestamp").parentElement?.textContent,
    ).toBe("Empty entry timestamp");
    expect(document.body.textContent).not.toContain("Invalid Date");
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
