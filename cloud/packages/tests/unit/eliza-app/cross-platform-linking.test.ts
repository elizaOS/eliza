/**
 * Cross-Platform Account Linking Tests
 *
 * Verifies that any combination of Discord, Telegram, and iMessage
 * connections always converges to a single user account.
 *
 * Tests simulate the linking logic from user-service.ts:
 * - findOrCreateByTelegramWithPhone (3-step: telegram_id → phone → create)
 * - findOrCreateByDiscordId (3-step: discord_id → phone → create)
 * - findOrCreateByPhone (iMessage auto-provision)
 * - linkTelegramToUser (session-based linking)
 * - linkDiscordToUser (session-based linking)
 * - linkPhoneToUser (phone linking)
 *
 * All scenarios validate that the final state has a single user
 * with all expected platform identifiers set.
 */

import { beforeEach, describe, expect, test } from "bun:test";

// =============================================================================
// In-memory user store (simulates the database)
// =============================================================================

interface User {
  id: string;
  telegram_id: string | null;
  telegram_username: string | null;
  telegram_first_name: string | null;
  discord_id: string | null;
  discord_username: string | null;
  discord_global_name: string | null;
  discord_avatar_url: string | null;
  whatsapp_id: string | null;
  whatsapp_name: string | null;
  phone_number: string | null;
  phone_verified: boolean;
  name: string | null;
  organization_id: string;
}

interface Organization {
  id: string;
  name: string;
}

interface FindOrCreateResult {
  user: User;
  organization: Organization;
  isNew: boolean;
}

interface LinkResult {
  success: boolean;
  error?: string;
}

let users: User[] = [];
let organizations: Organization[] = [];
let nextId = 1;

function resetStore() {
  users = [];
  organizations = [];
  nextId = 1;
}

function generateId(): string {
  return `user-${nextId++}`;
}

function generateOrgId(): string {
  return `org-${nextId++}`;
}

// Simulated repository lookups
function findByTelegramId(telegramId: string): User | undefined {
  return users.find((u) => u.telegram_id === telegramId);
}

function findByDiscordId(discordId: string): User | undefined {
  return users.find((u) => u.discord_id === discordId);
}

function findByPhone(phone: string): User | undefined {
  return users.find((u) => u.phone_number === phone);
}

function findById(id: string): User | undefined {
  return users.find((u) => u.id === id);
}

function findOrgById(id: string): Organization | undefined {
  return organizations.find((o) => o.id === id);
}

function findByWhatsAppId(whatsappId: string): User | undefined {
  return users.find((u) => u.whatsapp_id === whatsappId);
}

function createUser(data: Partial<User> & { name: string }): User {
  // Check unique constraints
  if (data.telegram_id && findByTelegramId(data.telegram_id)) {
    throw new Error("unique constraint: telegram_id");
  }
  if (data.discord_id && findByDiscordId(data.discord_id)) {
    throw new Error("unique constraint: discord_id");
  }
  if (data.whatsapp_id && findByWhatsAppId(data.whatsapp_id)) {
    throw new Error("unique constraint: whatsapp_id");
  }
  if (data.phone_number && findByPhone(data.phone_number)) {
    throw new Error("unique constraint: phone_number");
  }

  const orgId = generateOrgId();
  const org: Organization = { id: orgId, name: `${data.name}'s Workspace` };
  organizations.push(org);

  const user: User = {
    id: generateId(),
    telegram_id: data.telegram_id ?? null,
    telegram_username: data.telegram_username ?? null,
    telegram_first_name: data.telegram_first_name ?? null,
    discord_id: data.discord_id ?? null,
    discord_username: data.discord_username ?? null,
    discord_global_name: data.discord_global_name ?? null,
    discord_avatar_url: data.discord_avatar_url ?? null,
    whatsapp_id: data.whatsapp_id ?? null,
    whatsapp_name: data.whatsapp_name ?? null,
    phone_number: data.phone_number ?? null,
    phone_verified: data.phone_verified ?? false,
    name: data.name,
    organization_id: orgId,
  };
  users.push(user);
  return user;
}

function updateUser(id: string, data: Partial<User>): User {
  const user = findById(id);
  if (!user) throw new Error("User not found");

  // Check unique constraints for updated fields
  if (data.telegram_id && data.telegram_id !== user.telegram_id) {
    const existing = findByTelegramId(data.telegram_id);
    if (existing && existing.id !== id) throw new Error("unique constraint: telegram_id");
  }
  if (data.discord_id && data.discord_id !== user.discord_id) {
    const existing = findByDiscordId(data.discord_id);
    if (existing && existing.id !== id) throw new Error("unique constraint: discord_id");
  }
  if (data.whatsapp_id && data.whatsapp_id !== user.whatsapp_id) {
    const existing = findByWhatsAppId(data.whatsapp_id);
    if (existing && existing.id !== id) throw new Error("unique constraint: whatsapp_id");
  }
  if (data.phone_number && data.phone_number !== user.phone_number) {
    const existing = findByPhone(data.phone_number);
    if (existing && existing.id !== id) throw new Error("unique constraint: phone_number");
  }

  Object.assign(user, data);
  return user;
}

// =============================================================================
// Service method simulations (mirrors user-service.ts logic)
// =============================================================================

interface TelegramData {
  id: number;
  first_name: string;
  username?: string;
}

interface DiscordData {
  username: string;
  globalName?: string | null;
  avatarUrl?: string | null;
}

