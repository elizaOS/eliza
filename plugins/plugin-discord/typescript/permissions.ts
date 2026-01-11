/**
 * Discord bot permission tiers for different use cases.
 *
 * Permissions are organized in a 3x2 matrix:
 * - Role axis: Basic / Moderator / Admin
 * - Voice axis: Without voice / With voice
 *
 * Discord permissions are bit flags. We combine them using bitwise OR.
 * @see https://discord.com/developers/docs/topics/permissions
 */

// Individual permission bit values (from Discord.js PermissionsBitField.Flags)
const Permissions = {
  // Reactions
  AddReactions: 1n << 6n, // 64

  // Voice (low bits)
  PrioritySpeaker: 1n << 8n, // 256
  Stream: 1n << 9n, // 512

  // General
  ViewChannel: 1n << 10n, // 1024 - Required to see channels

  // Text
  SendMessages: 1n << 11n, // 2048
  SendTTSMessages: 1n << 12n, // 4096
  ManageMessages: 1n << 13n, // 8192 - Pin/unpin, delete others' messages
  EmbedLinks: 1n << 14n, // 16384
  AttachFiles: 1n << 15n, // 32768
  ReadMessageHistory: 1n << 16n, // 65536
  MentionEveryone: 1n << 17n, // 131072
  UseExternalEmojis: 1n << 18n, // 262144

  // Voice
  Connect: 1n << 20n, // 1048576
  Speak: 1n << 21n, // 2097152
  MuteMembers: 1n << 22n, // 4194304
  DeafenMembers: 1n << 23n, // 8388608
  MoveMembers: 1n << 24n, // 16777216
  UseVAD: 1n << 25n, // 33554432 - Voice Activity Detection

  // Member management
  KickMembers: 1n << 1n, // 2
  BanMembers: 1n << 2n, // 4
  ChangeNickname: 1n << 26n, // 67108864
  ManageNicknames: 1n << 27n, // 134217728

  // Server management
  ManageChannels: 1n << 4n, // 16
  ManageRoles: 1n << 28n, // 268435456
  ManageWebhooks: 1n << 29n, // 536870912
  ManageGuildExpressions: 1n << 30n, // 1073741824

  // Advanced
  UseApplicationCommands: 1n << 31n, // 2147483648 - Slash commands
  ManageThreads: 1n << 34n, // 17179869184
  CreatePublicThreads: 1n << 35n, // 34359738368
  CreatePrivateThreads: 1n << 36n, // 68719476736
  UseExternalStickers: 1n << 37n, // 137438953472
  SendMessagesInThreads: 1n << 38n, // 274877906944
  UseEmbeddedActivities: 1n << 39n, // 549755813888
  ModerateMembers: 1n << 40n, // 1099511627776 - Timeout members
  SendVoiceMessages: 1n << 46n, // 70368744177664
  SendPolls: 1n << 47n, // 140737488355328
} as const;

// ============================================================================
// BASE PERMISSION SETS
// ============================================================================

/**
 * Basic text permissions - minimal footprint for text interaction
 */
const TEXT_BASIC =
  Permissions.ViewChannel |
  Permissions.AddReactions |
  Permissions.SendMessages |
  Permissions.EmbedLinks |
  Permissions.AttachFiles |
  Permissions.UseExternalEmojis |
  Permissions.ReadMessageHistory |
  Permissions.SendMessagesInThreads |
  Permissions.UseApplicationCommands;

/**
 * Moderator text permissions - adds moderation capabilities
 */
const TEXT_MODERATOR =
  TEXT_BASIC |
  Permissions.ManageMessages |
  Permissions.MentionEveryone |
  Permissions.CreatePublicThreads |
  Permissions.CreatePrivateThreads |
  Permissions.ManageThreads |
  Permissions.UseExternalStickers |
  Permissions.SendPolls |
  Permissions.ModerateMembers; // Timeout members

/**
 * Admin text permissions - adds member/server management
 */
const TEXT_ADMIN =
  TEXT_MODERATOR |
  Permissions.KickMembers |
  Permissions.BanMembers |
  Permissions.ManageNicknames |
  Permissions.ManageChannels |
  Permissions.ManageRoles |
  Permissions.ManageWebhooks |
  Permissions.ManageGuildExpressions;

/**
 * Voice permissions add-on
 */
const VOICE_ADDON =
  Permissions.Connect |
  Permissions.Speak |
  Permissions.UseVAD |
  Permissions.PrioritySpeaker |
  Permissions.Stream |
  Permissions.SendVoiceMessages;

/**
 * Voice moderation add-on (for admin tier)
 */
const VOICE_ADMIN_ADDON =
  VOICE_ADDON | Permissions.MuteMembers | Permissions.DeafenMembers | Permissions.MoveMembers;

// ============================================================================
// PERMISSION TIERS (3x2 Matrix)
// ============================================================================

/**
 * Basic - Text only, no moderation, no voice
 * Good for: Simple chatbots, read-only bots, basic assistants
 */
export const PERMISSIONS_BASIC = TEXT_BASIC;

