/**
 * Account page tests for the account-first presentation. The fixture still
 * carries tenancy data so the page proves it does not promote organization
 * language from the user record.
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

  it("keeps organization data out of the welcome card", () => {
    const { container } = render(
      <AccountPageClient user={makeUser("0x1234's Organization")} />,
    );
    const text = container.textContent ?? "";

    expect(text).toContain("Welcome back, user@example.com!");
    expect(text).not.toContain("You're part of");
    expect(text).not.toContain("0x1234's Organization");
    expect(setPageHeaderMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Account" }),
    );
  });

  it("does not render the Organization card on the Account page", () => {
    const { container } = render(
      <AccountPageClient user={makeUser("Team Sol")} />,
    );

    expect(container.textContent).toContain("profile form");
    expect(container.textContent).toContain("account details");
    expect(container.textContent).not.toContain("organization info");
    expect(container.textContent).not.toContain("Team Sol");
  });
});
