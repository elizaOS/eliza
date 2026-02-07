/**
 * PostHog Server-Side Analytics
 *
 * Use this for tracking events from API routes and server-side code.
 * Events are sent asynchronously and don't block the response.
 */

import { PostHog } from "posthog-node";
import type { PostHogEvent, EventProperties } from "./posthog";
import { logger } from "@/lib/utils/logger";

let posthogClient: PostHog | null = null;

function getPostHogClient(): PostHog | null {
  // Initialize if key is set (allows staging/preview to opt-in)
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!apiKey) return null;

  if (!posthogClient) {
    posthogClient = new PostHog(apiKey, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
      flushAt: 20,
      flushInterval: 10000,
    });
  }

  return posthogClient;
}

export function trackServerEvent(
  distinctId: string,
  event: PostHogEvent,
  properties?: EventProperties,
): void {
  const client = getPostHogClient();
  if (!client) return;

  try {
    client.capture({
      distinctId,
      event,
      properties: {
        ...properties,
        $lib: "posthog-node",
        source: "server",
      },
    });
  } catch (error) {
    logger.error("[PostHog] Failed to track event", { error });
  }
}

export interface ServerUserProperties {
  email?: string;
  name?: string;
  organization_id?: string;
  organization_name?: string;
  wallet_address?: string;
  signup_method?: string;
  created_at?: string;
  [key: string]: string | number | boolean | undefined;
}

export function identifyServerUser(
  distinctId: string,
  properties: ServerUserProperties,
): void {
  const client = getPostHogClient();
  if (!client) return;

  try {
    client.identify({ distinctId, properties });
  } catch (error) {
    logger.error("[PostHog] Failed to identify user", { error });
  }
}

export async function flushPostHog(): Promise<void> {
  const client = getPostHogClient();
  if (!client) return;

  await client.flush();
}

export async function shutdownPostHog(): Promise<void> {
  if (!posthogClient) return;

  await posthogClient.shutdown();
  posthogClient = null;
}
