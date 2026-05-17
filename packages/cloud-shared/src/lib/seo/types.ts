/**
 * SEO type definitions for metadata and structured data.
 */

import type { Metadata } from "./metadata-types";

export type { Metadata } from "./metadata-types";

/**
 * Parameters for generating Open Graph images.
 */
export interface OGImageParams {
  type: "default" | "character" | "chat" | "container";
  title?: string;
  description?: string;
  id?: string;
  name?: string;
  characterName?: string;
  roomId?: string;
  avatarUrl?: string;
}

/**
 * Options for generating page metadata.
 */
export interface PageMetadataOptions {
  title: string;
  description: string;
  keywords?: readonly string[] | string[];
  path: string;
  ogImage?: string;
  type?: "website" | "article" | "profile";
  noIndex?: boolean;
}

/**
 * Options for generating dynamic metadata for entity pages.
 */
export interface DynamicMetadataOptions extends PageMetadataOptions {
  entityId: string;
  entityType: "character" | "container" | "chat" | "generation";
  updatedAt?: Date;
}

/**
 * Options for generating structured data (JSON-LD).
 */
export interface StructuredDataOptions {
  type: "Organization" | "WebApplication" | "Product" | "Article" | "SoftwareApplication";
  name: string;
  description?: string;
  url?: string;
  image?: string;
  additionalProperties?: Record<string, unknown>;
}

/**
 * Function type for generating metadata.
 */
export type MetadataGenerator = (options: PageMetadataOptions | DynamicMetadataOptions) => Metadata;
