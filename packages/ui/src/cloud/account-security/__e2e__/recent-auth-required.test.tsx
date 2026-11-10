/** A `recent_auth_required` answer asks the user to sign in again instead of failing. */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../data/consent-client", () => ({
  useConsents: () => ({
    data: undefined,
    isError: false,
    isPending: false,
    error: null,
    refetch: () => undefined,
  }),
}));

const { CloudI18nProvider } = await import("../../shell/CloudI18nProvider");
const { PrivacyPanel } = await import("../components/privacy-panel");
const { AccountDeletionDialog } = await import(
  "../components/account-deletion-dialog"
);

const realFetch = globalThis.fetch;
let requests: string[] = [];

function serverAnswersRecentAuthRequired(): void {
  requests = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(
      JSON.stringify({
        success: false,
        error:
          "Authenticate again before changing account ownership or deletion state.",
        code: "recent_auth_required",
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("recent_auth_required", () => {
  it("data export shows a sign-in-again link back to this page", async () => {
    serverAnswersRecentAuthRequired();
    window.history.replaceState(null, "", "/cloud/account?tab=privacy");
    render(
      <CloudI18nProvider initialLang="en">
        <PrivacyPanel />
      </CloudI18nProvider>,
    );
    fireEvent.click(screen.getByTestId("privacy-export-button"));
    const prompt = await screen.findByTestId("privacy-export-sign-in-again");
    expect(prompt.textContent).toContain("Sign in again to continue");
    const href = prompt.querySelector("a")?.getAttribute("href") ?? "";
    const url = new URL(href, "http://localhost/");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("switchAccount")).toBe("1");
    expect(url.searchParams.get("returnTo")).toBe("/cloud/account?tab=privacy");
    expect(requests.some((r) => r.endsWith("/api/v1/me/data-export"))).toBe(
      true,
    );
  });

  it("account deletion shows the prompt and keeps the dialog open", async () => {
    serverAnswersRecentAuthRequired();
    render(<AccountDeletionDialog onAccepted={() => undefined} />);
    fireEvent.click(screen.getByTestId("delete-account-trigger"));
    fireEvent.change(await screen.findByLabelText(/Type DELETE to confirm/), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByTestId("delete-account-confirm"));
    const prompt = await screen.findByTestId("delete-account-sign-in-again");
    expect(prompt.textContent).toContain("Sign in again to continue");
    expect(screen.getByTestId("delete-account-confirm").hasAttribute("disabled")).toBe(
      false,
    );
  });
});
