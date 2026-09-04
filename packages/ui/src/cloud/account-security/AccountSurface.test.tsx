/**
 * Verifies the Account settings surface resolves every auth and profile-query
 * branch to the canonical loading, terminal, recovery, or content state.
 */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSurfaceProvider } from "../../agent-surface/AgentSurfaceContext";
import { getOrCreateViewRegistry } from "../../agent-surface/registry";
import { PageHeaderProvider, usePageHeader } from "../../cloud-ui";

const accountState = vi.hoisted(() => ({
  value: {
    user: null as { id: string } | null,
    isPending: true,
    isFetching: true,
    isReady: false,
    isAuthenticated: false,
    isError: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
}));

vi.mock("./data/user", () => ({
  useUserProfile: () => accountState.value,
}));

vi.mock("./components/account-page-client", () => ({
  AccountPageClient: ({ user }: { user: { id: string } }) => (
    <div>Account content for {user.id}</div>
  ),
}));

vi.mock("../lib/use-document-title", () => ({
  useDocumentTitle: vi.fn(),
}));

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

import { AccountSurface } from "./AccountSurface";

function setAccountState(
  state: Partial<Omit<typeof accountState.value, "refetch">>,
) {
  Object.assign(accountState.value, state);
}

function HeaderProbe() {
  const { pageInfo } = usePageHeader();
  return <div data-testid="page-header">{pageInfo?.title}</div>;
}

function renderAccountSurface(
  props: ComponentProps<typeof AccountSurface> = {},
) {
  const viewId = `account-surface-test-${crypto.randomUUID()}`;
  const registry = getOrCreateViewRegistry(viewId, "gui");
  const view = render(
    <PageHeaderProvider>
      <HeaderProbe />
      <AgentSurfaceProvider viewId={viewId} viewType="gui">
        <AccountSurface {...props} />
      </AgentSurfaceProvider>
    </PageHeaderProvider>,
  );

  expect(screen.getByTestId("page-header").textContent).toBe("Account");
  return { registry, view, viewId };
}

describe("AccountSurface", () => {
  afterEach(() => {
    cleanup();
    accountState.value = {
      user: null,
      isPending: true,
      isFetching: true,
      isReady: false,
      isAuthenticated: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
    window.history.replaceState(null, "", "/");
  });

  it("loads only while authentication is unresolved", () => {
    renderAccountSurface();

    expect(
      screen.getByRole("status", { name: "Loading account" }),
    ).toBeTruthy();
  });

  it("renders a terminal sign-in state once authentication settles signed out", () => {
    setAccountState({ isReady: true });
    window.history.replaceState(null, "", "/settings#cloud-account");

    renderAccountSurface();

    expect(screen.getByText("Sign in required")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/login?returnTo=%2Fsettings%23cloud-account");
    expect(screen.getByRole("link", { name: "Sign in" }).className).toMatch(
      /keyboard-focus-surface/,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("uses an injected host login action instead of local navigation", () => {
    const onSignIn = vi.fn();
    setAccountState({ isReady: true });

    renderAccountSurface({ onSignIn });
    const signIn = screen.getByRole("button", { name: "Sign in" });
    fireEvent.click(signIn);

    expect(onSignIn).toHaveBeenCalledOnce();
    expect(signIn.className).toMatch(/keyboard-focus-surface/);
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  });

  it("becomes agent-activatable after an initially busy login settles", () => {
    const onSignIn = vi.fn();
    setAccountState({ isReady: true });

    const { registry, view, viewId } = renderAccountSurface({
      onSignIn,
      signInBusy: true,
    });
    expect(registry.click("cloud-account-sign-in").ok).toBe(false);
    expect(onSignIn).not.toHaveBeenCalled();

    view.rerender(
      <PageHeaderProvider>
        <HeaderProbe />
        <AgentSurfaceProvider viewId={viewId} viewType="gui">
          <AccountSurface onSignIn={onSignIn} signInBusy={false} />
        </AgentSurfaceProvider>
      </PageHeaderProvider>,
    );
    expect(registry.click("cloud-account-sign-in").ok).toBe(true);
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it("loads while the authenticated profile query remains pending when paused", () => {
    setAccountState({
      isReady: true,
      isAuthenticated: true,
    });

    renderAccountSurface();

    expect(
      screen.getByRole("status", { name: "Loading account" }),
    ).toBeTruthy();
  });

  it("renders the query error and retries the profile request", () => {
    const error = new Error("Profile service is offline");
    setAccountState({
      isReady: true,
      isAuthenticated: true,
      isPending: false,
      isFetching: false,
      isError: true,
      error,
    });

    renderAccountSurface();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(screen.getByRole("alert").textContent).toContain(error.message);
    expect(accountState.value.refetch).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Retry" }).className).toMatch(
      /keyboard-focus-surface/,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("disables retry and announces progress while refetching", () => {
    setAccountState({
      isReady: true,
      isAuthenticated: true,
      isPending: false,
      isFetching: true,
      isError: true,
      error: new Error("Profile service is offline"),
    });

    renderAccountSurface();

    const retry = screen.getByRole("button", { name: "Retrying…" });
    expect(retry).toHaveProperty("disabled", true);
    expect(retry.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(retry);
    expect(accountState.value.refetch).not.toHaveBeenCalled();
  });

  it("renders a terminal unavailable state when the profile query settles empty", () => {
    setAccountState({
      isReady: true,
      isAuthenticated: true,
      isPending: false,
    });

    renderAccountSurface();

    expect(screen.getByText("Account unavailable")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders account content when the profile resolves", () => {
    setAccountState({
      isReady: true,
      isAuthenticated: true,
      isPending: false,
      user: { id: "user-1" },
    });

    renderAccountSurface();

    expect(screen.getByText("Account content for user-1")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
