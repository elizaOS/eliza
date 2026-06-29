// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchParamsRef = vi.hoisted(() => ({
  current: new URLSearchParams("platform=github"),
}));

vi.mock("react-router-dom", () => ({
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT:
    () =>
    (
      _key: string,
      opts?: { defaultValue?: string; platform?: string },
    ): string =>
      (opts?.defaultValue ?? _key).replace(
        "{{platform}}",
        opts?.platform ?? "",
      ),
}));

vi.mock("../../lib/use-page-title", () => ({ usePageTitle: () => {} }));

import AuthSuccessPage from "./auth-success-page";

describe("AuthSuccessPage", () => {
  beforeEach(() => {
    searchParamsRef.current = new URLSearchParams("platform=github");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the connected platform and routes back to Cloud without trying to close the tab", () => {
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});

    render(<AuthSuccessPage />);

    expect(screen.getByText("GitHub Connected")).toBeTruthy();
    expect(
      screen.getByText("Your GitHub account has been connected successfully."),
    ).toBeTruthy();
    expect(screen.queryByText(/say/i)).toBeNull();
    expect(screen.queryByText("You can close this window.")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Open Eliza Cloud" })
        .getAttribute("href"),
    ).toBe("/dashboard");
    expect(closeSpy).not.toHaveBeenCalled();
  });
});
