import { z } from "zod";

/**
 * Supported social media platforms.
 *
 * Not currently supported (require different API patterns or restricted access):
 * - YouTube: Video-only platform requiring Google API OAuth and upload workflows
 * - Pinterest: Pin-based content requiring Pinterest Business API access
 * - Snapchat: Stories API requires Snapchat Business Manager approval
 * - Tumblr: NPF format requires different content structure
 * - Medium: Publication API deprecated, requires Partner Program access
 * - DEV.to: Article API (not social posting, different use case)
 * - Threads: API not publicly available
 * - WhatsApp: Business API requires Meta verification, template-based messaging
 */
export type SocialPlatform =
  | "twitter"
  | "bluesky"
  | "discord"
  | "telegram"
  | "slack"
  | "reddit"
  | "facebook"
  | "instagram"
  | "tiktok"
  | "linkedin"
  | "mastodon";

export interface MediaAttachment {
  type: "image" | "video" | "gif";
  url?: string;
  data?: Buffer;
  base64?: string;
  mimeType: string;
  altText?: string;
  thumbnailUrl?: string;
}

export interface PostContent {
  text: string;
  media?: MediaAttachment[];
  link?: string;
  linkTitle?: string;
  linkDescription?: string;
  hashtags?: string[];
  mentions?: string[];
  replyToId?: string;
  quoteId?: string;
}

export interface TwitterPostOptions {
  replySettings?: "everyone" | "mentionedUsers" | "following";
  quoteTweetId?: string;
  pollOptions?: string[];
  pollDurationMinutes?: number;
}

export interface BlueskyPostOptions {
  languages?: string[];
  labels?: string[];
  threadGate?: {
    allowMentioned?: boolean;
    allowFollowing?: boolean;
    allowLists?: string[];
  };
}

export interface DiscordPostOptions {
  channelId: string;
  serverId?: string;
  webhookUrl?: string;
  components?: DiscordActionRow[];
  embed?: {
    title?: string;
    description?: string;
    url?: string;
    color?: number;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    thumbnail?: { url: string };
    image?: { url: string };
    footer?: { text: string; icon_url?: string };
  };
}

export interface DiscordButton {
  type: 2;
  style: 5;
  label: string;
  url: string;
}

export interface DiscordActionRow {
  type: 1;
  components: DiscordButton[];
}

export interface TelegramInlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
  switch_inline_query?: string;
  switch_inline_query_current_chat?: string;
}

export type TelegramInlineKeyboard = TelegramInlineKeyboardButton[][];

export interface TelegramPostOptions {
  chatId: string | number;
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
  disableWebPagePreview?: boolean;
  disableNotification?: boolean;
  replyToMessageId?: number;
  inlineKeyboard?: TelegramInlineKeyboard;
}

export interface RedditPostOptions {
  subreddit: string;
  title: string;
  flair?: string;
  nsfw?: boolean;
  spoiler?: boolean;
  sendReplies?: boolean;
}

export interface FacebookPostOptions {
  pageId: string;
  targeting?: {
    countries?: string[];
    cities?: string[];
    ageMin?: number;
    ageMax?: number;
  };
  published?: boolean;
  scheduledPublishTime?: number;
}

export interface InstagramPostOptions {
  accountId: string;
  shareToFeed?: boolean;
  shareToStory?: boolean;
  locationId?: string;
  userTags?: Array<{ userId: string; x: number; y: number }>;
}

export interface TikTokPostOptions {
  privacyLevel?: "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "SELF_ONLY";
  disableDuet?: boolean;
  disableStitch?: boolean;
  disableComment?: boolean;
  videoCoverTimestampMs?: number;
  brandContentToggle?: boolean;
  brandOrganicToggle?: boolean;
}

export interface LinkedInPostOptions {
  visibility?: "PUBLIC" | "CONNECTIONS" | "LOGGED_IN";
  organizationId?: string;
  shareToCompanyPage?: boolean;
}

export interface MastodonPostOptions {
  instanceUrl: string;
  visibility?: "public" | "unlisted" | "private" | "direct";
  sensitive?: boolean;
  spoilerText?: string;
  language?: string;
  pollOptions?: string[];
  pollExpiresIn?: number;
}

export interface SlackPostOptions {
  channelId: string;
  threadTs?: string;
  unfurlLinks?: boolean;
  unfurlMedia?: boolean;
  mrkdwn?: boolean;
  username?: string;
  iconEmoji?: string;
  iconUrl?: string;
}

export type PlatformPostOptions = {
  twitter?: TwitterPostOptions;
  bluesky?: BlueskyPostOptions;
  discord?: DiscordPostOptions;
  telegram?: TelegramPostOptions;
  slack?: SlackPostOptions;
  reddit?: RedditPostOptions;
  facebook?: FacebookPostOptions;
  instagram?: InstagramPostOptions;
  tiktok?: TikTokPostOptions;
  linkedin?: LinkedInPostOptions;
  mastodon?: MastodonPostOptions;
};

