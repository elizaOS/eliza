/** Regression coverage for one-shot messaging onboarding continuation redemption. */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingOnboardingSession,
  completePendingOnboardingContinuation,
  peekPendingOnboardingSession,
  previewPendingOnboardingContinuation,
} from "./lib/onboarding-continuation";

const TOKEN = "aaaaaaaa-test-test-test-tokentoken01";

vi.mock("./lib/use-join-session", () => ({
  useJoinSessionAuth: () => ({ ready: true, authenticated: true }),
}));

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

vi.mock("./lib/onboarding-continuation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./lib/onboarding-continuation")>();
  return {
    ...actual,
    previewPendingOnboardingContinuation: vi.fn(async () => ({
      platform: "discord" as const,
      platformUserId: "1234567890",
      platformDisplayName: "attested-discord-user",
    })),
    completePendingOnboardingContinuation: vi.fn(async () => {
      actual.clearPendingOnboardingSession();
    }),
  };
});

const { default: GetStartedPage } = await import("./GetStartedPage");

beforeEach(() => {
  vi.mocked(previewPendingOnboardingContinuation).mockReset();
  vi.mocked(previewPendingOnboardingContinuation).mockResolvedValue({
    platform: "discord",
    platformUserId: "1234567890",
    platformDisplayName: "attested-discord-user",
  });
  vi.mocked(completePendingOnboardingContinuation).mockReset();
  vi.mocked(completePendingOnboardingContinuation).mockImplementation(
    async () => {
      clearPendingOnboardingSession();
    },
  );
});

afterEach(() => {
  cleanup();
  clearPendingOnboardingSession();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("GetStartedPage", () => {
  it("does not restore a URL continuation after a successful redemption rerender", async () => {
    const entry = `/get-started?onboardingSession=${TOKEN}`;
    window.history.replaceState(null, "", entry);

    render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/get-started" element={<GetStartedPage />} />
          <Route path="/join" element={<div>join</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    expect(screen.queryByText("You're connected")).toBeNull();
    fireEvent.click(screen.getByText("Connect this Discord account"));
    expect(await screen.findByText("You're connected")).toBeTruthy();
    await waitFor(() => {
      expect(peekPendingOnboardingSession()).toBeNull();
      expect(window.sessionStorage.length).toBe(0);
      expect(window.localStorage.length).toBe(0);
    });
    expect(window.location.search).not.toContain("onboardingSession");
  });

  it("retries a failed preview without silently confirming the identity link", async () => {
    vi.mocked(previewPendingOnboardingContinuation).mockRejectedValueOnce(
      new Error("preview temporarily unavailable"),
    );
    const entry = `/get-started?onboardingSession=${TOKEN}`;
    window.history.replaceState(null, "", entry);

    render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/get-started" element={<GetStartedPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("preview temporarily unavailable"),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Try again"));

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    expect(completePendingOnboardingContinuation).not.toHaveBeenCalled();
    expect(previewPendingOnboardingContinuation).toHaveBeenCalledTimes(2);
  });
});
