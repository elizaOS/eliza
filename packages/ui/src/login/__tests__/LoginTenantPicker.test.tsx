/**
 * <LoginTenantPicker /> branch coverage.
 *
 * The dropdown menu opens via state (starts closed) so SSR renders the closed
 * trigger for the dropdown variant; the always-visible list variant renders
 * its items directly. We assert:
 *   - returns null when unauthenticated
 *   - returns null when the SDK lacks tenant methods (no listTenants/switchTenant)
 *   - loading state (tenants null + isTenantsLoading)
 *   - empty state (tenants === [])
 *   - list variant renders each membership with name + role
 *   - active membership is marked + disabled
 *   - dropdown variant renders the active tenant name in the trigger
 */

import * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";

const { LoginTenantPicker } = await import(
  "../components/LoginTenantPicker.js"
);
const { LoginAuthContext } = await import("../provider.js");

const TENANTS = [
  { tenantId: "app-a", tenantName: "Acme App", role: "owner" },
  { tenantId: "app-b", tenantName: "Beta App", role: "member" },
];

function ctx(overrides: Record<string, unknown>): any {
  return {
    isAuthenticated: true,
    isLoading: false,
    user: { id: "u1", email: "u@x.io" },
    session: null,
    providers: null,
    isProvidersLoading: false,
    signOut: () => {},
    getToken: () => null,
    activeTenantId: null,
    tenants: null,
    isTenantsLoading: false,
    listTenants: async () => [],
    switchTenant: async () => false,
    ...overrides,
  };
}

function render(value: unknown, props: Record<string, unknown> = {}) {
  return renderToString(
    React.createElement(
      LoginAuthContext.Provider,
      { value: value as React.ContextType<typeof LoginAuthContext> },
      React.createElement(LoginTenantPicker, props),
    ),
  );
}

describe("<LoginTenantPicker /> branch coverage", () => {
  test("returns null when unauthenticated", () => {
    expect(render(ctx({ isAuthenticated: false }))).toBe("");
  });

  test("returns null when the SDK lacks tenant methods", () => {
    expect(
      render(ctx({ listTenants: undefined, switchTenant: undefined })),
    ).toBe("");
  });

  test("loading state renders the loading label", () => {
    const html = render(ctx({ tenants: null, isTenantsLoading: true }));
    expect(html).toContain("Loading apps");
  });

  test("empty state renders 'No apps connected'", () => {
    const html = render(ctx({ tenants: [] }));
    expect(html).toContain("No apps connected");
  });

  test("list variant renders each membership name and role", () => {
    const html = render(ctx({ tenants: TENANTS, activeTenantId: "app-a" }), {
      variant: "list",
    });
    expect(html).toContain("stwd-tenant-picker--list");
    expect(html).toContain("Acme App");
    expect(html).toContain("Beta App");
    expect(html).toContain("owner");
    expect(html).toContain("member");
  });

  test("list variant marks the active membership and disables it", () => {
    const html = render(ctx({ tenants: TENANTS, activeTenantId: "app-a" }), {
      variant: "list",
    });
    expect(html).toContain("stwd-tenant-picker__item--active");
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("disabled");
  });

  test("dropdown variant renders the active tenant name in the trigger (menu closed)", () => {
    const html = render(ctx({ tenants: TENANTS, activeTenantId: "app-b" }), {
      variant: "dropdown",
    });
    expect(html).toContain("stwd-tenant-picker--dropdown");
    expect(html).toContain("stwd-tenant-picker__trigger");
    expect(html).toContain("Beta App");
    expect(html).toContain('aria-expanded="false"');
    // closed menu => the expandable __menu container is not rendered yet
    expect(html).not.toContain("stwd-tenant-picker__menu");
  });

  test("dropdown trigger falls back to activeTenantId when no matching membership name", () => {
    const html = render(ctx({ tenants: TENANTS, activeTenantId: "app-zzz" }), {
      variant: "dropdown",
    });
    expect(html).toContain("app-zzz");
  });
});
