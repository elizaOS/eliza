/** Verifies the first-class Vault page's owner gate and shared manager seam. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoleProvider } from "../../hooks/useRole";
import { VaultPageView } from "./VaultPageView";

vi.mock("../settings/SecretsManagerSection", () => ({
  VaultWorkspace: () => <div data-testid="vault-workspace" />,
}));

vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: ReactNode }) => children,
}));

afterEach(cleanup);

describe("VaultPageView", () => {
  it("renders the shared Vault manager for the workspace owner", () => {
    render(
      // `role` is an Eliza authorization tier, not an ARIA role.
      // biome-ignore lint/a11y/useValidAriaRole: RoleProvider.role is a canonical role tier.
      <RoleProvider role="OWNER">
        <VaultPageView />
      </RoleProvider>,
    );
    expect(screen.getByTestId("vault-workspace")).toBeTruthy();
    expect(
      screen
        .getByTestId("vault-page")
        .className.includes("--eliza-chat-clearance"),
    ).toBe(true);
    expect(
      screen
        .getByTestId("vault-page")
        .getAttribute("data-chat-clearance-aware"),
    ).toBe("true");
  });

  it("fails closed for lower-tier roles", () => {
    render(
      // `role` is an Eliza authorization tier, not an ARIA role.
      // biome-ignore lint/a11y/useValidAriaRole: RoleProvider.role is a canonical role tier.
      <RoleProvider role="ADMIN">
        <VaultPageView />
      </RoleProvider>,
    );
    expect(screen.queryByTestId("vault-workspace")).toBeNull();
    expect(screen.getByText(/workspace owner only/i)).toBeTruthy();
  });
});
