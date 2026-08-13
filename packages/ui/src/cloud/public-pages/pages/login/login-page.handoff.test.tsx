/**
 * Managed-cloud login handoff tests use a deterministic jsdom navigation
 * boundary to prove the transient bridge screen always falls back to a usable
 * Steward login when initiation is blocked, rejected, or never navigates.
 */
// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://cloud.eliza.app/login?intent=launch"}

import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  redirect: vi.fn<() => Promise<boolean>>(),
  shouldAttempt: vi.fn<() => boolean>(),
}));

vi.mock("../../../sso-bridge/sso-bridge", () => ({
  redirectToSsoBridge: bridge.redirect,
  sanitizeBridgeReturnTo: (value: string | null) => value ?? "/",
  shouldAttemptSsoBridge: bridge.shouldAttempt,
}));

vi.mock("./steward-login-section", () => ({
  default: () => <div>Steward login options</div>,
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));

vi.mock("../../lib/use-page-title", () => ({ usePageTitle: () => {} }));

import LoginPage from "./login-page";

async function renderLogin(): Promise<void> {
  await act(async () => {
    render(
      <StrictMode>
        <MemoryRouter initialEntries={["/login?intent=launch"]}>
          <LoginPage />
        </MemoryRouter>
      </StrictMode>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  bridge.redirect.mockReset();
  bridge.shouldAttempt.mockReset();
  bridge.shouldAttempt.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("managed-cloud login handoff", () => {
  it("uses the redirect-loop guard before starting another bridge", async () => {
    bridge.shouldAttempt.mockReturnValue(false);

    await renderLogin();

    expect(bridge.redirect).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Sign in to Eliza" }),
    ).toBeTruthy();
  });

  it("falls back when bridge initiation rejects", async () => {
    bridge.redirect.mockRejectedValue(new Error("navigation unavailable"));

    await renderLogin();

    expect(
      screen.getByRole("heading", { name: "Sign in to Eliza" }),
    ).toBeTruthy();
  });

  it("leaves the transient screen after a bounded stalled navigation", async () => {
    bridge.redirect.mockResolvedValue(true);

    await renderLogin();
    expect(screen.getByText("Taking you to Eliza sign in")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(bridge.redirect).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "Sign in to Eliza" }),
    ).toBeTruthy();
  });
});
