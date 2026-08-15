/**
 * Exercises the authenticated billing Checkout return component as a
 * deterministic state machine. Session/auth and the verification mutation are
 * controlled test seams; the real page decides which user-visible state wins.
 */

// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchParamsState = vi.hoisted(() => ({
  current: new URLSearchParams(),
}));

const sessionState = vi.hoisted(() => ({
  ready: true,
  authenticated: true,
}));

const verifyState = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  isSuccess: false,
  error: null as Error | null,
  data: undefined as
    | { success: boolean; balance: number; alreadyApplied: boolean }
    | undefined,
}));

vi.mock("react-router-dom", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
  useSearchParams: () => [searchParamsState.current, vi.fn()],
}));

vi.mock("@elizaos/ui/cloud-ui", () => ({
  Button: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Card: ({ children, ...props }: { children: ReactNode }) => (
    <section {...props}>{children}</section>
  ),
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  CardFooter: ({ children }: { children: ReactNode }) => (
    <footer>{children}</footer>
  ),
  CardHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
  CardTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
  DashboardLoadingState: ({ label }: { label: string }) => (
    <div role="status" aria-live="polite" aria-label={label} />
  ),
}));

vi.mock("../lib/use-session-auth", () => ({
  useSessionAuth: () => sessionState,
}));

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

vi.mock("./components/success-client", () => ({
  CreditBalanceDisplay: () => <div data-testid="credit-balance">$42.00</div>,
}));

vi.mock("./data/billing-data", () => ({
  useVerifyCheckout: () => verifyState,
}));

import BillingSuccessPage from "./BillingSuccessPage";

function renderPage(search = "session_id=cs_paid&from=settings") {
  searchParamsState.current = new URLSearchParams(search);
  return render(<BillingSuccessPage />);
}

function expectNoSuccess(): void {
  expect(screen.queryByText("Purchase Successful!")).toBeNull();
  expect(screen.queryByTestId("credit-balance")).toBeNull();
}

beforeEach(() => {
  searchParamsState.current = new URLSearchParams();
  sessionState.ready = true;
  sessionState.authenticated = true;
  verifyState.mutate.mockReset();
  verifyState.isPending = false;
  verifyState.isError = false;
  verifyState.isSuccess = false;
  verifyState.error = null;
  verifyState.data = undefined;
});

afterEach(() => {
  cleanup();
});

describe("BillingSuccessPage checkout verification truth", () => {
  it("rejects a missing checkout session without starting verification", () => {
    renderPage("");

    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.textContent).toContain("Payment Issue");
    expect(alert.textContent).not.toContain("session ID");
    expect(alert.textContent).not.toContain("Session:");
    expectNoSuccess();
    expect(verifyState.mutate).not.toHaveBeenCalled();
  });

  it("keeps idle verification away from success before the effect settles", () => {
    renderPage();

    expect(
      screen.getByRole("status", { name: "Verifying payment" }),
    ).toBeTruthy();
    expectNoSuccess();
    expect(verifyState.mutate).toHaveBeenCalledTimes(1);
    expect(verifyState.mutate).toHaveBeenCalledWith({
      sessionId: "cs_paid",
      from: "settings",
    });
  });

  it("keeps pending verification away from success", () => {
    verifyState.isPending = true;
    renderPage("session_id=cs_pending");

    expect(
      screen.getByRole("status", { name: "Verifying payment" }),
    ).toBeTruthy();
    expectNoSuccess();
    expect(verifyState.mutate).toHaveBeenCalledTimes(1);
    expect(verifyState.mutate).toHaveBeenCalledWith({
      sessionId: "cs_pending",
      from: undefined,
    });
  });

  it("renders a verification rejection as an announced payment issue", () => {
    const page = renderPage();
    verifyState.isError = true;
    verifyState.error = new Error("Checkout verification failed");

    page.rerender(<BillingSuccessPage />);

    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.textContent).toContain("Checkout verification failed");
    expectNoSuccess();
    expect(verifyState.mutate).toHaveBeenCalledTimes(1);
  });

  it("rejects a resolved response whose success flag is false", () => {
    const page = renderPage();
    verifyState.isSuccess = true;
    verifyState.data = {
      success: false,
      balance: 42,
      alreadyApplied: false,
    };

    page.rerender(<BillingSuccessPage />);

    expect(screen.getByRole("alert").textContent).toContain("Payment Issue");
    expectNoSuccess();
    expect(verifyState.mutate).toHaveBeenCalledTimes(1);
  });

  it("renders purchase success only for a verified success payload", () => {
    const page = renderPage();
    verifyState.isSuccess = true;
    verifyState.data = {
      success: true,
      balance: 42,
      alreadyApplied: false,
    };

    page.rerender(<BillingSuccessPage />);

    expect(screen.getByText("Purchase Successful!")).toBeTruthy();
    expect(screen.getByTestId("credit-balance")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(verifyState.mutate).toHaveBeenCalledTimes(1);
  });
});
