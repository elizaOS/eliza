/** Verifies OIDC continuation recovery through the real public page state. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));
vi.mock("../../lib/use-page-title", () => ({ usePageTitle: () => {} }));

const { prepareOidcResumeTargetMock } = vi.hoisted(() => ({
  prepareOidcResumeTargetMock: vi.fn(),
}));
vi.mock("../../lib/oidc-continue", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../lib/oidc-continue")>();
  return {
    ...original,
    prepareOidcResumeTarget: prepareOidcResumeTargetMock,
  };
});

import OidcContinuePage from "./oidc-continue-page";

afterEach(() => {
  cleanup();
  prepareOidcResumeTargetMock.mockReset();
});

describe("OidcContinuePage", () => {
  it.each(["/oidc/continue", "/oidc/continue?rid=%20"])(
    "offers a safe keyboard-reachable recovery action for %s",
    async (path) => {
      prepareOidcResumeTargetMock.mockResolvedValue({
        status: "invalid_request_id",
      });
      const user = userEvent.setup();

      render(
        <MemoryRouter initialEntries={[path]}>
          <OidcContinuePage />
        </MemoryRouter>,
      );

      expect(await screen.findByRole("main")).toBeTruthy();
      expect(
        await screen.findByRole("heading", {
          level: 1,
          name: "Authentication Error",
        }),
      ).toBeTruthy();
      const recovery = screen.getByRole("link", { name: "Sign In Again" });
      expect(recovery.getAttribute("href")).toBe("/login");
      await user.tab();
      expect(document.activeElement).toBe(recovery);
    },
  );

  it.each(["session_missing", "session_sync_failed"] as const)(
    "offers sign-in recovery when issuer session preparation returns %s",
    async (status) => {
      prepareOidcResumeTargetMock.mockResolvedValue({ status });

      render(
        <MemoryRouter
          initialEntries={[`/oidc/continue?rid=eoq_${"a".repeat(64)}`]}
        >
          <OidcContinuePage />
        </MemoryRouter>,
      );

      expect(
        await screen.findByText(
          "Your Eliza session could not be securely transferred to the identity provider. Sign in again to continue.",
        ),
      ).toBeTruthy();
      expect(
        screen
          .getByRole("link", { name: "Sign In Again" })
          .getAttribute("href"),
      ).toBe(
        `/login?returnTo=${encodeURIComponent(`/oidc/continue?rid=eoq_${"a".repeat(64)}`)}`,
      );
    },
  );

  it("turns an unexpected preparation rejection into recoverable UI", async () => {
    prepareOidcResumeTargetMock.mockRejectedValue(
      new Error("unexpected browser failure"),
    );

    render(
      <MemoryRouter
        initialEntries={[`/oidc/continue?rid=eoq_${"a".repeat(64)}`]}
      >
        <OidcContinuePage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("link", { name: "Sign In Again" }),
    ).toBeTruthy();
  });
});
