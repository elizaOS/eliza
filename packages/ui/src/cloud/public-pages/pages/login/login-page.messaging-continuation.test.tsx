/**
 * Messaging-continuation copy stays privacy-safe while preserving every
 * ordinary login journey and the complete Steward provider surface.
 */
// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://cloud.eliza.app/login"}

import { cleanup, render, screen } from "@testing-library/react";
import type { ButtonHTMLAttributes } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storePendingOAuthReturnTo } from "../../lib/login-return-to";

const continuationState = vi.hoisted(() => ({ token: null as string | null }));

vi.mock("@elizaos/shared/brand", () => ({
  BRAND_PATHS: { logos: "/brand/logos" },
  LOGO_FILES: { elizaLockupWhite: "eliza-lockup-white.svg" },
}));

vi.mock("lucide-react", () => ({
  CheckCircle2: () => <svg aria-hidden="true" />,
}));

vi.mock("../../../../components/primitives", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("../../../auth/cloud-auth-complete-signal", () => ({
  subscribeCloudAuthComplete: () => () => {},
}));

vi.mock("../../../join/lib/onboarding-continuation", () => ({
  peekPendingOnboardingSession: () => continuationState.token,
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

const CONTINUATION_FIXTURE = "fixture-28458";

function renderLogin(entry: string): void {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <LoginPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  continuationState.token = null;
  window.sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("messaging-continuation login context", () => {
  it("explains the link journey without naming its private authority", async () => {
    continuationState.token = CONTINUATION_FIXTURE;

    renderLogin("/login?returnTo=%2Fget-started");

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Sign in to connect Eliza",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Use any sign-in method. You'll confirm the connection before returning to your conversation.",
      ),
    ).toBeTruthy();
    expect(await screen.findByText("Steward login options")).toBeTruthy();
    expect(document.body.textContent).not.toContain(CONTINUATION_FIXTURE);
  });

  it("gives an explicit recovery step when the continuation is unavailable", async () => {
    renderLogin("/login?returnTo=%2Fget-started");

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "This connection link is no longer available",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Return to your conversation and request a new link, or sign in to continue in Eliza.",
      ),
    ).toBeTruthy();
    expect(await screen.findByText("Steward login options")).toBeTruthy();
  });

  it("keeps ordinary launch login generic despite unrelated pending state", async () => {
    continuationState.token = CONTINUATION_FIXTURE;
    storePendingOAuthReturnTo(
      new URLSearchParams({ returnTo: "/get-started" }),
    );

    renderLogin("/login?intent=launch");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Sign in" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Build and run agents from anywhere."),
    ).toBeTruthy();
    expect(screen.queryByText(/return to your conversation/i)).toBeNull();
  });

  it("keeps CLI handoffs generic despite unrelated pending state", async () => {
    continuationState.token = CONTINUATION_FIXTURE;
    storePendingOAuthReturnTo(
      new URLSearchParams({ returnTo: "/get-started" }),
    );
    const handoff = encodeURIComponent(
      "/auth/cli-login?session=login-context-regression",
    );

    renderLogin(`/login?returnTo=${handoff}`);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Sign in" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Build and run agents from anywhere."),
    ).toBeTruthy();
  });

  it("retains messaging context on a bare OAuth cancellation callback", async () => {
    continuationState.token = CONTINUATION_FIXTURE;
    storePendingOAuthReturnTo(
      new URLSearchParams({ returnTo: "/get-started" }),
    );

    renderLogin("/login?error=access_denied");

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Sign in to connect Eliza",
      }),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain(CONTINUATION_FIXTURE);
  });

  it("rejects query-bearing get-started targets as contextual state", async () => {
    continuationState.token = CONTINUATION_FIXTURE;
    const returnTo = encodeURIComponent(
      "/get-started?onboardingSession=url-metadata-must-not-drive-copy",
    );

    renderLogin(`/login?returnTo=${returnTo}`);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Sign in" }),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain(
      "url-metadata-must-not-drive-copy",
    );
  });

  it("does not trust a hostile return target as messaging context", async () => {
    continuationState.token = CONTINUATION_FIXTURE;
    storePendingOAuthReturnTo(
      new URLSearchParams({ returnTo: "/get-started" }),
    );

    renderLogin("/login?returnTo=%2F%5C%5Cevil.example%2Fget-started");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Sign in" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Build and run agents from anywhere."),
    ).toBeTruthy();
  });
});
