/**
 * Pure comparison coverage for Steward authority vs full projection parity,
 * including the phoneless legacy false/NULL phone_verified tuple.
 */

import { describe, expect, test } from "bun:test";
import type { UserIdentity } from "../schemas/user-identities";
import type { User } from "../schemas/users";
import {
  hasPhonelessLegacyPhoneVerifiedDrift,
  phoneVerifiedForNewRow,
  projectionMatchesUser,
  stewardAuthorityMatches,
} from "./user-identity-projection";

const NOW = new Date("2026-08-27T12:00:00.000Z");

function user(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "qa@example.com",
    email_verified: true,
    wallet_address: null,
    wallet_chain_type: null,
    wallet_verified: false,
    name: "QA",
    avatar: null,
    organization_id: "org-1",
    role: "owner",
    steward_user_id: "steward-1",
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
    phone_verified: false,
    is_anonymous: false,
    anonymous_session_id: null,
    expires_at: null,
    nickname: null,
    work_function: null,
    preferences: null,
    email_notifications: true,
    response_notifications: true,
    account_lifecycle_state: "active",
    account_lifecycle_revision: 0,
    account_deletion_request_id: null,
    auth_fenced_at: null,
    is_active: true,
    email_ciphertext: null,
    email_nonce: null,
    email_auth_tag: null,
    email_kms_key_id: null,
    email_kms_key_version: null,
    email_blind_index: null,
    phone_ciphertext: null,
    phone_nonce: null,
    phone_auth_tag: null,
    phone_kms_key_id: null,
    phone_kms_key_version: null,
    phone_blind_index: null,
    wallet_address_ciphertext: null,
    wallet_address_nonce: null,
    wallet_address_auth_tag: null,
    wallet_address_kms_key_id: null,
    wallet_address_kms_key_version: null,
    wallet_address_blind_index: null,
    telegram_id_ciphertext: null,
    telegram_id_nonce: null,
    telegram_id_auth_tag: null,
    telegram_id_kms_key_id: null,
    telegram_id_kms_key_version: null,
    discord_id_ciphertext: null,
    discord_id_nonce: null,
    discord_id_auth_tag: null,
    discord_id_kms_key_id: null,
    discord_id_kms_key_version: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...overrides,
  };
}

function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    id: "identity-1",
    user_id: "user-1",
    steward_user_id: "steward-1",
    is_anonymous: false,
    anonymous_session_id: null,
    expires_at: null,
    telegram_id: null,
    telegram_username: null,
    telegram_first_name: null,
    telegram_photo_url: null,
    phone_number: null,
    phone_verified: false,
    discord_id: null,
    discord_username: null,
    discord_global_name: null,
    discord_avatar_url: null,
    whatsapp_id: null,
    whatsapp_name: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("phoneVerifiedForNewRow", () => {
  test("phoneless rows are non-null false", () => {
    expect(phoneVerifiedForNewRow(null, null)).toBe(false);
    expect(phoneVerifiedForNewRow(null, true)).toBe(false);
    expect(phoneVerifiedForNewRow("", true)).toBe(false);
  });

  test("a present phone number is true only when explicitly verified", () => {
    expect(phoneVerifiedForNewRow("+14155550100", true)).toBe(true);
    expect(phoneVerifiedForNewRow("+14155550100", false)).toBe(false);
    expect(phoneVerifiedForNewRow("+14155550100", null)).toBe(false);
  });
});

describe("steward authority vs projection parity", () => {
  test("matching Steward authority is not full projection parity", () => {
    const canonical = user({ telegram_id: "100" });
    const projected = identity({ telegram_id: "200" });
    expect(stewardAuthorityMatches(canonical, projected)).toBe(true);
    expect(projectionMatchesUser(canonical, projected)).toBe(false);
  });

  test("healthy phoneless false/false is idempotent full parity", () => {
    const canonical = user();
    const projected = identity();
    expect(hasPhonelessLegacyPhoneVerifiedDrift(canonical, projected)).toBe(false);
    expect(stewardAuthorityMatches(canonical, projected)).toBe(true);
    expect(projectionMatchesUser(canonical, projected)).toBe(true);
  });

  test("legacy phoneless false/NULL is projection-coherent drift", () => {
    const canonical = user({ phone_verified: false });
    const projected = identity({ phone_verified: null });
    expect(hasPhonelessLegacyPhoneVerifiedDrift(canonical, projected)).toBe(true);
    expect(stewardAuthorityMatches(canonical, projected)).toBe(true);
    expect(projectionMatchesUser(canonical, projected)).toBe(true);
  });

  test("verified-phone NULL is real drift, not the phoneless legacy tuple", () => {
    const canonical = user({ phone_number: "+14155550100", phone_verified: true });
    const projected = identity({ phone_number: "+14155550100", phone_verified: null });
    expect(hasPhonelessLegacyPhoneVerifiedDrift(canonical, projected)).toBe(false);
    expect(projectionMatchesUser(canonical, projected)).toBe(false);
  });

  test("never matches an identity owned by another user", () => {
    const canonical = user();
    const projected = identity({ user_id: "user-2", steward_user_id: "steward-2" });
    expect(stewardAuthorityMatches(canonical, projected)).toBe(false);
    expect(projectionMatchesUser(canonical, projected)).toBe(false);
  });
});
