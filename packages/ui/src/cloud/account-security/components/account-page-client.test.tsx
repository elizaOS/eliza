/**
 * The account page renders the profile form + account-details card and — since
 * the console presents plain per-user accounts — shows NO org/welcome banner,
 * even when the user has an organization. Lower panels are mocked.
 */

// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../data/user";
import { AccountPageClient } from "./account-page-client";

const setPageHeaderMock = vi.hoisted(() => vi.fn());

vi.mock("../../../cloud-ui", () => ({
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

function makeUser(): UserProfile {
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
      name: "Sol's Organization",
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

  it("renders the profile form + account details, with no org/welcome banner", () => {
    const { container } = render(<AccountPageClient user={makeUser()} />);
    const text = container.textContent ?? "";

    expect(text).toContain("profile form");
    expect(text).toContain("account details");
    // Per-user-account console: no org surfacing even when one exists.
    expect(text).not.toMatch(/Welcome back/i);
    expect(text).not.toMatch(/You're part of/i);
    expect(text).not.toMatch(/organization/i);
    expect(setPageHeaderMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Account" }),
    );
  });
});
