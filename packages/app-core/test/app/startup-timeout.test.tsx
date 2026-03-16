import { useEffect } from "react";
import renderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock out the relevant part of the App component logic for isolated testing
// without heavy UI dependencies.
function AppMock({
  startupPhase,
  startupError,
  retryStartup,
}: {
  startupPhase: string;
  startupError: unknown;
  retryStartup: () => void;
}) {
  useEffect(() => {
    const STARTUP_TIMEOUT_MS = 300_000;
    if (startupPhase !== "ready" && !startupError) {
      const timer = setTimeout(() => {
        retryStartup();
      }, STARTUP_TIMEOUT_MS);
      return () => clearTimeout(timer);
    }
  }, [startupPhase, startupError, retryStartup]);

  return <div>App Content</div>;
}

describe("App Startup Timeout Logic", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  it("sets a 300,000ms timeout and calls retryStartup if not ready", () => {
    vi.useFakeTimers();
    const retryStartup = vi.fn();

    act(() => {
      renderer.create(
        <AppMock
          startupPhase="initializing-agent"
          startupError={null}
          retryStartup={retryStartup}
        />,
      );
    });

    // Fast-forward time
    act(() => {
      vi.advanceTimersByTime(299999);
    });
    expect(retryStartup).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(retryStartup).toHaveBeenCalledTimes(1);
  });

  it("does not call retryStartup if startup is ready", () => {
    vi.useFakeTimers();
    const retryStartup = vi.fn();

    act(() => {
      renderer.create(
        <AppMock
          startupPhase="ready"
          startupError={null}
          retryStartup={retryStartup}
        />,
      );
    });

    act(() => {
      vi.advanceTimersByTime(300000);
    });
    expect(retryStartup).not.toHaveBeenCalled();
  });
});
