/**
 * Renders AccountDetails through SettingsRow and asserts labelled 1:1
 * readouts, verification badge, and omitted optional rows. jsdom, no backend.
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../data/user";
import { AccountDetails } from "./account-details";

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

function makeUser(overrides: Partial<UserProfile> = {}): UserProfile {
  const now = new Date("2026-03-15T12:00:00.000Z");
  return {
    id: "user-1",
    email: "user@example.com",
    email_verified: true,
    wallet_address: null,
    wallet_chain_type: null,
    wallet_verified: false,
    name: null,
    avatar: null,
    organization_id: null,
    role: "member",
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
    email_notifications: null,
    response_notifications: null,
    is_active: true,
    created_at: now,
    updated_at: now,
    organization: {
      id: "org-1",
      name: "Example Org",
      slug: "example-org",
      billing_email: null,
      credit_balance: "0",
      is_active: true,
      created_at: now,
      updated_at: now,
    },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("AccountDetails", () => {
  it("renders labelled account id, verified email, and member since", () => {
    render(<AccountDetails user={makeUser()} />);

    expect(screen.getByText("Account details")).toBeTruthy();
    expect(screen.getByText("Account ID")).toBeTruthy();
    expect(screen.getByText("user-1")).toBeTruthy();
    expect(screen.getByText("Email")).toBeTruthy();
    expect(screen.getByText("user@example.com")).toBeTruthy();
    expect(screen.getByText("Verified")).toBeTruthy();
    expect(screen.getByText("Member since")).toBeTruthy();
    expect(screen.queryByText("Unverified")).toBeNull();
  });

  it("shows unverified when email is present but not verified", () => {
    render(<AccountDetails user={makeUser({ email_verified: false })} />);

    expect(screen.getByText("Unverified")).toBeTruthy();
    expect(screen.queryByText("Verified")).toBeNull();
  });

  it("omits the email row when the account has no email", () => {
    render(<AccountDetails user={makeUser({ email: null })} />);

    expect(screen.getByText("Account ID")).toBeTruthy();
    expect(screen.queryByText("Email")).toBeNull();
    expect(screen.queryByText("Verified")).toBeNull();
    expect(screen.queryByText("Unverified")).toBeNull();
  });
});