export interface PostResult {
  platform: SocialPlatform;
  success: boolean;
  postId?: string;
  postUrl?: string;
  error?: string;
  errorCode?: string;
  rateLimited?: boolean;
  retryAfter?: number;
  metadata?: Record<string, unknown>;
}

export interface MultiPlatformPostResult {
  results: PostResult[];
  successful: PostResult[];
  failed: PostResult[];
  totalPlatforms: number;
  successCount: number;
  failureCount: number;
}

export interface PostAnalytics {
  platform: SocialPlatform;
  postId: string;
  metrics: {
    impressions?: number;
    reach?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    reposts?: number;
    saves?: number;
    clicks?: number;
    engagementRate?: number;
    videoViews?: number;
    videoWatchTime?: number;
  };
  fetchedAt: Date;
}

export interface AccountAnalytics {
  platform: SocialPlatform;
  accountId: string;
  metrics: {
    followers?: number;
    following?: number;
    totalPosts?: number;
    profileViews?: number;
    impressionsLast30Days?: number;
    engagementRate?: number;
  };
  fetchedAt: Date;
}

export interface SocialCredentials {
  platform?: SocialPlatform;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
  apiKey?: string;
  apiSecret?: string;
  botToken?: string;
  username?: string;
  password?: string;
  email?: string;
  twoFactorSecret?: string;
  appPassword?: string;
  handle?: string;
  webhookUrl?: string;
  pageId?: string;
  accountId?: string;
  serverId?: string;
  channelId?: string;
  /** Mastodon instance URL (e.g., https://mastodon.social) */
  instanceUrl?: string;
}

export interface SocialMediaProvider {
  platform: SocialPlatform;
  validateCredentials(credentials: SocialCredentials): Promise<{
    valid: boolean;
    accountId?: string;
    username?: string;
    displayName?: string;
    avatarUrl?: string;
    error?: string;
  }>;
  createPost(
    credentials: SocialCredentials,
    content: PostContent,
    options?: PlatformPostOptions,
  ): Promise<PostResult>;
  deletePost?(
    credentials: SocialCredentials,
    postId: string,
  ): Promise<{ success: boolean; error?: string }>;
  getPostAnalytics?(credentials: SocialCredentials, postId: string): Promise<PostAnalytics | null>;
  getAccountAnalytics?(credentials: SocialCredentials): Promise<AccountAnalytics | null>;
  uploadMedia?(
    credentials: SocialCredentials,
    media: MediaAttachment,
  ): Promise<{ mediaId: string; url?: string }>;
  replyToPost?(
    credentials: SocialCredentials,
    postId: string,
    content: PostContent,
    options?: PlatformPostOptions,
  ): Promise<PostResult>;
  likePost?(
    credentials: SocialCredentials,
    postId: string,
  ): Promise<{ success: boolean; error?: string }>;
  repost?(credentials: SocialCredentials, postId: string): Promise<PostResult>;
}

export interface CreatePostInput {
  organizationId: string;
  userId?: string;
  content: PostContent;
  platforms: SocialPlatform[];
  platformOptions?: PlatformPostOptions;
  credentialIds?: Partial<Record<SocialPlatform, string>>;
}

export interface GetAnalyticsInput {
  organizationId: string;
  platform: SocialPlatform;
  postId?: string;
  credentialId?: string;
}

export const SUPPORTED_PLATFORMS: SocialPlatform[] = [
  "twitter",
  "bluesky",
  "discord",
  "telegram",
  "slack",
  "reddit",
  "facebook",
  "instagram",
  "tiktok",
  "linkedin",
  "mastodon",
];

export const PLATFORM_CAPABILITIES: Record<
  SocialPlatform,
  {
    supportsText: boolean;
    supportsImages: boolean;
    supportsVideo: boolean;
    maxTextLength: number;
    maxImages: number;
  }
> = {
  twitter: {
    supportsText: true,
    supportsImages: true,
    supportsVideo: true,
    maxTextLength: 280,
    maxImages: 4,
  },
  bluesky: {
    supportsText: true,
    supportsImages: true,
    supportsVideo: false,
    maxTextLength: 300,
    maxImages: 4,
  },
  discord: {
    supportsText: true,
    supportsImages: true,
    supportsVideo: true,
    maxTextLength: 2000,
    maxImages: 10,
  },
  telegram: {
    supportsText: true,
    supportsImages: true,
    supportsVideo: true,
    maxTextLength: 4096,
    maxImages: 10,
  },
  slack: {
    supportsText: true,
    supportsImages: true,
    supportsVideo: true,
    maxTextLength: 40000,
    maxImages: 10,
  },
  reddit: {
    supportsText: true,
    supportsImages: true,
    supportsVideo: true,
    maxTextLength: 40000,
    maxImages: 20,
  },
  facebook: {
    supportsText: true,
    supportsImages: true,
    supportsVideo: true,
    maxTextLength: 63206,
    maxImages: 10,
  },
  instagram: {
    supportsText: true,
    supportsImages: true,
    supportsVideo: true,
    maxTextLength: 2200,
    maxImages: 10,
  },
  tiktok: {
    supportsText: false,
    supportsImages: false,
    supportsVideo: true,
    maxTextLength: 2200,
    maxImages: 0,
  },
  linkedin: {
    supportsText: true,
    supportsImages: true,
    supportsVideo: true,
    maxTextLength: 3000,
    maxImages: 9,
  },
  mastodon: {
    supportsText: true,
    supportsImages: true,
    supportsVideo: true,
    maxTextLength: 500,
    maxImages: 4,
  },
};

