/**
 * Verifies the Billing surface resolves every auth and account-query branch to
 * a canonical loading, terminal, recovery, or content state.
 */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSurfaceProvider } from "../../agent-surface/AgentSurfaceContext";
import { getOrCreateViewRegistry } from "../../agent-surface/registry";

const billingUser = vi.hoisted(() => ({
  value: {
    user: null as { id: string; organization_id: string } | null,
    isPending: true,
    isFetching: false,
    isPaused: false,
    isFetchedAfterMount: false,
    isReady: false,
    isAuthenticated: false,
    isError: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
}));
const billingUserOptions = vi.hoisted(() => ({
  current: null as { requireFreshOrganization?: boolean } | null,
}));

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

vi.mock("./data/billing-data", () => ({
  useBillingUser: (options?: { requireFreshOrganization?: boolean }) => {
    billingUserOptions.current = options ?? null;
    return billingUser.value;
  },
}));

vi.mock("./components/billing-tab", () => ({
  BillingTab: ({ user }: { user: { id: string } }) => (
    <div>Billing content for {user.id}</div>
  ),
}));

vi.mock("./wallet/ConditionalWalletProviders", () => ({
  ConditionalWalletProviders: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

import { BillingSectionBody } from "./BillingSection";

function setBillingState(
  state: Partial<Omit<typeof billingUser.value, "refetch">>,
) {
  Object.assign(billingUser.value, state);
}

function renderBillingSurface(
  props: ComponentProps<typeof BillingSectionBody> = {},
) {
  const viewId = `billing-surface-test-${crypto.randomUUID()}`;
  const registry = getOrCreateViewRegistry(viewId, "gui");
  const view = render(
    <AgentSurfaceProvider viewId={viewId} viewType="gui">
      <BillingSectionBody {...props} />
    </AgentSurfaceProvider>,
  );
  return { registry, view, viewId };
}

describe("BillingSectionBody", () => {
  afterEach(() => {
    cleanup();
    billingUserOptions.current = null;
    billingUser.value = {
      user: null,
      isPending: true,
      isFetching: false,
      isPaused: false,
      isFetchedAfterMount: false,
      isReady: false,
      isAuthenticated: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
    window.history.replaceState(null, "", "/");
  });

  it("loads only while authentication is unresolved", () => {
    renderBillingSurface();
    expect(
      screen.getByRole("status", { name: "Loading billing" }),
    ).toBeTruthy();
  });

  it("renders a terminal sign-in state once authentication settles signed out", () => {
    setBillingState({ isReady: true });
    window.history.replaceState(null, "", "/settings#cloud-billing");
    const { registry } = renderBillingSurface();

    expect(screen.getByText("Sign in required")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/login?returnTo=%2Fsettings%23cloud-billing");
    expect(screen.getByRole("link", { name: "Sign in" }).className).toMatch(
      /keyboard-focus-surface/,
    );
    const descriptor = registry.describe("cloud-billing-sign-in");
    expect(descriptor?.role).toBe("link");
    expect(descriptor?.clickable).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("uses an injected host login action instead of local navigation", () => {
    const onSignIn = vi.fn();
    setBillingState({ isReady: true });
    renderBillingSurface({ onSignIn });

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignIn).toHaveBeenCalledOnce();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  });

  it("becomes agent-activatable after an initially busy login settles", () => {
    const onSignIn = vi.fn();
    setBillingState({ isReady: true });
    const { registry, view, viewId } = renderBillingSurface({
      onSignIn,
      signInBusy: true,
    });

    expect(registry.click("cloud-billing-sign-in").ok).toBe(false);
    expect(onSignIn).not.toHaveBeenCalled();

    view.rerender(
      <AgentSurfaceProvider viewId={viewId} viewType="gui">
        <BillingSectionBody onSignIn={onSignIn} signInBusy={false} />
      </AgentSurfaceProvider>,
    );
    expect(registry.click("cloud-billing-sign-in").ok).toBe(true);
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it("loads while the authenticated account query remains pending", () => {
    setBillingState({ isReady: true, isAuthenticated: true });
    renderBillingSurface();

    expect(
      screen.getByRole("status", { name: "Loading billing" }),
    ).toBeTruthy();
  });

  it("renders the query error and retries the account request", () => {
    const error = new Error("Billing profile service is offline");
    setBillingState({
      isReady: true,
      isAuthenticated: true,
      isPending: false,
      isFetchedAfterMount: true,
      isError: true,
      error,
    });
    renderBillingSurface();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("alert").textContent).toContain(error.message);
    expect(billingUser.value.refetch).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([
    { isFetching: true, isPaused: false },
    { isFetching: false, isPaused: true },
  ])("disables retry while recovery is pending (%j)", (pendingState) => {
    setBillingState({
      isReady: true,
      isAuthenticated: true,
      isPending: false,
      ...pendingState,
      isFetchedAfterMount: true,
      isError: true,
      error: new Error("Billing profile service is offline"),
    });
    const { registry, view, viewId } = renderBillingSurface();

    const retry = screen.getByRole("button", { name: "Retrying…" });
    expect(retry).toHaveProperty("disabled", true);
    expect(retry.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(retry);
    expect(registry.click("cloud-billing-retry").ok).toBe(false);
    expect(billingUser.value.refetch).not.toHaveBeenCalled();

    setBillingState({ isFetching: false, isPaused: false });
    view.rerender(
      <AgentSurfaceProvider viewId={viewId} viewType="gui">
        <BillingSectionBody />
      </AgentSurfaceProvider>,
    );
    expect(registry.click("cloud-billing-retry").ok).toBe(true);
    expect(billingUser.value.refetch).toHaveBeenCalledOnce();
  });

  it("renders a terminal unavailable state when the account query settles empty", () => {
    setBillingState({
      isReady: true,
      isAuthenticated: true,
      isPending: false,
      isFetchedAfterMount: true,
    });
    renderBillingSurface();

    const text = document.body.textContent ?? "";
    expect(screen.getByText("Billing unavailable")).toBeTruthy();
    expect(text).toContain("no billing account is available");
    expect(text).not.toMatch(/organization/i);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([
    { isFetching: true, isPaused: false, isFetchedAfterMount: false },
    { isFetching: false, isPaused: true, isFetchedAfterMount: false },
    { isFetching: false, isPaused: false, isFetchedAfterMount: false },
  ])(
    "does not paint cached billing before fresh membership is confirmed (%j)",
    (refreshState) => {
      setBillingState({
        user: { id: "user-1", organization_id: "old-org" },
        isReady: true,
        isAuthenticated: true,
        isPending: false,
        ...refreshState,
      });
      renderBillingSurface();

      expect(
        screen.getByRole("status", { name: "Loading billing" }),
      ).toBeTruthy();
      expect(screen.queryByText(/Billing content/)).toBeNull();
    },
  );

  it("renders consumer billing once the account resolves", () => {
    setBillingState({
      user: { id: "user-1", organization_id: "org-1" },
      isReady: true,
      isAuthenticated: true,
      isPending: false,
      isFetchedAfterMount: true,
    });
    renderBillingSurface();

    expect(screen.getByText("Billing content for user-1")).toBeTruthy();
    expect(billingUserOptions.current).toEqual({
      requireFreshOrganization: true,
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
