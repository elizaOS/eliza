/**
 * App Lifecycle Test Helpers
 *
 * Utilities for creating, configuring, and cleaning up apps in E2E tests.
 * Designed to run against live Eliza Cloud using API key auth.
 */

import * as api from "./api-client";

/** Unique suffix for test isolation */
function testSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Generate a test app payload */
export function testAppPayload(overrides?: Record<string, unknown>) {
  const suffix = testSuffix();
  return {
    name: `E2E Test App ${suffix}`,
    description: "Automated E2E test app — safe to delete",
    app_url: `https://test-${suffix}.example.com`,
    skipGitHubRepo: true,
    ...overrides,
  };
}

/** Create an app and return the parsed response body */
export async function createTestApp(
  overrides?: Record<string, unknown>,
): Promise<{ response: Response; body: any }> {
  const payload = testAppPayload(overrides);
  const response = await api.post("/api/v1/apps", payload, {
    authenticated: true,
  });
  const body = await response.json();
  return { response, body };
}

/** Delete an app, swallowing 404s (already deleted) */
export async function deleteTestApp(appId: string): Promise<void> {
  await api.del(`/api/v1/apps/${appId}?deleteGitHubRepo=false`, {
    authenticated: true,
  });
}

/** Enable monetization on an app */
export async function enableMonetization(
  appId: string,
  settings?: {
    inferenceMarkupPercentage?: number;
    purchaseSharePercentage?: number;
  },
): Promise<{ response: Response; body: any }> {
  const response = await api.put(
    `/api/v1/apps/${appId}/monetization`,
    {
      monetizationEnabled: true,
      inferenceMarkupPercentage: settings?.inferenceMarkupPercentage ?? 50,
      purchaseSharePercentage: settings?.purchaseSharePercentage ?? 10,
    },
    { authenticated: true },
  );
  const body = await response.json();
  return { response, body };
}

/** Get monetization settings for an app */
export async function getMonetization(appId: string): Promise<{ response: Response; body: any }> {
  const response = await api.get(`/api/v1/apps/${appId}/monetization`, {
    authenticated: true,
  });
  const body = await response.json();
  return { response, body };
}

/** Get earnings for an app */
export async function getEarnings(appId: string): Promise<{ response: Response; body: any }> {
  const response = await api.get(`/api/v1/apps/${appId}/earnings`, {
    authenticated: true,
  });
  const body = await response.json();
  return { response, body };
}

/** Get public info for an app (no auth required) */
export async function getPublicAppInfo(appId: string): Promise<{ response: Response; body: any }> {
  const response = await api.get(`/api/v1/apps/${appId}/public`);
  const body = await response.json();
  return { response, body };
}

/**
 * Generate a test character/agent payload for POST /api/v1/app/agents.
 * This is the actual character creation endpoint (not /api/my-agents/characters which is GET-only).
 */
export function testAgentPayload(overrides?: Record<string, unknown>) {
  const suffix = testSuffix();
  return {
    name: `E2E Test Agent ${suffix}`,
    bio: "Automated E2E test agent for monetization testing",
    ...overrides,
  };
}

/**
 * Create a character/agent via the Cloud API.
 * Uses POST /api/v1/app/agents which accepts {name, bio} and returns {success, agent: {id, ...}}.
 */
export async function createTestAgent(
  overrides?: Record<string, unknown>,
): Promise<{ response: Response; body: any; agentId: string | undefined }> {
  const payload = testAgentPayload(overrides);
  const response = await api.post("/api/v1/app/agents", payload, {
    authenticated: true,
  });
  const body = await response.json();
  const agentId = body.agent?.id;
  return { response, body, agentId };
}

/**
 * Delete a character/agent. Uses the my-agents endpoint for deletion.
 */
export async function deleteTestAgent(agentId: string): Promise<void> {
  // Unpublish first (ignore errors)
  await api.del(`/api/v1/agents/${agentId}/publish`, { authenticated: true }).catch(() => {});
  // Then delete the character
  await api.del(`/api/my-agents/characters/${agentId}`, { authenticated: true }).catch(() => {});
}
