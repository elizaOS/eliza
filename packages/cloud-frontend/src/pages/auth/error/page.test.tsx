import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, test } from "vitest";
import { I18nProvider } from "@/providers/I18nProvider";
import AuthErrorPage from "./page";

function renderAuthError(initialEntry: string) {
  return render(
    <HelmetProvider>
      <I18nProvider initialLang="en">
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/auth/error" element={<AuthErrorPage />} />
            <Route path="/login" element={<h1>Login route</h1>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </HelmetProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("AuthErrorPage", () => {
  test("falls back for hostile reason query values without reflecting them", () => {
    const hostileReason = `<img src=x onerror=alert(1)>`;
    const { container } = renderAuthError(
      `/auth/error?reason=${encodeURIComponent(hostileReason)}`,
    );

    expect(
      screen.getByRole("heading", { name: "Authentication Error" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "An unexpected error occurred during authentication. Please try again.",
      ),
    ).toBeVisible();
    expect(container).not.toHaveTextContent(hostileReason);
    expect(container.innerHTML).not.toContain("onerror");
  });

  test("retry navigates back to login from a known auth failure", () => {
    renderAuthError("/auth/error?reason=sync_failed");

    expect(
      screen.getByRole("heading", { name: "Authentication Sync Failed" }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(screen.getByRole("heading", { name: "Login route" })).toBeVisible();
  });
});
