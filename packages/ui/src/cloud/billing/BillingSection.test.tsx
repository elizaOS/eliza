/**
 * Billing surface fallback states. Asserts the no-account branch renders the
 * account-first copy and never surfaces Organization language — the console
 * presents as plain per-user accounts (#14298, follow-up to #14282).
 */

// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const billingUser = vi.hoisted(() => ({
  value: {
    user: null as unknown,
    isLoading: false,
    isFetching: false,
    isPaused: false,
    isFetchedAfterMount: true,
    isAuthenticated: true,
    isError: false,
    error: null as unknown,
  },
}));
const billingUserOptions = vi.hoisted(() => ({
  current: null as { requireFreshOrganization?: boolean } | null,
}));
vi.mock("@elizaos/ui/cloud-ui", () => ({
  DashboardErrorState: ({ message }: { message: string }) => (
    <div role="alert">{message}</div>
  ),
  DashboardLoadingState: ({ label }: { label: string }) => <div>{label}</div>,
}));

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? key,
}));

vi.mock("./data/billing-data", () => ({
  useBillingUser: (options?: { requireFreshOrganization?: boolean }) => {
    billingUserOptions.current = options ?? null;
    return billingUser.value;
  },
}));

vi.mock("./components/billing-tab", () => ({
  BillingTab: () => <div>billing tab</div>,
}));

vi.mock("./wallet/ConditionalWalletProviders", () => ({
  ConditionalWalletProviders: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

import { BillingSectionBody } from "./BillingSection";

describe("BillingSectionBody", () => {
  afterEach(() => {
    cleanup();
    billingUserOptions.current = null;
    billingUser.value = {
      user: null,
      isLoading: false,
      isFetching: false,
      isPaused: false,
      isFetchedAfterMount: true,
      isAuthenticated: true,
      isError: false,
      error: null,
    };
  });

  it("renders account-first copy with no Organization language when the account is missing", () => {
    const { container } = render(<BillingSectionBody />);
    const text = container.textContent ?? "";

    expect(text).toContain("No account found for billing");
    expect(text).not.toMatch(/organization/i);
  });

  it("renders consumer billing without internal infrastructure limits once the account resolves", () => {
    billingUser.value = {
      user: { organization_id: "org-1" },
      isLoading: false,
      isFetching: false,
      isPaused: false,
      isFetchedAfterMount: true,
      isAuthenticated: true,
      isError: false,
      error: null,
    };
    const { container } = render(<BillingSectionBody />);
    const text = container.textContent ?? "";
    expect(text).toContain("billing tab");
    expect(text).not.toContain("account limits card");
    expect(billingUserOptions.current).toEqual({
      requireFreshOrganization: true,
    });
  });

  it("does not paint cached billing or limits while organization membership refreshes", () => {
    billingUser.value = {
      user: { organization_id: "old-org" },
      isLoading: false,
      isFetching: true,
      isPaused: false,
      isFetchedAfterMount: false,
      isAuthenticated: true,
      isError: false,
      error: null,
    };

    const { container } = render(<BillingSectionBody />);
    const text = container.textContent ?? "";
    expect(text).toContain("Loading billing");
    expect(text).not.toContain("billing tab");
    expect(text).not.toContain("account limits card");
  });

  it("does not paint a cached organization while its membership refresh is paused", () => {
    billingUser.value = {
      user: { organization_id: "old-org" },
      isLoading: false,
      isFetching: false,
      isPaused: true,
      isFetchedAfterMount: false,
      isAuthenticated: true,
      isError: false,
      error: null,
    };

    const { container } = render(<BillingSectionBody />);
    const text = container.textContent ?? "";
    expect(text).toContain("Loading billing");
    expect(text).not.toContain("billing tab");
    expect(text).not.toContain("account limits card");
  });

  it("does not paint a cached organization before this mount confirms membership", () => {
    billingUser.value = {
      user: { organization_id: "old-org" },
      isLoading: false,
      isFetching: false,
      isPaused: false,
      isFetchedAfterMount: false,
      isAuthenticated: true,
      isError: false,
      error: null,
    };

    const { container } = render(<BillingSectionBody />);
    const text = container.textContent ?? "";
    expect(text).toContain("Loading billing");
    expect(text).not.toContain("billing tab");
    expect(text).not.toContain("account limits card");
  });
});
