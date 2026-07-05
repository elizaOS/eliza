/**
 * Account page banner tests for generated and manually named organizations.
 * Lower panels are mocked so the assertions stay focused on welcome-card copy
 * and shell-header publication.
 */

// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../data/user";
import { AccountPageClient } from "./account-page-client";

const setPageHeaderMock = vi.hoisted(() => vi.fn());

vi.mock("../../../cloud-ui", () => ({
  BrandCard: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
  CornerBrackets: () => null,
  DashboardPageContainer: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
  useSetPageHeader: setPageHeaderMock,
}));

vi.mock("./account-details", () => ({
  AccountDetails: () => <div>account details</div>,
}));

vi.mock("./organization-info", () => ({
  OrganizationInfo: () => <div>organization info</div>,
}));

vi.mock("./profile-form", () => ({
  ProfileForm: () => <div>profile form</div>,
}));

function makeUser(organizationName: string): UserProfile {
  const now = new Date("2026-07-05T00:00:00.000Z");
  return {
    id: "user-1",
    email: "user@example.com",
    email_verified: true,
    wallet_address: "0x1234567890abcdef",
    wallet_chain_type: "evm",
    wallet_verified: true,
    name: null,
    avatar: null,
    organization_id: "org-1",
    role: "owner",
    steward_user_id: null,
    telegram_id: null,
    telegram_username: null,
    telegram_first_name: null,
    telegram_photo_url: null,
    discord_id: null,
    discord_username: null,
    discord_global_name: null,
    discord_avatar_url: null,
    whatsapp_id: null,
    whatsapp_name: null,
    phone_number: null,
    phone_verified: null,
    is_anonymous: false,
    anonymous_session_id: null,
    expires_at: null,
    nickname: null,
    work_function: null,
    preferences: null,
    email_notifications: true,
    response_notifications: true,
    is_active: true,
    created_at: now,
    updated_at: now,
    organization: {
      id: "org-1",
      name: organizationName,
      slug: "org-1",
      billing_email: null,
      credit_balance: "0",
      is_active: true,
      created_at: now,
      updated_at: now,
    },
  };
}

describe("AccountPageClient", () => {
  afterEach(() => {
    cleanup();
    setPageHeaderMock.mockReset();
  });

  it("does not append a second organization noun to generated org names", () => {
    const { container } = render(
      <AccountPageClient user={makeUser("0x1234's Organization")} />,
    );
    const text = container.textContent ?? "";

    expect(text).toContain("You're part of 0x1234's Organization");
    expect(text).not.toMatch(/Organization organization/i);
    expect(setPageHeaderMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Account" }),
    );
  });

  it("does not append an organization noun to custom org names", () => {
    const { container } = render(
      <AccountPageClient user={makeUser("Team Sol")} />,
    );

    expect(container.textContent).toContain("You're part of Team Sol");
    expect(container.textContent).not.toMatch(/Team Sol organization/i);
  });
});
