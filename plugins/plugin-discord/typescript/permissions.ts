const Permissions = {
  AddReactions: 1n << 6n,
  PrioritySpeaker: 1n << 8n,
  Stream: 1n << 9n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  SendTTSMessages: 1n << 12n,
  ManageMessages: 1n << 13n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  MentionEveryone: 1n << 17n,
  UseExternalEmojis: 1n << 18n,
  Connect: 1n << 20n,
  Speak: 1n << 21n,
  MuteMembers: 1n << 22n,
  DeafenMembers: 1n << 23n,
  MoveMembers: 1n << 24n,
  UseVAD: 1n << 25n,
  KickMembers: 1n << 1n,
  BanMembers: 1n << 2n,
  ChangeNickname: 1n << 26n,
  ManageNicknames: 1n << 27n,
  ManageChannels: 1n << 4n,
  ManageRoles: 1n << 28n,
  ManageWebhooks: 1n << 29n,
  ManageGuildExpressions: 1n << 30n,
  UseApplicationCommands: 1n << 31n,
  ManageThreads: 1n << 34n,
  CreatePublicThreads: 1n << 35n,
  CreatePrivateThreads: 1n << 36n,
  UseExternalStickers: 1n << 37n,
  SendMessagesInThreads: 1n << 38n,
  UseEmbeddedActivities: 1n << 39n,
  ModerateMembers: 1n << 40n,
  SendVoiceMessages: 1n << 46n,
  SendPolls: 1n << 47n,
} as const;

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

const TEXT_MODERATOR =
  TEXT_BASIC |
  Permissions.ManageMessages |
  Permissions.MentionEveryone |
  Permissions.CreatePublicThreads |
  Permissions.CreatePrivateThreads |
  Permissions.ManageThreads |
  Permissions.UseExternalStickers |
  Permissions.SendPolls |
  Permissions.ModerateMembers;

const TEXT_ADMIN =
  TEXT_MODERATOR |
  Permissions.KickMembers |
  Permissions.BanMembers |
  Permissions.ManageNicknames |
  Permissions.ManageChannels |
  Permissions.ManageRoles |
  Permissions.ManageWebhooks |
  Permissions.ManageGuildExpressions;

const VOICE_ADDON =
  Permissions.Connect |
  Permissions.Speak |
  Permissions.UseVAD |
  Permissions.PrioritySpeaker |
  Permissions.Stream |
  Permissions.SendVoiceMessages;

const VOICE_ADMIN_ADDON =
  VOICE_ADDON | Permissions.MuteMembers | Permissions.DeafenMembers | Permissions.MoveMembers;

export const PERMISSIONS_BASIC = TEXT_BASIC;
export const PERMISSIONS_BASIC_VOICE = TEXT_BASIC | VOICE_ADDON;
export const PERMISSIONS_MODERATOR = TEXT_MODERATOR;
export const PERMISSIONS_MODERATOR_VOICE = TEXT_MODERATOR | VOICE_ADDON;
export const PERMISSIONS_ADMIN = TEXT_ADMIN;
export const PERMISSIONS_ADMIN_VOICE = TEXT_ADMIN | VOICE_ADMIN_ADDON;

export const DiscordPermissionTiers = {
  BASIC: Number(PERMISSIONS_BASIC),
  BASIC_VOICE: Number(PERMISSIONS_BASIC_VOICE),
  MODERATOR: Number(PERMISSIONS_MODERATOR),
  MODERATOR_VOICE: Number(PERMISSIONS_MODERATOR_VOICE),
  ADMIN: Number(PERMISSIONS_ADMIN),
  ADMIN_VOICE: Number(PERMISSIONS_ADMIN_VOICE),
} as const;

export type DiscordPermissionTier = keyof typeof DiscordPermissionTiers;

export function generateInviteUrl(
  applicationId: string,
  tier: DiscordPermissionTier = "MODERATOR_VOICE"
): string {
  const permissions = DiscordPermissionTiers[tier];
  return `https://discord.com/api/oauth2/authorize?client_id=${applicationId}&permissions=${permissions}&scope=bot%20applications.commands`;
}

export interface DiscordPermissionValues {
  basic: number;
  basicVoice: number;
  moderator: number;
  moderatorVoice: number;
  admin: number;
  adminVoice: number;
}

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

export interface DiscordInviteUrls {
  basic: string;
  basicVoice: string;
  moderator: string;
  moderatorVoice: string;
  admin: string;
  adminVoice: string;
}

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

export const REQUIRED_PERMISSIONS = PERMISSIONS_MODERATOR_VOICE;
