/**
 * PostHog Client Utilities
 *
 * For client-side usage only.
 * Server-side code should import directly from './server':
 *
 * import { trackServerEvent } from '@/lib/posthog/server';
 */

export type { PostHogClient } from "./client";
export { getPostHog, initPostHog, posthog } from "./client";