/**
 * Simulates findOrCreateByTelegramWithPhone from user-service.ts
 * 3-step lookup: telegram_id → phone → create
 */
function findOrCreateByTelegramWithPhone(
  telegramData: TelegramData,
  phoneNumber: string,
): FindOrCreateResult {
  const telegramId = String(telegramData.id);

  // Step 1: Check by telegram_id
  const existingTelegram = findByTelegramId(telegramId);
  if (existingTelegram) {
    if (!existingTelegram.phone_number) {
      const phoneOwner = findByPhone(phoneNumber);
      if (phoneOwner && phoneOwner.id !== existingTelegram.id) {
        throw new Error("PHONE_ALREADY_LINKED");
      }
      updateUser(existingTelegram.id, {
        phone_number: phoneNumber,
        phone_verified: true,
        telegram_username: telegramData.username || existingTelegram.telegram_username,
        telegram_first_name: telegramData.first_name,
      });
    } else if (existingTelegram.phone_number !== phoneNumber) {
      throw new Error("PHONE_MISMATCH");
    }
    const user = findById(existingTelegram.id)!;
    return {
      user,
      organization: findOrgById(user.organization_id)!,
      isNew: false,
    };
  }

  // Step 2: Check by phone_number
  const existingPhone = findByPhone(phoneNumber);
  if (existingPhone) {
    if (existingPhone.telegram_id && existingPhone.telegram_id !== telegramId) {
      throw new Error("PHONE_ALREADY_LINKED");
    }
    updateUser(existingPhone.id, {
      telegram_id: telegramId,
      telegram_username: telegramData.username,
      telegram_first_name: telegramData.first_name,
    });
    const user = findById(existingPhone.id)!;
    return {
      user,
      organization: findOrgById(user.organization_id)!,
      isNew: false,
    };
  }

  // Step 3: Create new
  const user = createUser({
    telegram_id: telegramId,
    telegram_username: telegramData.username ?? null,
    telegram_first_name: telegramData.first_name,
    phone_number: phoneNumber,
    phone_verified: true,
    name: telegramData.first_name,
  });
  return {
    user,
    organization: findOrgById(user.organization_id)!,
    isNew: true,
  };
}

/**
 * Simulates findOrCreateByDiscordId from user-service.ts (UPDATED with phone fallback)
 * 3-step lookup: discord_id → phone → create
 */
function findOrCreateByDiscordId(
  discordId: string,
  discordData: DiscordData,
  phoneNumber?: string,
): FindOrCreateResult {
  // Step 1: Check by discord_id
  const existingDiscord = findByDiscordId(discordId);
  if (existingDiscord) {
    const updates: Partial<User> = {};
    if (discordData.username !== existingDiscord.discord_username) {
      updates.discord_username = discordData.username;
    }
    if (
      discordData.globalName !== undefined &&
      discordData.globalName !== existingDiscord.discord_global_name
    ) {
      updates.discord_global_name = discordData.globalName ?? null;
    }
    // Also set phone if provided and not set
    if (phoneNumber && !existingDiscord.phone_number) {
      const phoneOwner = findByPhone(phoneNumber);
      if (phoneOwner && phoneOwner.id !== existingDiscord.id) {
        throw new Error("PHONE_ALREADY_LINKED");
      }
      updates.phone_number = phoneNumber;
      updates.phone_verified = true;
    }
    if (Object.keys(updates).length > 0) {
      updateUser(existingDiscord.id, updates);
    }
    const user = findById(existingDiscord.id)!;
    return {
      user,
      organization: findOrgById(user.organization_id)!,
      isNew: false,
    };
  }

  // Step 2: Check by phone_number (NEW - cross-platform linking)
  if (phoneNumber) {
    const existingPhone = findByPhone(phoneNumber);
    if (existingPhone) {
      if (existingPhone.discord_id && existingPhone.discord_id !== discordId) {
        throw new Error("DISCORD_ALREADY_LINKED");
      }
      updateUser(existingPhone.id, {
        discord_id: discordId,
        discord_username: discordData.username,
        discord_global_name: discordData.globalName ?? null,
        discord_avatar_url: discordData.avatarUrl ?? null,
      });
      const user = findById(existingPhone.id)!;
      return {
        user,
        organization: findOrgById(user.organization_id)!,
        isNew: false,
      };
    }
  }

  // Step 3: Create new
  const displayName = discordData.globalName || discordData.username;
  const user = createUser({
    discord_id: discordId,
    discord_username: discordData.username,
    discord_global_name: discordData.globalName ?? null,
    discord_avatar_url: discordData.avatarUrl ?? null,
    phone_number: phoneNumber ?? null,
    phone_verified: !!phoneNumber,
    name: displayName,
  });
  return {
    user,
    organization: findOrgById(user.organization_id)!,
    isNew: true,
  };
}

/**
 * Simulates findOrCreateByPhone from user-service.ts (iMessage auto-provision)
 */
function findOrCreateByPhone(phoneNumber: string): FindOrCreateResult {
  const existing = findByPhone(phoneNumber);
  if (existing) {
    return {
      user: existing,
      organization: findOrgById(existing.organization_id)!,
      isNew: false,
    };
  }
  const lastFour = phoneNumber.slice(-4);
  const user = createUser({
    phone_number: phoneNumber,
    phone_verified: true,
    name: `User ***${lastFour}`,
  });
  return {
    user,
    organization: findOrgById(user.organization_id)!,
    isNew: true,
  };
}

