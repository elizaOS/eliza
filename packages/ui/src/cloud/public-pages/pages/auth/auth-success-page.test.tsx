// @vitest-environment jsdom

/**
 * `AuthSuccessPage` opener handling: it auto-closes and shows close
 * instructions only when the page has a live `window.opener`, and otherwise
 * never calls `window.close`. The router and i18n provider are doubled.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const searchParamsRef = vi.hoisted(() => ({
  current: new URLSearchParams("github_connected=1"),
}));

vi.mock("react-router-dom", () => ({
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT:
    () => (_key: string, opts?: { defaultValue?: string; platform?: string }) =>
      (opts?.defaultValue ?? _key).replace(
        "{{platform}}",
        opts?.platform ?? "",
      ),
}));

vi.mock("../../lib/use-page-title", () => ({ usePageTitle: () => {} }));

import AuthSuccessPage from "./auth-success-page";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as { opener?: unknown }).opener;
});

describe("AuthSuccessPage", () => {
  it("does not call window.close or show close instructions without an opener", () => {
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});

    render(<AuthSuccessPage />);

    expect(closeSpy).not.toHaveBeenCalled();
    expect(screen.getByText("GitHub Connected")).toBeTruthy();
    expect(screen.getByText("Return to the app to continue.")).toBeTruthy();
    expect(screen.queryByText("You can close this window.")).toBeNull();
  });

  it("auto-closes only when the page has a live opener", () => {
    vi.useFakeTimers();
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    Object.defineProperty(window, "opener", {
      value: { closed: false },
      configurable: true,
    });

    render(<AuthSuccessPage />);
    vi.advanceTimersByTime(2000);

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
