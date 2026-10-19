/** Actual legal-route navigation; auth controls are outside this test's scope. */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options: { defaultValue?: string }) =>
    options.defaultValue ?? _key,
}));
vi.mock("../login/steward-login-section", () => ({
  default: () => <div>Shared authentication controls</div>,
}));

import AlphaSignInPage from "../login/alpha-sign-in-page";
import PrivacyPolicyPage, {
  AlphaPrivacyPolicyPage,
} from "./privacy-policy-page";
import TermsOfServicePage, {
  AlphaTermsOfServicePage,
} from "./terms-of-service-page";

const continuation =
  "/auth/cli-login?session=45da6fcb-524c-441c-b71e-26bd7eb686fa&returnTo=%2Fapp%3Fx%3D1";
const query = new URLSearchParams({ returnTo: continuation }).toString();
function mount(path: string) {
  const router = createMemoryRouter(
    [
      { path: "/alpha/sign-in", element: <AlphaSignInPage /> },
      { path: "/alpha/terms-of-service", element: <AlphaTermsOfServicePage /> },
      { path: "/alpha/privacy-policy", element: <AlphaPrivacyPolicyPage /> },
      { path: "/terms-of-service", element: <TermsOfServicePage /> },
      { path: "/privacy-policy", element: <PrivacyPolicyPage /> },
      { path: "/login", element: <p>Generic Cloud login</p> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}
afterEach(cleanup);

describe("Alpha legal navigation preserves the login continuation", () => {
  it("returns from Terms through Privacy to Alpha with the same CLI continuation", async () => {
    const router = mount(`/alpha/sign-in?${query}&code=discard-me`);
    fireEvent.click(await screen.findByRole("link", { name: "Terms" }));
    await screen.findByRole("heading", {
      name: "Terms of Service",
    });
    expect(router.state.location.pathname).toBe("/alpha/terms-of-service");
    expect(router.state.location.search).toBe(`?${query}`);
    fireEvent.click(screen.getByRole("link", { name: "Privacy Policy" }));
    await screen.findByRole("heading", { name: "Privacy Policy" });
    expect(router.state.location.pathname).toBe("/alpha/privacy-policy");
    fireEvent.click(screen.getByRole("link", { name: "Return to login" }));
    await screen.findByRole("heading", {
      name: "Sign in to Alpha",
    });
    expect(router.state.location.pathname).toBe("/alpha/sign-in");
    expect(
      new URLSearchParams(router.state.location.search).get("returnTo"),
    ).toBe(continuation);
  });
  it.each(["terms-of-service", "privacy-policy"])(
    "retains Alpha return links on direct/reloaded %s URLs",
    async (path) => {
      mount(`/alpha/${path}?${query}`);
      const back = await screen.findByRole("link", {
        name: "Back to login",
      });
      expect(back.getAttribute("href")).toBe(`/alpha/sign-in?${query}`);
      expect(
        screen
          .getByRole("link", { name: "Return to login" })
          .getAttribute("href"),
      ).toBe(`/alpha/sign-in?${query}`);
    },
  );
  it.each(["https://evil.invalid/", "//evil.invalid/", "/\\evil.invalid/"])(
    "discards an unsafe continuation without changing the fixed Alpha return",
    async (returnTo) => {
      mount(
        `/alpha/terms-of-service?${new URLSearchParams({ returnTo, code: "not-carried" })}`,
      );
      expect(
        (
          await screen.findByRole("link", {
            name: "Back to login",
          })
        ).getAttribute("href"),
      ).toBe("/alpha/sign-in");
      expect(
        screen
          .getByRole("link", { name: "Privacy Policy" })
          .getAttribute("href"),
      ).toBe("/alpha/privacy-policy");
    },
  );
  it.each(["terms-of-service", "privacy-policy"])(
    "keeps generic Cloud %s navigation unchanged",
    async (path) => {
      mount(`/${path}?${query}`);
      expect(
        (
          await screen.findByRole("link", {
            name: "Back to login",
          })
        ).getAttribute("href"),
      ).toBe("/login");
      expect(
        screen
          .getByRole("link", { name: "Return to login" })
          .getAttribute("href"),
      ).toBe("/login");
    },
  );
});
