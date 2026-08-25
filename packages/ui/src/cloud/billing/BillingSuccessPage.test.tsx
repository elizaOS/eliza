/**
 * Exercises the authenticated billing Checkout return component as a
 * deterministic state machine. React Router is real for in-place query
 * transitions; session/auth and React Query mutation callbacks are controlled
 * seams while the real page decides which user-visible state wins.
 */

// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode, Suspense, startTransition } from "react";
import {
  MemoryRouter,
  type NavigateFunction,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionState = vi.hoisted(() => ({
  ready: true,
  authenticated: true,
  user: { id: "user-a", email: "a@example.test" } as {
    id: string;
    email: string;
  } | null,
}));

const verifyState = vi.hoisted(() => {
  type Result = {
    success: boolean;
    balance: number;
    alreadyApplied: boolean;
  };
  type Request = {
    input: { sessionId: string; from?: string };
    callbacks: {
      onError: (error: unknown) => void;
      onSuccess: (data: Result) => void;
    };
  };
  const requests: Request[] = [];
  return {
    requests,
    mutate: vi.fn(
      (input: Request["input"], callbacks: Request["callbacks"]) => {
        requests.push({ callbacks, input });
      },
    ),
  };
});

const renderState = vi.hoisted(() => ({
  balance: vi.fn(),
  suspensions: vi.fn(),
  successTitle: vi.fn(),
}));

const checkoutIntentState = vi.hoisted(() => ({
  clearVerifiedSession: vi.fn(() =>
    Promise.resolve({
      status: "cleared" as const,
      source: "tab-pointer" as const,
    }),
  ),
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
  CardTitle: ({ children }: { children: ReactNode }) => {
    if (children === "Purchase Successful!") renderState.successTitle();
    return <h1>{children}</h1>;
  },
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
  CreditBalanceDisplay: () => {
    renderState.balance();
    return <div data-testid="credit-balance">$42.00</div>;
  },
}));

vi.mock("./data/billing-data", () => ({
  useVerifyCheckout: () => verifyState,
}));

vi.mock("./lib/card-checkout-intent", () => ({
  browserCardCheckoutIntentCoordinator: checkoutIntentState,
}));

import BillingSuccessPage from "./BillingSuccessPage";

let navigate: NavigateFunction | null = null;
const suspendedForever = new Promise<never>(() => undefined);

function SuspendAfterBilling() {
  const [params] = useSearchParams();
  if (params.get("suspend") === "1") {
    renderState.suspensions();
    throw suspendedForever;
  }
  return null;
}

function BillingSuccessRoute() {
  navigate = useNavigate();
  return (
    <>
      <BillingSuccessPage />
      <SuspendAfterBilling />
    </>
  );
}

function pageTree(search: string) {
  const suffix = search ? `?${search}` : "";
  return (
    <MemoryRouter initialEntries={[`/cloud/billing/success${suffix}`]}>
      <Suspense fallback={<div>Suspended transition</div>}>
        <BillingSuccessRoute />
      </Suspense>
    </MemoryRouter>
  );
}

function renderPage(search = "session_id=cs_paid&from=settings") {
  return render(pageTree(search));
}

function navigatePage(search: string): void {
  const navigateNow = navigate;
  if (!navigateNow) throw new Error("Billing success router is not mounted");
  const suffix = search ? `?${search}` : "";
  act(() => navigateNow(`/cloud/billing/success${suffix}`));
}

function expectNoSuccess(): void {
  expect(screen.queryByText("Purchase Successful!")).toBeNull();
  expect(screen.queryByTestId("credit-balance")).toBeNull();
}

function resolveRequest(
  index: number,
  data: { success: boolean; balance: number; alreadyApplied: boolean },
): void {
  const request = verifyState.requests[index];
  if (!request) throw new Error(`Missing verification request ${index}`);
  act(() => request.callbacks.onSuccess(data));
}

function resolveRuntimePayload(index: number, data: unknown): void {
  const request = verifyState.requests[index];
  if (!request) throw new Error(`Missing verification request ${index}`);
  act(() => request.callbacks.onSuccess(data as never));
}

function rejectRequest(index: number, error: Error): void {
  const request = verifyState.requests[index];
  if (!request) throw new Error(`Missing verification request ${index}`);
  act(() => request.callbacks.onError(error));
}

async function expectRequestCount(count: number): Promise<void> {
  await waitFor(() => {
    expect(verifyState.mutate).toHaveBeenCalledTimes(count);
  });
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  navigate = null;
  sessionState.ready = true;
  sessionState.authenticated = true;
  sessionState.user = { id: "user-a", email: "a@example.test" };
  verifyState.mutate.mockClear();
  verifyState.requests.splice(0);
  renderState.balance.mockClear();
  renderState.suspensions.mockClear();
  renderState.successTitle.mockClear();
  checkoutIntentState.clearVerifiedSession.mockClear();
  checkoutIntentState.clearVerifiedSession.mockResolvedValue({
    status: "cleared",
    source: "tab-pointer",
  });
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

  it("keeps idle verification away from success before the effect settles", async () => {
    renderPage();

    expect(
      screen.getByRole("status", { name: "Verifying payment" }),
    ).toBeTruthy();
    expectNoSuccess();
    await expectRequestCount(1);
    expect(verifyState.requests[0]?.input).toEqual({
      sessionId: "cs_paid",
      from: "settings",
    });
  });

  it("keeps pending verification away from success", async () => {
    const page = renderPage("session_id=cs_pending");
    page.rerender(pageTree("session_id=cs_pending"));

    expect(
      screen.getByRole("status", { name: "Verifying payment" }),
    ).toBeTruthy();
    expectNoSuccess();
    await expectRequestCount(1);
    expect(verifyState.requests[0]?.input).toEqual({
      sessionId: "cs_pending",
      from: undefined,
    });
  });

  it("starts one verification through StrictMode effect replay", async () => {
    render(<StrictMode>{pageTree("session_id=cs_strict")}</StrictMode>);

    await expectRequestCount(1);
    await flushMicrotasks();

    expect(verifyState.mutate).toHaveBeenCalledTimes(1);
    expect(verifyState.requests[0]?.input).toEqual({
      sessionId: "cs_strict",
      from: undefined,
    });
  });

  it("renders a verification rejection as an announced payment issue", async () => {
    renderPage();
    await expectRequestCount(1);
    rejectRequest(0, new Error("Checkout verification failed"));

    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.textContent).toContain("Checkout verification failed");
    expectNoSuccess();
    expect(verifyState.mutate).toHaveBeenCalledTimes(1);
  });

  it("rejects a resolved response whose success flag is false", async () => {
    renderPage();
    await expectRequestCount(1);
    resolveRequest(0, {
      success: false,
      balance: 42,
      alreadyApplied: false,
    });

    expect(screen.getByRole("alert").textContent).toContain("Payment Issue");
    expectNoSuccess();
    expect(verifyState.mutate).toHaveBeenCalledTimes(1);
    expect(checkoutIntentState.clearVerifiedSession).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["a primitive", "verified"],
    ["a malformed object", { success: "true" }],
  ])(
    "rejects %s returned by a successful HTTP callback",
    async (_label, data) => {
      renderPage();
      await expectRequestCount(1);

      resolveRuntimePayload(0, data);

      expect(screen.getByRole("alert").textContent).toContain("Payment Issue");
      expectNoSuccess();
      expect(verifyState.mutate).toHaveBeenCalledTimes(1);
      expect(checkoutIntentState.clearVerifiedSession).not.toHaveBeenCalled();
    },
  );

  it("renders purchase success only for a verified success payload", async () => {
    renderPage();
    await expectRequestCount(1);
    resolveRequest(0, {
      success: true,
      balance: 42,
      alreadyApplied: false,
    });

    expect(screen.getByText("Purchase Successful!")).toBeTruthy();
    expect(screen.getByTestId("credit-balance")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(verifyState.mutate).toHaveBeenCalledTimes(1);
    expect(checkoutIntentState.clearVerifiedSession).toHaveBeenCalledTimes(1);
    expect(checkoutIntentState.clearVerifiedSession).toHaveBeenCalledWith({
      sessionId: "cs_paid",
    });
  });

  it("keeps verified success visible when exact local cleanup fails", async () => {
    checkoutIntentState.clearVerifiedSession.mockRejectedValueOnce(
      new Error("storage denied"),
    );
    renderPage("session_id=cs_cleanup_failed&from=settings");
    await expectRequestCount(1);

    resolveRequest(0, {
      success: true,
      balance: 42,
      alreadyApplied: false,
    });

    expect(screen.getByText("Purchase Successful!")).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.getByText(/could not finish local checkout cleanup/i),
      ).toBeTruthy();
    });
    expect(screen.queryByText("Payment Issue")).toBeNull();
  });

  it("starts verification when a missing query gains a checkout session", async () => {
    renderPage("");

    navigatePage("session_id=cs_arrived&from=settings");

    expect(
      screen.getByRole("status", { name: "Verifying payment" }),
    ).toBeTruthy();
    expectNoSuccess();
    await expectRequestCount(1);
    expect(verifyState.requests[0]?.input).toEqual({
      sessionId: "cs_arrived",
      from: "settings",
    });
  });

  it("never reuses success when the same session returns after a missing query", async () => {
    renderPage("session_id=cs_returning&from=settings");
    await expectRequestCount(1);
    resolveRequest(0, {
      success: true,
      balance: 42,
      alreadyApplied: false,
    });
    expect(screen.getByText("Purchase Successful!")).toBeTruthy();

    renderState.balance.mockClear();
    renderState.successTitle.mockClear();
    navigatePage("");
    expect(screen.getByRole("alert")).toBeTruthy();
    expectNoSuccess();

    navigatePage("session_id=cs_returning&from=settings");
    expect(
      screen.getByRole("status", { name: "Verifying payment" }),
    ).toBeTruthy();
    expectNoSuccess();
    expect(renderState.successTitle).not.toHaveBeenCalled();
    expect(renderState.balance).not.toHaveBeenCalled();
    await expectRequestCount(2);

    resolveRequest(1, {
      success: true,
      balance: 42,
      alreadyApplied: false,
    });
    expect(screen.getByText("Purchase Successful!")).toBeTruthy();
    expect(renderState.successTitle).toHaveBeenCalled();
    expect(renderState.balance).toHaveBeenCalled();
  });

  it("keeps the committed verification live when a route transition is abandoned", async () => {
    renderPage("session_id=cs_transition&from=settings");
    await expectRequestCount(1);
    resolveRequest(0, {
      success: true,
      balance: 42,
      alreadyApplied: false,
    });
    expect(screen.getByText("Purchase Successful!")).toBeTruthy();

    const navigateNow = navigate;
    if (!navigateNow) throw new Error("Billing success router is not mounted");
    act(() => {
      startTransition(() => {
        navigateNow("/cloud/billing/success?suspend=1");
      });
    });
    await waitFor(() => {
      expect(renderState.suspensions).toHaveBeenCalled();
    });

    expect(screen.getByText("Purchase Successful!")).toBeTruthy();
    expect(screen.getByTestId("credit-balance")).toBeTruthy();
    expect(verifyState.mutate).toHaveBeenCalledTimes(1);

    act(() => {
      navigateNow(
        "/cloud/billing/success?session_id=cs_transition&from=settings&resume=1",
      );
    });
    await flushMicrotasks();

    expect(screen.getByText("Purchase Successful!")).toBeTruthy();
    expect(
      screen.queryByRole("status", { name: "Verifying payment" }),
    ).toBeNull();
    expect(verifyState.mutate).toHaveBeenCalledTimes(1);
  });

  it("never reuses success when the same user logs back in", async () => {
    const page = renderPage("session_id=cs_reauth&from=settings");
    await expectRequestCount(1);
    resolveRequest(0, {
      success: true,
      balance: 42,
      alreadyApplied: false,
    });
    expect(screen.getByText("Purchase Successful!")).toBeTruthy();

    renderState.balance.mockClear();
    renderState.successTitle.mockClear();
    sessionState.authenticated = false;
    sessionState.user = null;
    page.rerender(pageTree("session_id=cs_reauth&from=settings"));
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    expectNoSuccess();

    sessionState.authenticated = true;
    sessionState.user = { id: "user-a", email: "a@example.test" };
    page.rerender(pageTree("session_id=cs_reauth&from=settings"));
    expect(
      screen.getByRole("status", { name: "Verifying payment" }),
    ).toBeTruthy();
    expectNoSuccess();
    expect(renderState.successTitle).not.toHaveBeenCalled();
    expect(renderState.balance).not.toHaveBeenCalled();
    await expectRequestCount(2);

    resolveRequest(1, {
      success: true,
      balance: 42,
      alreadyApplied: false,
    });
    expect(screen.getByText("Purchase Successful!")).toBeTruthy();
  });

  it("reverifies when the checkout session changes without remounting", async () => {
    renderPage("session_id=cs_a&from=settings");
    await expectRequestCount(1);
    resolveRequest(0, {
      success: true,
      balance: 42,
      alreadyApplied: false,
    });
    expect(screen.getByText("Purchase Successful!")).toBeTruthy();

    navigatePage("session_id=cs_b&from=settings");

    expect(
      screen.getByRole("status", { name: "Verifying payment" }),
    ).toBeTruthy();
    expectNoSuccess();
    await expectRequestCount(2);
    expect(verifyState.requests[1]?.input).toEqual({
      sessionId: "cs_b",
      from: "settings",
    });
  });

  it("reverifies when the authenticated user changes without remounting", async () => {
    const page = renderPage("session_id=cs_paid&from=settings");
    await expectRequestCount(1);
    resolveRequest(0, {
      success: true,
      balance: 42,
      alreadyApplied: false,
    });
    expect(screen.getByText("Purchase Successful!")).toBeTruthy();

    sessionState.user = { id: "user-b", email: "b@example.test" };
    page.rerender(pageTree("session_id=cs_paid&from=settings"));

    expect(
      screen.getByRole("status", { name: "Verifying payment" }),
    ).toBeTruthy();
    expectNoSuccess();
    await expectRequestCount(2);
  });

  it("reverifies when the checkout source changes without remounting", async () => {
    renderPage("session_id=cs_paid&from=settings");
    await expectRequestCount(1);
    resolveRequest(0, {
      success: true,
      balance: 42,
      alreadyApplied: false,
    });

    navigatePage("session_id=cs_paid");

    expect(
      screen.getByRole("status", { name: "Verifying payment" }),
    ).toBeTruthy();
    expectNoSuccess();
    await expectRequestCount(2);
    expect(verifyState.requests[1]?.input).toEqual({
      sessionId: "cs_paid",
      from: undefined,
    });
  });

  it("does not reverify when unrecognized source values change", async () => {
    renderPage("session_id=cs_paid&from=foo");
    await expectRequestCount(1);
    resolveRequest(0, {
      success: true,
      balance: 42,
      alreadyApplied: false,
    });

    navigatePage("session_id=cs_paid&from=bar");
    await flushMicrotasks();

    expect(screen.getByText("Purchase Successful!")).toBeTruthy();
    expect(verifyState.mutate).toHaveBeenCalledTimes(1);
    expect(verifyState.requests[0]?.input).toEqual({
      sessionId: "cs_paid",
      from: undefined,
    });
  });

  it("ignores an old session completion after a newer verification settles", async () => {
    renderPage("session_id=cs_a&from=settings");
    await expectRequestCount(1);
    navigatePage("session_id=cs_b&from=settings");
    await expectRequestCount(2);

    resolveRequest(1, {
      success: false,
      balance: 42,
      alreadyApplied: false,
    });
    expect(screen.getByRole("alert").textContent).toContain("Payment Issue");
    expectNoSuccess();

    resolveRequest(0, {
      success: true,
      balance: 99,
      alreadyApplied: false,
    });
    expect(screen.getByRole("alert").textContent).toContain("Payment Issue");
    expectNoSuccess();
    expect(checkoutIntentState.clearVerifiedSession).not.toHaveBeenCalled();
  });

  it("invalidates verification callbacks when the page unmounts", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const page = renderPage("session_id=cs_abandoned&from=settings");
      await expectRequestCount(1);

      page.unmount();
      resolveRequest(0, {
        success: true,
        balance: 99,
        alreadyApplied: false,
      });

      expect(consoleError).not.toHaveBeenCalled();
      expect(checkoutIntentState.clearVerifiedSession).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