/**
 * Simulates linkTelegramToUser from user-service.ts (session-based linking)
 */
function linkTelegramToUser(userId: string, telegramData: TelegramData): LinkResult {
  const telegramId = String(telegramData.id);
  const existingTelegram = findByTelegramId(telegramId);

  if (existingTelegram && existingTelegram.id !== userId) {
    return {
      success: false,
      error: "This Telegram account is already linked to another account",
    };
  }
  if (existingTelegram && existingTelegram.id === userId) {
    return { success: true }; // Idempotent
  }

  try {
    updateUser(userId, {
      telegram_id: telegramId,
      telegram_username: telegramData.username ?? null,
      telegram_first_name: telegramData.first_name,
    });
    return { success: true };
  } catch {
    return {
      success: false,
      error: "This Telegram account is already linked to another account",
    };
  }
}

/**
 * Simulates linkDiscordToUser from user-service.ts (session-based linking)
 */
function linkDiscordToUser(
  userId: string,
  discordData: {
    discordId: string;
    username: string;
    globalName?: string | null;
    avatarUrl?: string | null;
  },
): LinkResult {
  const existingDiscord = findByDiscordId(discordData.discordId);

  if (existingDiscord && existingDiscord.id !== userId) {
    return {
      success: false,
      error: "This Discord account is already linked to another account",
    };
  }
  if (existingDiscord && existingDiscord.id === userId) {
    return { success: true }; // Idempotent
  }

  try {
    updateUser(userId, {
      discord_id: discordData.discordId,
      discord_username: discordData.username,
      discord_global_name: discordData.globalName ?? null,
      discord_avatar_url: discordData.avatarUrl ?? null,
    });
    return { success: true };
  } catch {
    return {
      success: false,
      error: "This Discord account is already linked to another account",
    };
  }
}

/**
 * Simulates linkPhoneToUser from user-service.ts
 */
function linkPhoneToUser(userId: string, phoneNumber: string): LinkResult {
  const existingPhone = findByPhone(phoneNumber);
  if (existingPhone) {
    if (existingPhone.id === userId) return { success: true };
    return {
      success: false,
      error: "This phone number is already linked to another account",
    };
  }

  try {
    updateUser(userId, { phone_number: phoneNumber, phone_verified: true });
    return { success: true };
  } catch {
    return {
      success: false,
      error: "This phone number is already linked to another account",
    };
  }
}

/**
 * Simulates findOrCreateByWhatsAppId from user-service.ts
 * 3-step lookup: whatsapp_id → phone (auto-derived) → create
 */
function findOrCreateByWhatsAppId(whatsappId: string, profileName?: string): FindOrCreateResult {
  const derivedPhone = `+${whatsappId.replace(/\D/g, "")}`;

  // Step 1: Check by whatsapp_id
  const existingWhatsApp = findByWhatsAppId(whatsappId);
  if (existingWhatsApp) {
    if (profileName && profileName !== existingWhatsApp.whatsapp_name) {
      updateUser(existingWhatsApp.id, { whatsapp_name: profileName });
    }
    const org = findOrgById(existingWhatsApp.organization_id)!;
    return { user: existingWhatsApp, organization: org, isNew: false };
  }

  // Step 2: Check by auto-derived phone
  const existingPhone = findByPhone(derivedPhone);
  if (existingPhone) {
    if (existingPhone.whatsapp_id && existingPhone.whatsapp_id !== whatsappId) {
      throw new Error("WHATSAPP_ALREADY_LINKED");
    }
    updateUser(existingPhone.id, {
      whatsapp_id: whatsappId,
      whatsapp_name: profileName ?? null,
    });
    const org = findOrgById(existingPhone.organization_id)!;
    return { user: existingPhone, organization: org, isNew: false };
  }

  // Step 3: Create new user
  const displayName = profileName || `WhatsApp ***${whatsappId.slice(-4)}`;
  const user = createUser({
    whatsapp_id: whatsappId,
    whatsapp_name: profileName ?? null,
    phone_number: derivedPhone,
    phone_verified: true,
    name: displayName,
  });
  const org = findOrgById(user.organization_id)!;
  return { user, organization: org, isNew: true };
}

/**
 * Simulates linkWhatsAppToUser from user-service.ts (session-based linking)
 */
function linkWhatsAppToUser(
  userId: string,
  whatsappData: { whatsappId: string; name?: string },
): LinkResult {
  const existingWhatsApp = findByWhatsAppId(whatsappData.whatsappId);

  if (existingWhatsApp && existingWhatsApp.id !== userId) {
    return {
      success: false,
      error: "This WhatsApp account is already linked to another account",
    };
  }
  if (existingWhatsApp && existingWhatsApp.id === userId) {
    return { success: true }; // Idempotent
  }

  try {
    updateUser(userId, {
      whatsapp_id: whatsappData.whatsappId,
      whatsapp_name: whatsappData.name ?? null,
    });
    return { success: true };
  } catch {
    return {
      success: false,
      error: "This WhatsApp account is already linked to another account",
    };
  }
}

// =============================================================================
// Test data constants
// =============================================================================

const TELEGRAM_USER: TelegramData = {
  id: 12345678,
  first_name: "Alice",
  username: "alice_tg",
};
const DISCORD_USER: DiscordData = {
  username: "alice_discord",
  globalName: "Alice D",
};
const DISCORD_ID = "987654321012345678";
const PHONE = "+14155551234";

