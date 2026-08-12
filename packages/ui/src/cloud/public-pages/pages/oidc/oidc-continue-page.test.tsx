/** Verifies invalid OIDC continuation recovery through the public page. */
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

import OidcContinuePage from "./oidc-continue-page";

afterEach(cleanup);

describe("OidcContinuePage", () => {
  it.each(["/oidc/continue", "/oidc/continue?rid=%20"])(
    "offers a safe keyboard-reachable recovery action for %s",
    async (path) => {
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
});
