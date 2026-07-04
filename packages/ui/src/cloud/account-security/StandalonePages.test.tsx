// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
  it("wraps the account surface in a page-header provider", () => {
    render(<AccountPage />);
    expect(screen.getByText("account body")).toBeTruthy();
  });

  it("wraps the security surface in a page-header provider", () => {
    render(<SecurityPage />);
    expect(screen.getByText("security body")).toBeTruthy();
  });

  it("wraps the permissions surface in a page-header provider", () => {
    render(<PermissionsPage />);
    expect(screen.getByText("permissions body")).toBeTruthy();
  });
});
