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
    isAuthenticated: true,
    isError: false,
    error: null as unknown,
  },
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
  useBillingUser: () => billingUser.value,
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
    billingUser.value = {
      user: null,
      isLoading: false,
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

  it("renders the billing tab once the account resolves", () => {
    billingUser.value = {
      user: { organization_id: "org-1" },
      isLoading: false,
      isAuthenticated: true,
      isError: false,
      error: null,
    };
    const { container } = render(<BillingSectionBody />);
    expect(container.textContent ?? "").toContain("billing tab");
  });
});
