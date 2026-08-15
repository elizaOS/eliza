/**
 * Renders OrganizationGeneralTab through SettingsRow and asserts labelled
 * status fields, inactive badge, and omitted billing email. jsdom, no backend.
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { OrganizationDto } from "./data/cloud-org-types";
import { OrganizationGeneralTab } from "./organization-general-tab";

function makeOrg(overrides: Partial<OrganizationDto> = {}): OrganizationDto {
  return {
    id: "org-1",
    name: "Sol's Organization",
    slug: "sols-org",
    credit_balance: "1250",
    billing_email: "billing@example.com",
    is_active: true,
    created_at: "2026-03-15T12:00:00.000Z",
    updated_at: "2026-03-15T12:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("OrganizationGeneralTab", () => {
  it("renders labelled organization and billing readouts", () => {
    render(<OrganizationGeneralTab organization={makeOrg()} />);

    expect(screen.getByText("Organization details")).toBeTruthy();
    expect(screen.getByText("Organization name")).toBeTruthy();
    expect(screen.getByText("Sol's Organization")).toBeTruthy();
    expect(screen.getByText("Organization slug")).toBeTruthy();
    expect(screen.getByText("sols-org")).toBeTruthy();
    expect(screen.getByText("Status")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Created")).toBeTruthy();
    expect(screen.getByText("Mar 15, 2026")).toBeTruthy();
    expect(screen.getByText("Billing information")).toBeTruthy();
    expect(screen.getByText("Credit balance")).toBeTruthy();
    expect(screen.getByText("1,250 credits")).toBeTruthy();
    expect(screen.getByText("Billing email")).toBeTruthy();
    expect(screen.getByText("billing@example.com")).toBeTruthy();
  });

  it("shows Inactive and omits billing email when those fields are empty", () => {
    render(
      <OrganizationGeneralTab
        organization={makeOrg({ is_active: false, billing_email: null })}
      />,
    );

    expect(screen.getByText("Inactive")).toBeTruthy();
    expect(screen.queryByText("Active")).toBeNull();
    expect(screen.queryByText("Billing email")).toBeNull();
    expect(screen.getByText("Credit balance")).toBeTruthy();
  });
});
