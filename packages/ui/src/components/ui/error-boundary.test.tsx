// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./error-boundary";

function Boom({ explode }: { explode: boolean }) {
  if (explode) throw new Error("kaboom in child");
  return <div>child is fine</div>;
}

describe("ErrorBoundary", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <div>healthy child</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("healthy child")).toBeTruthy();
  });

  it("renders the default fallback with the error message and a retry button", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    render(
      <ErrorBoundary errorLabel="View crashed" retryLabel="Reload">
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(screen.getByText("View crashed")).toBeTruthy();
    expect(screen.getByText("kaboom in child")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    consoleError.mockRestore();
  });

  it("passes the error and a reset callback to a custom fallback", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const fallback = vi.fn((error: Error) => (
      <div>custom: {error.message}</div>
    ));
    render(
      <ErrorBoundary fallback={fallback}>
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(screen.getByText("custom: kaboom in child")).toBeTruthy();
    expect(fallback).toHaveBeenCalledWith(
      expect.objectContaining({ message: "kaboom in child" }),
      expect.any(Function),
    );
    consoleError.mockRestore();
  });

  it("recovers via the reset callback once the child stops throwing", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    // A wrapper whose child throws on first render, then renders cleanly after
    // the reset callback flips `explode` to false.
    function Harness() {
      const [explode, setExplode] = useState(true);
      return (
        <ErrorBoundary
          fallback={(_error, reset) => (
            <button
              type="button"
              onClick={() => {
                setExplode(false);
                reset();
              }}
            >
              recover
            </button>
          )}
        >
          <Boom explode={explode} />
        </ErrorBoundary>
      );
    }

    render(<Harness />);
    const recover = screen.getByRole("button", { name: "recover" });

    act(() => {
      recover.click();
    });

    expect(screen.getByText("child is fine")).toBeTruthy();
    consoleError.mockRestore();
  });
});
