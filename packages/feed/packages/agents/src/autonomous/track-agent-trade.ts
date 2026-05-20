/**
 * Server-side PostHog tracking for agent trades.
 * Used by AutonomousTradingService, AutonomousA2AService, and MultiStepExecutor
 * when running in the Next.js app (e.g. cron); no-ops when NEXT_PUBLIC_POSTHOG_PROJECT_ID is not set.
 * Environment properties match apps/web/src/lib/posthog/server.ts for consistent filtering.
 */

import { checkProgress } from '@babylon/api';
import { PostHog } from 'posthog-node';

let client: PostHog | null = null;

function getServerEnvironment(): 'production' | 'staging' | 'development' {
  if (process.env.VERCEL_ENV === 'production') return 'production';
  if (process.env.VERCEL_ENV === 'preview') return 'staging';
  if (process.env.NODE_ENV === 'production') return 'production';
  return 'development';
}

function getEnvironmentProperties(): Record<string, string> {
  return {
    environment: getServerEnvironment(),
    deployment_url: process.env.VERCEL_URL || 'localhost:3000',
    app_version: process.env.VERCEL_GIT_COMMIT_SHA || 'dev',
  };
}

function getClient(): PostHog | null {
  if (client !== null) return client;
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_ID;
  const apiHost =
    process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com';
  if (!apiKey) return null;
  try {
    // Match the config in apps/web/src/lib/posthog/server.ts so cron/serverless
    // executions don't hang on a slow PostHog endpoint.
    client = new PostHog(apiKey, {
      host: apiHost,
      flushAt: 20,
      flushInterval: 10000,
      requestTimeout: 5000,
    });
  } catch {
    return null;
  }
  return client;
}

export interface AgentTradeExecutedProperties {
  agent_id: string;
  market_type: 'prediction' | 'perp';
  action: string;
  market_id?: string;
  ticker?: string;
  side?: string;
  amount?: number;
  owner_id: string;
}

/**
 * Track agent_trade_executed in PostHog.
 *
 * distinctId is the owning human's user ID (owner_id) so PostHog funnels,
 * retention, and People records reflect the owner, not the agent. This
 * matches how agent_message_sent is tracked in the web app (trackServerEvent
 * uses the human user's ID as distinctId, with agent_id as a property).
 * The agent user ID is included as agent_id in properties.
 */
export function trackAgentTradeExecuted(
  agentUserId: string,
  properties: AgentTradeExecutedProperties
): void {
  const c = getClient();
  if (!c) return;
  try {
    c.capture({
      // Use owner as the actor so PostHog user counts represent humans, not agents
      distinctId: properties.owner_id,
      event: 'agent_trade_executed',
      properties: {
        ...properties,
        agent_id: agentUserId,
        $lib: 'posthog-node',
        ...getEnvironmentProperties(),
        timestamp: new Date().toISOString(),
      },
    });
  } catch {
    // no-op on error to avoid breaking trade flow
  }

  // Track for achievements (fire-and-forget, uses owner's userId)
  void checkProgress(properties.owner_id, { type: 'agent_trade_executed' });
}