/**
 * Basic + Voice - Text with voice, no moderation
 * Good for: Voice assistants, music bots without mod powers
 */
export const PERMISSIONS_BASIC_VOICE = TEXT_BASIC | VOICE_ADDON;

/**
 * Moderator - Text with moderation, no voice
 * Good for: Community bots, moderation assistants, engagement bots
 */
export const PERMISSIONS_MODERATOR = TEXT_MODERATOR;

/**
 * Moderator + Voice - Text + moderation + voice
 * Good for: Full-featured community bots with voice
 */
export const PERMISSIONS_MODERATOR_VOICE = TEXT_MODERATOR | VOICE_ADDON;

/**
 * Admin - Text with full server management, no voice
 * Good for: Server management bots, admin tools
 */
export const PERMISSIONS_ADMIN = TEXT_ADMIN;

/**
 * Admin + Voice - Full permissions (text + admin + voice + voice moderation)
 * Good for: Complete server integration, owner-level bots
 */
export const PERMISSIONS_ADMIN_VOICE = TEXT_ADMIN | VOICE_ADMIN_ADDON;

// ============================================================================
// EXPORTS
// ============================================================================

/**
 * Permission tiers as numbers for URL generation.
 *
 * Matrix (3x2):
 * |            | No Voice         | With Voice            |
 * |------------|------------------|-----------------------|
 * | Basic      | BASIC            | BASIC_VOICE           |
 * | Moderator  | MODERATOR        | MODERATOR_VOICE       |
 * | Admin      | ADMIN            | ADMIN_VOICE           |
 *
 * Note: BigInt permissions are converted to Number for URL compatibility.
 * This is safe while Discord permissions stay below bit position 53
 * (Number.MAX_SAFE_INTEGER ≈ 9 quadrillion). Current max bit is ~46.
 */
export const DiscordPermissionTiers = {
  /** Basic text-only permissions (no moderation, no voice) */
  BASIC: Number(PERMISSIONS_BASIC),
  /** Basic + voice permissions (no moderation) */
  BASIC_VOICE: Number(PERMISSIONS_BASIC_VOICE),
  /** Moderator permissions (text + moderation, no voice) */
  MODERATOR: Number(PERMISSIONS_MODERATOR),
  /** Moderator + voice permissions */
  MODERATOR_VOICE: Number(PERMISSIONS_MODERATOR_VOICE),
  /** Admin permissions (text + moderation + server management, no voice) */
  ADMIN: Number(PERMISSIONS_ADMIN),
  /** Admin + voice permissions (full permissions) */
  ADMIN_VOICE: Number(PERMISSIONS_ADMIN_VOICE),

  // Alias for backwards compatibility
  /** @deprecated Use MODERATOR_VOICE instead */
  FULL: Number(PERMISSIONS_MODERATOR_VOICE),
} as const;

// Type for tier names
export type DiscordPermissionTier = keyof typeof DiscordPermissionTiers;

/**
 * Generate a Discord OAuth2 invite URL for the bot.
 */
export function generateInviteUrl(
  applicationId: string,
  tier: DiscordPermissionTier = "MODERATOR_VOICE"
): string {
  const permissions = DiscordPermissionTiers[tier];
  return `https://discord.com/api/oauth2/authorize?client_id=${applicationId}&permissions=${permissions}&scope=bot%20applications.commands`;
}

/**
 * Permission values for all tiers (for compact display).
 */
export interface DiscordPermissionValues {
  basic: number;
  basicVoice: number;
  moderator: number;
  moderatorVoice: number;
  admin: number;
  adminVoice: number;
}

/**
 * Get all permission values for the 3x2 tier matrix.
 */
export function getPermissionValues(): DiscordPermissionValues {
  return {
    basic: DiscordPermissionTiers.BASIC,
    basicVoice: DiscordPermissionTiers.BASIC_VOICE,
    moderator: DiscordPermissionTiers.MODERATOR,
    moderatorVoice: DiscordPermissionTiers.MODERATOR_VOICE,
    admin: DiscordPermissionTiers.ADMIN,
    adminVoice: DiscordPermissionTiers.ADMIN_VOICE,
  };
}

/**
 * Invite URLs organized by tier for display.
 */
export interface DiscordInviteUrls {
  basic: string;
  basicVoice: string;
  moderator: string;
  moderatorVoice: string;
  admin: string;
  adminVoice: string;
}

/**
 * Generate all tier invite URLs for display.
 */
export function generateAllInviteUrls(applicationId: string): DiscordInviteUrls {
  return {
    basic: generateInviteUrl(applicationId, "BASIC"),
    basicVoice: generateInviteUrl(applicationId, "BASIC_VOICE"),
    moderator: generateInviteUrl(applicationId, "MODERATOR"),
    moderatorVoice: generateInviteUrl(applicationId, "MODERATOR_VOICE"),
    admin: generateInviteUrl(applicationId, "ADMIN"),
    adminVoice: generateInviteUrl(applicationId, "ADMIN_VOICE"),
  };
}

// For backwards compatibility
export const REQUIRED_PERMISSIONS = PERMISSIONS_MODERATOR_VOICE;