export function validatePostContent(
  content: Partial<PostContent>,
  platform: SocialPlatform,
): { valid: boolean; error?: string } {
  const cap = PLATFORM_CAPABILITIES[platform];

  if (!cap.supportsText && !content.media?.some((m) => m.type === "video")) {
    return { valid: false, error: `${platform} requires video content` };
  }

  if (content.text && content.text.length > cap.maxTextLength) {
    return {
      valid: false,
      error: `Text length ${content.text.length} exceeds ${platform} limit of ${cap.maxTextLength}`,
    };
  }

  if (content.media) {
    const imageCount = content.media.filter((m) => m.type === "image").length;
    if (imageCount > cap.maxImages) {
      return {
        valid: false,
        error: `Number of images ${imageCount} exceeds ${platform} limit of ${cap.maxImages}`,
      };
    }
  }

  return { valid: true };
}

export function validatePlatformOptions(
  platform: SocialPlatform,
  options: Record<string, unknown>,
): { valid: boolean; error?: string } {
  if (platform === "reddit" && !options.subreddit) {
    return { valid: false, error: "Reddit requires a subreddit" };
  }
  if (platform === "discord" && !options.channelId && !options.webhookUrl) {
    return { valid: false, error: "Discord requires channelId or webhookUrl" };
  }
  if (platform === "telegram" && !options.chatId) {
    return { valid: false, error: "Telegram requires chatId" };
  }
  if (platform === "slack" && !options.channelId && !options.webhookUrl) {
    return { valid: false, error: "Slack requires channelId or webhookUrl" };
  }
  return { valid: true };
}

export function createSuccessResult(
  platform: SocialPlatform,
  postId: string,
  url?: string,
  metadata?: Record<string, unknown>,
): PostResult {
  return { platform, success: true, postId, postUrl: url, metadata };
}

export function createErrorResult(
  platform: SocialPlatform,
  error: string,
  errorCode?: string,
  rateLimited?: boolean,
  retryAfter?: number,
): PostResult {
  return {
    platform,
    success: false,
    error,
    errorCode,
    rateLimited,
    retryAfter,
  };
}

export function aggregateResults(results: PostResult[]): MultiPlatformPostResult {
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  return {
    results,
    successful,
    failed,
    totalPlatforms: results.length,
    successCount: successful.length,
    failureCount: failed.length,
  };
}

export function calculatePostCredits(
  platforms: SocialPlatform[],
  content: Partial<PostContent>,
): number {
  const BASE = 10;
  const MEDIA_COST = 5;
  const MULTIPLIERS: Partial<Record<SocialPlatform, number>> = {
    tiktok: 2.0,
    instagram: 1.5,
    linkedin: 1.5,
  };

  return platforms.reduce((total, platform) => {
    const base = BASE + (content.media?.length || 0) * MEDIA_COST;
    return total + Math.ceil(base * (MULTIPLIERS[platform] || 1.0));
  }, 0);
}

// =============================================================================
// SHARED ZOD SCHEMAS
// =============================================================================

export const SocialPlatformSchema = z.enum([
  "twitter",
  "bluesky",
  "discord",
  "telegram",
  "slack",
  "reddit",
  "facebook",
  "instagram",
  "tiktok",
  "linkedin",
  "mastodon",
]);

export const NotificationPlatformSchema = z.enum(["discord", "telegram", "slack"]);

export const MediaAttachmentSchema = z.object({
  type: z.enum(["image", "video", "gif"]),
  url: z.string().url().optional(),
  base64: z.string().optional(),
  mimeType: z.string(),
  altText: z.string().optional(),
});

export const PostContentSchema = z.object({
  text: z.string().max(5000),
  media: z.array(MediaAttachmentSchema).max(4).optional(),
  link: z.string().url().optional(),
  linkTitle: z.string().optional(),
  linkDescription: z.string().optional(),
  hashtags: z.array(z.string()).optional(),
  mentions: z.array(z.string()).optional(),
  replyToId: z.string().optional(),
  quoteId: z.string().optional(),
});

export const NotificationChannelSchema = z.object({
  platform: NotificationPlatformSchema,
  channelId: z.string(),
  serverId: z.string().optional(),
  connectionId: z.string().optional(),
  threadId: z.string().optional(),
});

export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;
