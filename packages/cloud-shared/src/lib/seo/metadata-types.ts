/**
 * Page metadata shape used by `@/lib/seo` helpers (Vite SPA + API routes).
 * Replaces `import type { Metadata } from "next"` now that Next.js is not used.
 */

export interface MetadataRobots {
  index?: boolean;
  follow?: boolean;
  googleBot?: {
    index?: boolean;
    follow?: boolean;
    "max-video-preview"?: number;
    "max-image-preview"?: "large" | "none" | "standard";
    "max-snippet"?: number;
  };
}

export interface Metadata {
  title?: string;
  description?: string;
  keywords?: readonly string[] | string[];
  alternates?: { canonical?: string };
  openGraph?: {
    title?: string;
    description?: string;
    url?: string;
    siteName?: string;
    type?: string;
    locale?: string;
    images?: Array<{ url: string; width?: number; height?: number; alt?: string }>;
    modifiedTime?: string;
  };
  twitter?: {
    card?: string;
    title?: string;
    description?: string;
    images?: string[];
    creator?: string;
    site?: string;
  };
  robots?: MetadataRobots;
}

export namespace MetadataRoute {
  export interface RobotsRule {
    userAgent: string | string[];
    allow?: string | string[];
    disallow?: string | string[];
  }

  export interface Robots {
    rules: RobotsRule | RobotsRule[];
    host?: string | string[];
    sitemap?: string | string[];
  }
}
