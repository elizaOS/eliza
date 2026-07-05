// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { PageHeaderProvider } from "../../cloud-ui";

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

vi.mock("./AccountSurface", async () => {
  const { useSetPageHeader } =
    await vi.importActual<typeof import("../../cloud-ui")>("../../cloud-ui");
  return {
    AccountSurface: () => {
      useSetPageHeader({ title: "Account" });
      return <div>account body</div>;
    },
  };
});

vi.mock("./SecuritySurface", async () => {
  const { useSetPageHeader } =
    await vi.importActual<typeof import("../../cloud-ui")>("../../cloud-ui");
  return {
    SecuritySurface: () => {
      useSetPageHeader({ title: "Security" });
      return <div>security body</div>;
    },
  };
});

vi.mock("./PermissionsSurface", async () => {
  const { useSetPageHeader } =
    await vi.importActual<typeof import("../../cloud-ui")>("../../cloud-ui");
  return {
    PermissionsSurface: () => {
      useSetPageHeader({ title: "Permissions" });
      return <div>permissions body</div>;
    },
  };
});

import { AccountPage } from "./AccountPage";
import { PermissionsPage } from "./PermissionsPage";
import { SecurityPage } from "./SecurityPage";

describe("account/security standalone pages", () => {
  it("publishes the account header into the outer (shell) provider", () => {
    // Router context: the page links to the de-navved Security page.
    render(
      <PageHeaderProvider>
        <MemoryRouter>
          <AccountPage />
        </MemoryRouter>
      </PageHeaderProvider>,
    );
    expect(screen.getByText("account body")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Sessions & security/ }),
    ).toBeTruthy();
  });

  it("publishes the security header into the outer (shell) provider", () => {
    render(
      <PageHeaderProvider>
        <SecurityPage />
      </PageHeaderProvider>,
    );
    expect(screen.getByText("security body")).toBeTruthy();
  });

  it("publishes the permissions header into the outer (shell) provider", () => {
    render(
      <PageHeaderProvider>
        <PermissionsPage />
      </PageHeaderProvider>,
    );
    expect(screen.getByText("permissions body")).toBeTruthy();
  });
});
