/** Verifies that shared dynamic-view status surfaces provide actionable recovery copy. */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewUnavailableState } from "./ViewStatusStates";

afterEach(cleanup);

describe("ViewUnavailableState", () => {
  it("explains how to recover an unavailable app view", () => {
    render(<ViewUnavailableState viewId="camera" />);

    expect(
      screen.getByText(
        "This app is unavailable here. Install or enable it, then try again.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("App: camera")).toBeTruthy();
  });
});

// A registry refresh may resolve without making the requested app available.
it("waits for refresh, prevents duplicate checks, and announces the remaining limitation", async () => {
  let finish!: () => void;
  const retry = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(<ViewUnavailableState viewId="camera" onRetry={retry} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  const checking = screen.getByRole("button", { name: "Checking…" });
  expect(checking.hasAttribute("disabled")).toBe(true);
  fireEvent.click(checking);
  expect(retry).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status").textContent).toContain(
    "Checking app availability",
  );
  await act(async () => finish());
  expect(screen.getByRole("status").textContent).toContain("still unavailable");
  expect(
    screen.getByRole("button", { name: "Retry" }).hasAttribute("disabled"),
  ).toBe(false);
});

it("announces rejected refreshes and allows another attempt", async () => {
  const retry = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(undefined);
  render(<ViewUnavailableState viewId="camera" onRetry={retry} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("Couldn’t check"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain(
      "still unavailable",
    ),
  );
});

it("uses the registry error when refetch reports failures through hook state", async () => {
  render(
    <ViewUnavailableState
      viewId="camera"
      onRetry={async () => {}}
      error={new Error("offline")}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("Couldn’t check"),
  );
});

it("does not publish an old retry result after changing apps", async () => {
  let finish!: () => void;
  const retry = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  const view = render(<ViewUnavailableState viewId="camera" onRetry={retry} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  view.rerender(<ViewUnavailableState viewId="rolodex" onRetry={retry} />);
  await act(async () => finish());
  expect(screen.getByRole("status").textContent).not.toContain(
    "still unavailable",
  );
  expect(screen.getByRole("status").textContent).not.toContain(
    "Checking app availability",
  );
  expect(
    screen.getByRole("button", { name: "Retry" }).hasAttribute("disabled"),
  ).toBe(false);
});
