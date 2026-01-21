import "server-only";

/**
 * PostHog Server Client
 * Server-side analytics and event tracking for API routes
 */

import { PostHog } from "posthog-node";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
type StringRecord<T> = Record<string, T>;

let posthogClient: PostHog | null = null;

/**
 * Get the PostHog server client
 */
export function getPostHogServerClient(): PostHog | null {
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const apiHost =
    process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";

  if (!apiKey) {
    return null;
  }

  // Singleton pattern
  if (!posthogClient) {
    posthogClient = new PostHog(apiKey, {
      host: apiHost,
      flushAt: 20, // Flush after 20 events
      flushInterval: 10000, // Flush every 10 seconds
      requestTimeout: 5000, // 5 seconds for serverless
    });
  }

  return posthogClient;
}

/**
 * Track server-side event
 */
export async function trackServerEvent(
  distinctId: string,
  event: string,
  properties?: StringRecord<JsonValue>,
): Promise<void> {
  const client = getPostHogServerClient();
  if (!client) return;

  client.capture({
    distinctId,
    event,
    properties: {
      ...properties,
      $lib: "posthog-node",
      environment: process.env.NODE_ENV || "development",
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * Identify user on server
 */
export async function identifyServerUser(
  distinctId: string,
  properties: StringRecord<JsonValue>,
): Promise<void> {
  const client = getPostHogServerClient();
  if (!client) return;

  client.identify({
    distinctId,
    properties,
  });
}

/**
 * Track API error
 */
export async function trackServerError(
  distinctId: string | null,
  error: Error,
  context: {
    endpoint: string;
    method: string;
    statusCode?: number;
  } & StringRecord<JsonValue>,
): Promise<void> {
  const client = getPostHogServerClient();
  if (!client) return;

  const { endpoint, method, statusCode, ...otherContext } = context;

  client.capture({
    distinctId: distinctId || "anonymous",
    event: "$exception",
    properties: {
      $exception_type: error.name || "Error",
      $exception_message: error.message || "",
      $exception_stack: error.stack || "",
      endpoint,
      method,
      ...(statusCode !== undefined && { statusCode }),
      ...otherContext,
      environment: process.env.NODE_ENV || "development",
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * Flush all pending events (important for serverless functions)
 */
export async function flushPostHog(): Promise<void> {
  if (!posthogClient) return;

  const flushPromise = posthogClient.flush();
  const timeoutPromise = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error("PostHog flush timeout")), 3000);
  });

  await Promise.race([flushPromise, timeoutPromise]);
}

/**
 * Shutdown PostHog client gracefully
 */
export async function shutdownPostHog(): Promise<void> {
  if (!posthogClient) return;

  const shutdownPromise = posthogClient.shutdown();
  const timeoutPromise = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error("PostHog shutdown timeout")), 3000);
  });

  await Promise.race([shutdownPromise, timeoutPromise]);
  posthogClient = null;
}
