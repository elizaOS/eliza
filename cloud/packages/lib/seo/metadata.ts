/**
 * SEO metadata generation utilities for pages and route handlers.
 */

import { getAppUrl } from "@/lib/utils/app-url";
import { SEO_CONSTANTS } from "./constants";
import { getRobotsMetadata } from "./environment";
import type { Metadata } from "./metadata-types";
import type { DynamicMetadataOptions, OGImageParams, PageMetadataOptions } from "./types";

/**
 * Generates an Open Graph image URL.
 *
 * @param params - OG image parameters.
 * @returns URL to the OG image endpoint.
 */
export function generateOGImageUrl(params: OGImageParams): string {
  const baseUrl = getAppUrl();
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      searchParams.set(key, String(value));
    }
  });

  return `${baseUrl}/api/og?${searchParams.toString()}`;
}

/**
 * Generates page metadata for `<title>` / OG / Twitter tags (consumer supplies Helmet or SSR).
 *
 * @param options - Page metadata options.
 * @returns Metadata object.
 */
export function generatePageMetadata(options: PageMetadataOptions): Metadata {
  const baseUrl = getAppUrl();
  const canonicalUrl = `${baseUrl}${options.path}`;

  // For dynamic pages with custom images, use provided ogImage
  // Static pages use opengraph-image.png file convention (no explicit image needed)
  // Fallback to /og-image.png in public/ for pages that explicitly need an image
  const ogImage = options.ogImage;

  const metadata: Metadata = {
    title: options.title,
    description: options.description,
    keywords: options.keywords ? [...options.keywords] : [...SEO_CONSTANTS.defaultKeywords],
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title: `${options.title} | ${SEO_CONSTANTS.siteName}`,
      description: options.description,
      url: canonicalUrl,
      siteName: SEO_CONSTANTS.siteName,
      type: options.type || "website",
      locale: SEO_CONSTANTS.locale,
      // Only include images if explicitly provided; otherwise rely on opengraph-image.png file convention
      ...(ogImage && {
        images: [
          {
            url: ogImage,
            width: SEO_CONSTANTS.ogImageDimensions.width,
            height: SEO_CONSTANTS.ogImageDimensions.height,
            alt: options.title,
          },
        ],
      }),
    },
    twitter: {
      card: SEO_CONSTANTS.twitterCardType,
      title: options.title,
      description: options.description,
      // Only include images if explicitly provided; otherwise rely on twitter-image.png file convention
      ...(ogImage && { images: [ogImage] }),
      creator: SEO_CONSTANTS.twitterHandle,
      site: SEO_CONSTANTS.twitterHandle,
    },
  };

  metadata.robots = getRobotsMetadata({ noIndex: options.noIndex });

  return metadata;
}

/**
 * Generates dynamic metadata for entity pages (characters, containers, etc.).
 *
 * @param options - Dynamic metadata options with entity information.
 * @returns Metadata object.
 */
export function generateDynamicMetadata(options: DynamicMetadataOptions): Metadata {
  const baseMetadata = generatePageMetadata(options);

  if (options.type === "article" && options.updatedAt) {
    baseMetadata.openGraph = {
      ...baseMetadata.openGraph,
      type: "article",
      modifiedTime: options.updatedAt.toISOString(),
    };
  }

  if (options.type === "profile") {
    baseMetadata.openGraph = {
      ...baseMetadata.openGraph,
      type: "profile",
    };
  }

  return baseMetadata;
}

/**
 * Generates metadata for a container page.
 *
 * @param id - Container ID.
 * @param name - Container name.
 * @param description - Container description.
 * @param characterName - Optional character name running in container.
 * @returns Metadata object.
 */
export function generateContainerMetadata(
  id: string,
  name: string,
  description: string | null,
  characterName?: string | null,
): Metadata {
  const title = `${name} - Container Details`;
  const desc =
    description ||
    `View logs, metrics, and deployment history for ${name}${characterName ? ` running ${characterName}` : ""}`;

  return generateDynamicMetadata({
    title,
    description: desc,
    keywords: ["container", "deployment", name, ...(characterName ? [characterName] : [])],
    path: `/dashboard/containers/${id}`,
    ogImage: "/og-image.png",
    entityId: id,
    entityType: "container",
  });
}

/**
 * Generates metadata for a character page.
 *
 * @param id - Character ID.
 * @param name - Character name.
 * @param bio - Character bio (string or array).
 * @param avatarUrl - Character avatar URL.
 * @param tags - Optional tags for keywords.
 * @returns Metadata object.
 */
export function generateCharacterMetadata(
  id: string,
  name: string,
  bio: string | string[],
  avatarUrl: string | null,
  tags: string[] = [],
): Metadata {
  const bioText = Array.isArray(bio) ? bio[0] : bio;
  const description = bioText.slice(0, 160);

  return generateDynamicMetadata({
    title: `${name} - AI Character`,
    description,
    keywords: [name, "AI character", "AI agent", "elizaOS", ...tags],
    path: `/dashboard/my-agents/${id}`,
    ogImage: avatarUrl || "/og-image.png",
    type: "profile",
    entityId: id,
    entityType: "character",
  });
}

/**
 * Generates metadata for a chat/room page.
 *
 * @param roomId - Room ID.
 * @param characterName - Character name.
 * @param messageCount - Number of messages in the conversation.
 * @param characterAvatarUrl - Optional character avatar URL.
 * @returns Metadata object.
 */
export function generateChatMetadata(
  roomId: string,
  characterName: string,
  messageCount: number,
  characterAvatarUrl?: string | null,
): Metadata {
  const title = `Chat with ${characterName}`;
  const description = `${messageCount} message${messageCount === 1 ? "" : "s"} in this conversation with ${characterName}`;

  return generateDynamicMetadata({
    title,
    description,
    keywords: [characterName, "AI chat", "conversation", "elizaOS"],
    path: `/chat/${roomId}`,
    ogImage: characterAvatarUrl || "/og-image.png",
    type: "article",
    entityId: roomId,
    entityType: "chat",
  });
}
