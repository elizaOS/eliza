// @vitest-environment jsdom
//
// StartupFailureView recovery affordances per failure reason (e.g. an
// unreachable saved backend offers a first-run reset). Real component in jsdom;
// branding, bug-report, platform reload, and translation are mocked.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartupFailureView } from "./StartupFailureView";

const mocks = vi.hoisted(() => ({
  startFreshFirstRunReload: vi.fn(),
}));

vi.mock("../../config/branding", () => ({
  useBranding: () => ({ appUrl: "https://elizaos.ai" }),
}));

vi.mock("../../hooks", () => ({
  useOptionalBugReport: () => null,
}));

vi.mock("../../platform", () => ({
  startFreshFirstRunReload: mocks.startFreshFirstRunReload,
}));

vi.mock("../../state", () => ({
  useAppSelector: <T,>(
    selector: (state: {
      t: (key: string, options?: { defaultValue?: string }) => string;
    }) => T,
  ): T =>
    selector({
      t: (_key, options) => options?.defaultValue ?? _key,
    }),
}));

afterEach(() => {
  mocks.startFreshFirstRunReload.mockClear();
});

describe("StartupFailureView", () => {
  it("offers one first-run reset for unreachable saved backends", () => {
    render(
      <StartupFailureView
        error={{
          reason: "backend-unreachable",
          message:
            "Previously configured backend is unreachable. Check your connection or reset.",
          phase: "starting-backend",
        }}
        onRetry={vi.fn()}
      />,
    );

    const startOver = screen.getByTestId("startup-start-over");
    expect(startOver.textContent).toContain("Start over");
    expect(screen.queryByTestId("startup-use-cloud")).toBeNull();

    fireEvent.click(startOver);

    expect(mocks.startFreshFirstRunReload).toHaveBeenCalledTimes(1);
  });
});
