// @vitest-environment jsdom

/**
 * Regression tests for #10319: dashboard routes (apps/containers/instances/...)
 * threw `usePageHeader must be used within a PageHeaderProvider` when mounted
 * without an ancestor provider (CloudRouterShell mounts them standalone, and the
 * app mounts them natively).
 *
 * Two invariants are covered:
 *  1. `useSetPageHeader` requires a `PageHeaderProvider` — the throw the bug hit,
 *     and the no-throw every route entry now guarantees by supplying a provider.
 *  2. `DashboardRoutePage` is self-sufficient: it provides its own context when
 *     none exists (so it never throws), but defers to an ancestor provider when
 *     one is present (so a host's header chrome still sees the header it sets).
 */

import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardRoutePage } from "./dashboard-route-page";
import { PageHeaderProvider } from "./page-header-context";
import { usePageHeader, useSetPageHeader } from "./page-header-context.hooks";

afterEach(cleanup);

/** Reads the page header from the nearest provider so a test can assert on it. */
function HeaderProbe() {
  const { pageInfo } = usePageHeader();
  return <span data-testid="probe">{pageInfo?.title ?? "none"}</span>;
}

describe("useSetPageHeader provider invariant", () => {
  it("throws when no PageHeaderProvider ancestor is present", () => {
    // React logs the render error; silence it so the suite output stays clean.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useSetPageHeader({ title: "x" }))).toThrow(
      /PageHeaderProvider/,
    );
    spy.mockRestore();
  });

  it("does not throw when wrapped in a PageHeaderProvider", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PageHeaderProvider>{children}</PageHeaderProvider>
    );
    expect(() =>
      renderHook(() => useSetPageHeader({ title: "x" }), { wrapper }),
    ).not.toThrow();
  });
});

describe("DashboardRoutePage page-header self-sufficiency (#10319)", () => {
  it("renders and sets its header without an ancestor PageHeaderProvider", async () => {
    render(
      <DashboardRoutePage title="Standalone">
        <HeaderProbe />
        <span data-testid="body">content</span>
      </DashboardRoutePage>,
    );

    // The body renders (no "must be used within a PageHeaderProvider" throw)...
    expect(screen.getByTestId("body").textContent).toBe("content");
    // ...and the self-provided context receives the header it published.
    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe("Standalone"),
    );
  });

  it("defers to an ancestor PageHeaderProvider instead of shadowing it", async () => {
    render(
      <PageHeaderProvider>
        <HeaderProbe />
        <DashboardRoutePage title="FromHost">
          <span>body</span>
        </DashboardRoutePage>
      </PageHeaderProvider>,
    );

    // The probe is a sibling reading the ANCESTOR provider. If DashboardRoutePage
    // had created its own nested provider, the ancestor would never see the
    // header and this would stay "none".
    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe("FromHost"),
    );
  });
});
