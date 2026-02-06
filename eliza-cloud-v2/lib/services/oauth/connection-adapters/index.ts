/**
 * Connection Adapters
 *
 * Adapters abstract storage differences between platforms:
 * - Google uses platform_credentials table (legacy)
 * - Twitter, Twilio, Blooio use secrets table with naming patterns
 * - Generic providers (Linear, Notion, etc.) use platform_credentials via generic adapter
 */

import type { OAuthConnection, TokenResult } from "../types";
import { getProvider } from "../provider-registry";

export interface ConnectionAdapter {
  platform: string;
  listConnections(organizationId: string): Promise<OAuthConnection[]>;
  getToken(organizationId: string, connectionId: string): Promise<TokenResult>;
  revoke(organizationId: string, connectionId: string): Promise<void>;
  ownsConnection(connectionId: string): Promise<boolean>;
}

import { twitterAdapter } from "./twitter-adapter";
import { twilioAdapter } from "./twilio-adapter";
import { blooioAdapter } from "./blooio-adapter";
import {
  createGenericAdapter,
  linearAdapter,
  notionAdapter,
  githubAdapter,
  slackAdapter,
} from "./generic-adapter";

// Google now uses the generic adapter (migrated from legacy google-adapter)
const googleAdapter = createGenericAdapter("google");

// Static adapters for known platforms
const staticAdapters: Record<string, ConnectionAdapter> = {
  google: googleAdapter,
  twitter: twitterAdapter,
  twilio: twilioAdapter,
  blooio: blooioAdapter,
  // Generic OAuth2 providers
  linear: linearAdapter,
  notion: notionAdapter,
  github: githubAdapter,
  slack: slackAdapter,
};

// Cache for dynamically created adapters
const dynamicAdapters: Record<string, ConnectionAdapter> = {};

/** Get adapter for a platform, creating a generic adapter if needed. */
export function getAdapter(platform: string): ConnectionAdapter | null {
  if (staticAdapters[platform]) return staticAdapters[platform];
  if (dynamicAdapters[platform]) return dynamicAdapters[platform];

  const provider = getProvider(platform);
  if (provider?.useGenericRoutes && provider.storage === "platform_credentials") {
    dynamicAdapters[platform] = createGenericAdapter(platform);
    return dynamicAdapters[platform];
  }
  return null;
}

/** Get all registered adapters (static + cached dynamic). */
export function getAllAdapters(): ConnectionAdapter[] {
  return [...Object.values(staticAdapters), ...Object.values(dynamicAdapters)];
}