// =============================================================================
// Tests
// =============================================================================

describe("Cross-Platform Account Linking", () => {
  beforeEach(() => {
    resetStore();
  });

  // ===========================================================================
  // Two-platform combinations (6 directions)
  // ===========================================================================

  describe("Two-platform combinations", () => {
    test("Telegram first → link Discord (session-based) → same account", () => {
      // Step 1: Telegram OAuth with phone
      const r1 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      expect(r1.isNew).toBe(true);
      const userId = r1.user.id;

      // Step 2: Link Discord to existing account (session-based)
      const linkResult = linkDiscordToUser(userId, {
        discordId: DISCORD_ID,
        username: DISCORD_USER.username,
        globalName: DISCORD_USER.globalName,
      });
      expect(linkResult.success).toBe(true);

      // Verify: single user with all platforms
      const user = findById(userId)!;
      expect(user.telegram_id).toBe(String(TELEGRAM_USER.id));
      expect(user.discord_id).toBe(DISCORD_ID);
      expect(user.phone_number).toBe(PHONE);
      expect(users.length).toBe(1);
    });

    test("Telegram first → iMessage arrives (same phone) → same account", () => {
      // Step 1: Telegram OAuth with phone
      const r1 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      expect(r1.isNew).toBe(true);

      // Step 2: iMessage arrives from same phone
      const r2 = findOrCreateByPhone(PHONE);
      expect(r2.isNew).toBe(false);
      expect(r2.user.id).toBe(r1.user.id);

      expect(users.length).toBe(1);
    });

    test("Discord first → link Telegram (session-based) → same account", () => {
      // Step 1: Discord OAuth (no phone)
      const r1 = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER);
      expect(r1.isNew).toBe(true);
      const userId = r1.user.id;

      // Step 2: Link Telegram (session-based)
      const linkTg = linkTelegramToUser(userId, TELEGRAM_USER);
      expect(linkTg.success).toBe(true);

      // Step 2b: Also link phone
      const linkPh = linkPhoneToUser(userId, PHONE);
      expect(linkPh.success).toBe(true);

      // Verify
      const user = findById(userId)!;
      expect(user.telegram_id).toBe(String(TELEGRAM_USER.id));
      expect(user.discord_id).toBe(DISCORD_ID);
      expect(user.phone_number).toBe(PHONE);
      expect(users.length).toBe(1);
    });

    test("Discord first (with phone) → iMessage arrives (same phone) → same account", () => {
      // Step 1: Discord OAuth with phone
      const r1 = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER, PHONE);
      expect(r1.isNew).toBe(true);

      // Step 2: iMessage arrives from same phone
      const r2 = findOrCreateByPhone(PHONE);
      expect(r2.isNew).toBe(false);
      expect(r2.user.id).toBe(r1.user.id);

      expect(users.length).toBe(1);
    });

    test("iMessage first → link Telegram (via findOrCreateByTelegramWithPhone) → same account", () => {
      // Step 1: iMessage auto-provision
      const r1 = findOrCreateByPhone(PHONE);
      expect(r1.isNew).toBe(true);

      // Step 2: Telegram OAuth with same phone
      const r2 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      expect(r2.isNew).toBe(false);
      expect(r2.user.id).toBe(r1.user.id);

      const user = findById(r1.user.id)!;
      expect(user.telegram_id).toBe(String(TELEGRAM_USER.id));
      expect(user.phone_number).toBe(PHONE);
      expect(users.length).toBe(1);
    });

    test("iMessage first → link Discord (via findOrCreateByDiscordId with phone) → same account", () => {
      // Step 1: iMessage auto-provision
      const r1 = findOrCreateByPhone(PHONE);
      expect(r1.isNew).toBe(true);

      // Step 2: Discord OAuth with same phone (phone-based cross-linking)
      const r2 = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER, PHONE);
      expect(r2.isNew).toBe(false);
      expect(r2.user.id).toBe(r1.user.id);

      const user = findById(r1.user.id)!;
      expect(user.discord_id).toBe(DISCORD_ID);
      expect(user.phone_number).toBe(PHONE);
      expect(users.length).toBe(1);
    });

    test("iMessage first → link Discord (session-based) → same account", () => {
      // Step 1: iMessage auto-provision
      const r1 = findOrCreateByPhone(PHONE);
      expect(r1.isNew).toBe(true);
      const userId = r1.user.id;

      // Step 2: Link Discord to existing user (session-based)
      const linkResult = linkDiscordToUser(userId, {
        discordId: DISCORD_ID,
        username: DISCORD_USER.username,
        globalName: DISCORD_USER.globalName,
      });
      expect(linkResult.success).toBe(true);

      const user = findById(userId)!;
      expect(user.discord_id).toBe(DISCORD_ID);
      expect(user.phone_number).toBe(PHONE);
      expect(users.length).toBe(1);
    });
  });

  // ===========================================================================
  // Three-platform combinations (all 6 orderings)
  // ===========================================================================

  describe("Three-platform combinations", () => {
    test("Telegram → Discord → iMessage → single account", () => {
      // 1. Telegram with phone
      const r1 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      const userId = r1.user.id;

      // 2. Link Discord (session-based)
      const linkResult = linkDiscordToUser(userId, {
        discordId: DISCORD_ID,
        username: DISCORD_USER.username,
      });
      expect(linkResult.success).toBe(true);

      // 3. iMessage arrives on same phone
      const r3 = findOrCreateByPhone(PHONE);
      expect(r3.user.id).toBe(userId);

      const user = findById(userId)!;
      expect(user.telegram_id).toBe(String(TELEGRAM_USER.id));
      expect(user.discord_id).toBe(DISCORD_ID);
      expect(user.phone_number).toBe(PHONE);
      expect(users.length).toBe(1);
    });

    test("Telegram → iMessage → Discord → single account", () => {
      // 1. Telegram with phone
      const r1 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      const userId = r1.user.id;

      // 2. iMessage arrives
      const r2 = findOrCreateByPhone(PHONE);
      expect(r2.user.id).toBe(userId);

      // 3. Link Discord (session-based)
      const linkResult = linkDiscordToUser(userId, {
        discordId: DISCORD_ID,
        username: DISCORD_USER.username,
      });
      expect(linkResult.success).toBe(true);

      const user = findById(userId)!;
      expect(user.telegram_id).toBe(String(TELEGRAM_USER.id));
      expect(user.discord_id).toBe(DISCORD_ID);
      expect(user.phone_number).toBe(PHONE);
      expect(users.length).toBe(1);
    });

    test("Discord → Telegram → iMessage → single account", () => {
      // 1. Discord (no phone)
      const r1 = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER);
      const userId = r1.user.id;

      // 2. Link Telegram + phone (session-based)
      linkTelegramToUser(userId, TELEGRAM_USER);
      linkPhoneToUser(userId, PHONE);

      // 3. iMessage arrives
      const r3 = findOrCreateByPhone(PHONE);
      expect(r3.user.id).toBe(userId);

      const user = findById(userId)!;
      expect(user.telegram_id).toBe(String(TELEGRAM_USER.id));
      expect(user.discord_id).toBe(DISCORD_ID);
      expect(user.phone_number).toBe(PHONE);
      expect(users.length).toBe(1);
    });

    test("Discord → iMessage → Telegram → single account", () => {
      // 1. Discord with phone
      const r1 = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER, PHONE);
      const userId = r1.user.id;

      // 2. iMessage arrives
      const r2 = findOrCreateByPhone(PHONE);
      expect(r2.user.id).toBe(userId);

      // 3. Telegram OAuth with same phone (phone-based cross-linking)
      const r3 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      expect(r3.user.id).toBe(userId);

      const user = findById(userId)!;
      expect(user.telegram_id).toBe(String(TELEGRAM_USER.id));
      expect(user.discord_id).toBe(DISCORD_ID);
      expect(user.phone_number).toBe(PHONE);
      expect(users.length).toBe(1);
    });

    test("iMessage → Telegram → Discord → single account", () => {
      // 1. iMessage auto-provision
      const r1 = findOrCreateByPhone(PHONE);
      const userId = r1.user.id;

      // 2. Telegram OAuth with same phone (links to existing phone user)
      const r2 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      expect(r2.user.id).toBe(userId);

      // 3. Link Discord (session-based)
      const linkResult = linkDiscordToUser(userId, {
        discordId: DISCORD_ID,
        username: DISCORD_USER.username,
      });
      expect(linkResult.success).toBe(true);

      const user = findById(userId)!;
      expect(user.telegram_id).toBe(String(TELEGRAM_USER.id));
      expect(user.discord_id).toBe(DISCORD_ID);
      expect(user.phone_number).toBe(PHONE);
      expect(users.length).toBe(1);
    });

    test("iMessage → Discord → Telegram → single account", () => {
      // 1. iMessage auto-provision
      const r1 = findOrCreateByPhone(PHONE);
      const userId = r1.user.id;

      // 2. Discord OAuth with same phone (phone-based cross-linking)
      const r2 = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER, PHONE);
      expect(r2.user.id).toBe(userId);

      // 3. Telegram OAuth with same phone
      const r3 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      expect(r3.user.id).toBe(userId);

      const user = findById(userId)!;
      expect(user.telegram_id).toBe(String(TELEGRAM_USER.id));
      expect(user.discord_id).toBe(DISCORD_ID);
      expect(user.phone_number).toBe(PHONE);
      expect(users.length).toBe(1);
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe("Edge cases", () => {
    test("Discord first (no phone) → link Telegram (with phone) → iMessage → all same account", () => {
      // 1. Discord OAuth (no phone)
      const r1 = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER);
      expect(r1.isNew).toBe(true);
      const userId = r1.user.id;
      expect(r1.user.phone_number).toBeNull();

      // 2. Session-based Telegram linking (adds telegram + phone)
      const linkTg = linkTelegramToUser(userId, TELEGRAM_USER);
      expect(linkTg.success).toBe(true);
      const linkPh = linkPhoneToUser(userId, PHONE);
      expect(linkPh.success).toBe(true);

      // 3. iMessage arrives on same phone
      const r3 = findOrCreateByPhone(PHONE);
      expect(r3.user.id).toBe(userId);

      const user = findById(userId)!;
      expect(user.telegram_id).toBe(String(TELEGRAM_USER.id));
      expect(user.discord_id).toBe(DISCORD_ID);
      expect(user.phone_number).toBe(PHONE);
      expect(users.length).toBe(1);
    });

    test("Two different users try to link same phone → conflict error", () => {
      // User A: Telegram with phone
      const r1 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      expect(r1.isNew).toBe(true);
      const userAId = r1.user.id;

      // User B: Discord (no phone)
      const discordId2 = "111222333444555666";
      const r2 = findOrCreateByDiscordId(discordId2, { username: "bob" });
      expect(r2.isNew).toBe(true);
      const userBId = r2.user.id;
      expect(userBId).not.toBe(userAId);

      // User B tries to link same phone → should fail
      const linkResult = linkPhoneToUser(userBId, PHONE);
      expect(linkResult.success).toBe(false);
      expect(linkResult.error).toContain("already linked");

      expect(users.length).toBe(2);
    });

    test("Two different users try to link same Telegram ID → conflict error", () => {
      // User A: Has Telegram
      const r1 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      const userAId = r1.user.id;

      // User B: Discord user tries to link same Telegram
      const r2 = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER);
      const userBId = r2.user.id;
      expect(userBId).not.toBe(userAId);

      const linkResult = linkTelegramToUser(userBId, TELEGRAM_USER);
      expect(linkResult.success).toBe(false);
      expect(linkResult.error).toContain("already linked");
    });

    test("Two different users try to link same Discord ID → conflict error", () => {
      // User A: Has Discord
      const r1 = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER);
      const userAId = r1.user.id;

      // User B: Telegram user tries to link same Discord
      const r2 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      const userBId = r2.user.id;
      expect(userBId).not.toBe(userAId);

      const linkResult = linkDiscordToUser(userBId, {
        discordId: DISCORD_ID,
        username: DISCORD_USER.username,
      });
      expect(linkResult.success).toBe(false);
      expect(linkResult.error).toContain("already linked");
    });

    test("Session-based linking when platform already linked to same user → idempotent success", () => {
      // Create user with both platforms
      const r1 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      const userId = r1.user.id;
      linkDiscordToUser(userId, {
        discordId: DISCORD_ID,
        username: DISCORD_USER.username,
      });

      // Re-link same Telegram → should succeed idempotently
      const reTg = linkTelegramToUser(userId, TELEGRAM_USER);
      expect(reTg.success).toBe(true);

      // Re-link same Discord → should succeed idempotently
      const reDc = linkDiscordToUser(userId, {
        discordId: DISCORD_ID,
        username: DISCORD_USER.username,
      });
      expect(reDc.success).toBe(true);

      // Re-link same phone → should succeed idempotently
      const rePh = linkPhoneToUser(userId, PHONE);
      expect(rePh.success).toBe(true);

      expect(users.length).toBe(1);
    });

    test("Session-based linking when platform already linked to different user → conflict", () => {
      // User A: Telegram
      const r1 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);

      // User B: Discord
      const r2 = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER);

      // Try to link User A's Telegram to User B → should fail
      const linkResult = linkTelegramToUser(r2.user.id, TELEGRAM_USER);
      expect(linkResult.success).toBe(false);

      // Try to link User B's Discord to User A → should fail
      const linkResult2 = linkDiscordToUser(r1.user.id, {
        discordId: DISCORD_ID,
        username: DISCORD_USER.username,
      });
      expect(linkResult2.success).toBe(false);

      expect(users.length).toBe(2);
    });

    test("Discord OAuth with phone that matches Telegram user → links to existing (no session needed)", () => {
      // 1. Telegram user with phone
      const r1 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      const userId = r1.user.id;

      // 2. Discord OAuth with same phone (phone-based cross-linking in findOrCreateByDiscordId)
      const r2 = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER, PHONE);
      expect(r2.isNew).toBe(false);
      expect(r2.user.id).toBe(userId);

      const user = findById(userId)!;
      expect(user.telegram_id).toBe(String(TELEGRAM_USER.id));
      expect(user.discord_id).toBe(DISCORD_ID);
      expect(user.phone_number).toBe(PHONE);
      expect(users.length).toBe(1);
    });

    test("Telegram OAuth with phone that matches Discord user → links to existing (no session needed)", () => {
      // 1. Discord user with phone
      const r1 = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER, PHONE);
      const userId = r1.user.id;

      // 2. Telegram OAuth with same phone (phone-based cross-linking in findOrCreateByTelegramWithPhone)
      const r2 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      expect(r2.isNew).toBe(false);
      expect(r2.user.id).toBe(userId);

      const user = findById(userId)!;
      expect(user.telegram_id).toBe(String(TELEGRAM_USER.id));
      expect(user.discord_id).toBe(DISCORD_ID);
      expect(user.phone_number).toBe(PHONE);
      expect(users.length).toBe(1);
    });

    test("Discord first (no phone) → Telegram OAuth (no session) → creates separate accounts without phone bridge", () => {
      // This tests the scenario BEFORE session-based linking is used.
      // Without session or phone, there's no way to link.
      const PHONE_B = "+14155559999";

      // 1. Discord (no phone)
      const r1 = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER);
      expect(r1.isNew).toBe(true);

      // 2. Telegram with a DIFFERENT phone (no session passed)
      const r2 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE_B);
      expect(r2.isNew).toBe(true);

      // These are separate users because there's no phone bridge and no session
      expect(r1.user.id).not.toBe(r2.user.id);
      expect(users.length).toBe(2);
    });

    test("Phone mismatch throws error for Telegram user with existing different phone", () => {
      const PHONE_A = "+14155551111";
      const PHONE_B = "+14155552222";

      // Create user with Telegram + phone A
      findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE_A);

      // Try to re-auth with same Telegram but different phone → should throw PHONE_MISMATCH
      expect(() => findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE_B)).toThrow(
        "PHONE_MISMATCH",
      );

      expect(users.length).toBe(1);
    });
  });

  // ===========================================================================
  // Session-aware auth endpoint tests
  // ===========================================================================

  describe("Session-aware auth endpoint logic", () => {
    test("Discord auth with valid session → links to existing account", () => {
      // User exists (created via Telegram)
      const r1 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      const userId = r1.user.id;

      // Simulate session-based Discord auth: validate session → linkDiscordToUser
      const session = { userId, organizationId: r1.organization.id };
      const linkResult = linkDiscordToUser(session.userId, {
        discordId: DISCORD_ID,
        username: DISCORD_USER.username,
        globalName: DISCORD_USER.globalName,
        avatarUrl: null,
      });
      expect(linkResult.success).toBe(true);

      const user = findById(userId)!;
      expect(user.discord_id).toBe(DISCORD_ID);
      expect(user.telegram_id).toBe(String(TELEGRAM_USER.id));
      expect(users.length).toBe(1);
    });

    test("Discord auth without session → creates new account (standard flow)", () => {
      const r1 = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER);
      expect(r1.isNew).toBe(true);
      expect(r1.user.discord_id).toBe(DISCORD_ID);
      expect(r1.user.telegram_id).toBeNull();
      expect(users.length).toBe(1);
    });

    test("Telegram auth with valid session → links to existing account", () => {
      // User exists (created via Discord)
      const r1 = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER);
      const userId = r1.user.id;

      // Simulate session-based Telegram auth: validate session → linkTelegramToUser + linkPhone
      const linkTg = linkTelegramToUser(userId, TELEGRAM_USER);
      expect(linkTg.success).toBe(true);
      const linkPh = linkPhoneToUser(userId, PHONE);
      expect(linkPh.success).toBe(true);

      const user = findById(userId)!;
      expect(user.telegram_id).toBe(String(TELEGRAM_USER.id));
      expect(user.discord_id).toBe(DISCORD_ID);
      expect(user.phone_number).toBe(PHONE);
      expect(users.length).toBe(1);
    });

    test("Telegram auth without session → creates new account (standard flow)", () => {
      const r1 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      expect(r1.isNew).toBe(true);
      expect(r1.user.telegram_id).toBe(String(TELEGRAM_USER.id));
      expect(r1.user.discord_id).toBeNull();
      expect(users.length).toBe(1);
    });

    test("Auth with expired/invalid session → falls through to create flow", () => {
      // Simulate expired session: session validation returns null
      // In this case, we fall through to findOrCreateByDiscordId (standard flow)
      const expiredSession = null; // represents validateAuthHeader returning null

      if (!expiredSession) {
        // Standard flow
        const r1 = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER);
        expect(r1.isNew).toBe(true);
      }

      expect(users.length).toBe(1);
    });
  });

  // ===========================================================================
  // findOrCreateByDiscordId phone fallback tests
  // ===========================================================================

  describe("findOrCreateByDiscordId phone fallback", () => {
    test("Discord with phone, no existing user → creates new user with both", () => {
      const r = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER, PHONE);
      expect(r.isNew).toBe(true);
      expect(r.user.discord_id).toBe(DISCORD_ID);
      expect(r.user.phone_number).toBe(PHONE);
    });

    test("Discord without phone → creates user without phone", () => {
      const r = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER);
      expect(r.isNew).toBe(true);
      expect(r.user.discord_id).toBe(DISCORD_ID);
      expect(r.user.phone_number).toBeNull();
    });

    test("Discord with phone matching existing Telegram user → cross-links", () => {
      findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      const r = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER, PHONE);
      expect(r.isNew).toBe(false);
      expect(r.user.telegram_id).toBe(String(TELEGRAM_USER.id));
      expect(r.user.discord_id).toBe(DISCORD_ID);
      expect(r.user.phone_number).toBe(PHONE);
      expect(users.length).toBe(1);
    });

    test("Discord with phone matching existing iMessage user → cross-links", () => {
      findOrCreateByPhone(PHONE);
      const r = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER, PHONE);
      expect(r.isNew).toBe(false);
      expect(r.user.discord_id).toBe(DISCORD_ID);
      expect(r.user.phone_number).toBe(PHONE);
      expect(users.length).toBe(1);
    });

    test("Returning Discord user, phone provided, user has no phone yet → adds phone", () => {
      // First login: no phone
      const r1 = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER);
      expect(r1.user.phone_number).toBeNull();

      // Second login: phone provided
      const r2 = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER, PHONE);
      expect(r2.isNew).toBe(false);
      expect(r2.user.phone_number).toBe(PHONE);
    });

    test("Discord with phone matching user that already has different discord → throws", () => {
      const DISCORD_ID_A = "111111111111111111";
      const DISCORD_ID_B = "222222222222222222";

      findOrCreateByDiscordId(DISCORD_ID_A, { username: "userA" }, PHONE);

      expect(() => findOrCreateByDiscordId(DISCORD_ID_B, { username: "userB" }, PHONE)).toThrow(
        "DISCORD_ALREADY_LINKED",
      );
    });
  });

  // ===========================================================================
  // linkDiscordToUser tests
  // ===========================================================================

  describe("linkDiscordToUser", () => {
    test("links Discord to user with no Discord", () => {
      const r = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      const result = linkDiscordToUser(r.user.id, {
        discordId: DISCORD_ID,
        username: DISCORD_USER.username,
        globalName: DISCORD_USER.globalName,
        avatarUrl: null,
      });
      expect(result.success).toBe(true);
      expect(findById(r.user.id)!.discord_id).toBe(DISCORD_ID);
    });

    test("returns success when Discord already linked to same user (idempotent)", () => {
      const r = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER);
      const result = linkDiscordToUser(r.user.id, {
        discordId: DISCORD_ID,
        username: DISCORD_USER.username,
      });
      expect(result.success).toBe(true);
    });

    test("returns error when Discord linked to different user", () => {
      findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER);
      const r2 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      const result = linkDiscordToUser(r2.user.id, {
        discordId: DISCORD_ID,
        username: DISCORD_USER.username,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("already linked");
    });
  });

  // ===========================================================================
  // WhatsApp: findOrCreateByWhatsAppId
  // ===========================================================================

  describe("findOrCreateByWhatsAppId", () => {
    const WA_ID = "14245071234";
    const WA_NAME = "John WhatsApp";
    const WA_DERIVED_PHONE = "+14245071234";

    test("creates new user with WhatsApp ID and auto-derived phone", () => {
      const result = findOrCreateByWhatsAppId(WA_ID, WA_NAME);
      expect(result.isNew).toBe(true);
      expect(result.user.whatsapp_id).toBe(WA_ID);
      expect(result.user.whatsapp_name).toBe(WA_NAME);
      expect(result.user.phone_number).toBe(WA_DERIVED_PHONE);
      expect(result.user.phone_verified).toBe(true);
    });

    test("returns existing user when WhatsApp ID already exists", () => {
      const r1 = findOrCreateByWhatsAppId(WA_ID, WA_NAME);
      const r2 = findOrCreateByWhatsAppId(WA_ID, "Updated Name");
      expect(r2.isNew).toBe(false);
      expect(r2.user.id).toBe(r1.user.id);
      expect(r2.user.whatsapp_name).toBe("Updated Name");
    });

    test("links WhatsApp to existing phone user (Telegram-first)", () => {
      const r1 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, WA_DERIVED_PHONE);
      expect(r1.user.whatsapp_id).toBeNull();

      const r2 = findOrCreateByWhatsAppId(WA_ID, WA_NAME);
      expect(r2.isNew).toBe(false);
      expect(r2.user.id).toBe(r1.user.id);
      expect(r2.user.whatsapp_id).toBe(WA_ID);
      expect(r2.user.telegram_id).toBe(String(TELEGRAM_USER.id));
      expect(r2.user.phone_number).toBe(WA_DERIVED_PHONE);
    });

    test("links WhatsApp to existing phone user (iMessage-first)", () => {
      const r1 = findOrCreateByPhone(WA_DERIVED_PHONE);
      expect(r1.user.whatsapp_id).toBeNull();

      const r2 = findOrCreateByWhatsAppId(WA_ID, WA_NAME);
      expect(r2.isNew).toBe(false);
      expect(r2.user.id).toBe(r1.user.id);
      expect(r2.user.whatsapp_id).toBe(WA_ID);
    });

    test("all four platforms converge to single user", () => {
      // Step 1: WhatsApp first
      const r1 = findOrCreateByWhatsAppId(WA_ID, WA_NAME);
      expect(r1.isNew).toBe(true);

      // Step 2: Telegram with same phone
      const r2 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, WA_DERIVED_PHONE);
      expect(r2.isNew).toBe(false);
      expect(r2.user.id).toBe(r1.user.id);

      // Step 3: Discord with same phone
      const r3 = findOrCreateByDiscordId(DISCORD_ID, DISCORD_USER, WA_DERIVED_PHONE);
      expect(r3.isNew).toBe(false);
      expect(r3.user.id).toBe(r1.user.id);

      // Verify all platforms linked to single user
      const finalUser = findById(r1.user.id)!;
      expect(finalUser.whatsapp_id).toBe(WA_ID);
      expect(finalUser.telegram_id).toBe(String(TELEGRAM_USER.id));
      expect(finalUser.discord_id).toBe(DISCORD_ID);
      expect(finalUser.phone_number).toBe(WA_DERIVED_PHONE);
    });
  });

  // ===========================================================================
  // linkWhatsAppToUser
  // ===========================================================================

  describe("linkWhatsAppToUser", () => {
    const WA_ID = "14245071234";

    test("links WhatsApp to user with no WhatsApp", () => {
      const r = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      const result = linkWhatsAppToUser(r.user.id, {
        whatsappId: WA_ID,
        name: "Test WA",
      });
      expect(result.success).toBe(true);
      expect(findById(r.user.id)!.whatsapp_id).toBe(WA_ID);
    });

    test("returns success when WhatsApp already linked to same user (idempotent)", () => {
      const r = findOrCreateByWhatsAppId(WA_ID, "Test");
      const result = linkWhatsAppToUser(r.user.id, {
        whatsappId: WA_ID,
      });
      expect(result.success).toBe(true);
    });

    test("returns error when WhatsApp linked to different user", () => {
      findOrCreateByWhatsAppId(WA_ID, "User A");
      const r2 = findOrCreateByTelegramWithPhone(TELEGRAM_USER, PHONE);
      const result = linkWhatsAppToUser(r2.user.id, {
        whatsappId: WA_ID,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("already linked");
    });
  });
});
