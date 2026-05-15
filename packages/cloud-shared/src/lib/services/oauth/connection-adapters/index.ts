/**
 * Connection Adapters
 *
 * Adapters abstract storage differences between platforms:
 * - Google uses platform_credentials table (legacy)
 * - Twitter, Twilio, Blooio use secrets table with naming patterns
 * - Generic providers (Linear, Notion, etc.) use platform_credentials via generic adapter
 */

import { getProvider } from "../provider-registry";
import type { ConnectionAdapter } from "./types";

export type { ConnectionAdapter } from "./types";

import { OAUTH_PROVIDERS } from "../provider-registry";
import { blooioAdapter } from "./blooio-adapter";
import {
  createGenericAdapter,
  githubAdapter,
  linearAdapter,
  microsoftAdapter,
  notionAdapter,
  slackAdapter,
} from "./generic-adapter";
import { twilioAdapter } from "./twilio-adapter";
import { twitterAdapter } from "./twitter-adapter";

// Google now uses the generic adapter (migrated from legacy google-adapter)
const googleAdapter = createGenericAdapter("google");
const asanaAdapter = createGenericAdapter("asana");
const dropboxAdapter = createGenericAdapter("dropbox");
const salesforceAdapter = createGenericAdapter("salesforce");
const airtableAdapter = createGenericAdapter("airtable");
const zoomAdapter = createGenericAdapter("zoom");
const jiraAdapter = createGenericAdapter("jira");
const linkedinAdapter = createGenericAdapter("linkedin");
const hubspotAdapter = createGenericAdapter("hubspot");

// Static adapters for known platforms
const staticAdapters: Record<string, ConnectionAdapter> = {
  google: googleAdapter,
  twitter: twitterAdapter,
  twilio: twilioAdapter,
  blooio: blooioAdapter,
  // Generic OAuth2 providers
  hubspot: hubspotAdapter,
  asana: asanaAdapter,
  dropbox: dropboxAdapter,
  salesforce: salesforceAdapter,
  airtable: airtableAdapter,
  zoom: zoomAdapter,
  jira: jiraAdapter,
  linkedin: linkedinAdapter,
  linear: linearAdapter,
  notion: notionAdapter,
  github: githubAdapter,
  slack: slackAdapter,
  microsoft: microsoftAdapter,
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
  for (const provider of Object.values(OAUTH_PROVIDERS)) {
    if (provider.storage === "platform_credentials" && provider.useGenericRoutes) {
      void getAdapter(provider.id);
    }
  }

  return [...Object.values(staticAdapters), ...Object.values(dynamicAdapters)];
}
