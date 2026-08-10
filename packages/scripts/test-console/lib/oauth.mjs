/**
 * Interactive Eliza Cloud device-code login for the local test console.
 *
 * Cloud login speaks the same protocol as ElizaCloudClient.startCliLogin /
 * waitForCliLogin in packages/cloud/sdk/src/client.ts (POST
 * /api/auth/cli-session, then poll /api/auth/cli-session/:id until
 * `authenticated`), reimplemented over bare fetch so the console keeps zero
 * workspace imports and works in a half-built checkout — protocol drift there
 * is an API-versioning event, not a refactor hazard.
 *
 */

export const DEFAULT_CLOUD_BASE_URL = "https://elizacloud.ai";

export async function startCloudLogin({
  baseUrl = DEFAULT_CLOUD_BASE_URL,
} = {}) {
  const response = await fetch(`${baseUrl}/api/auth/cli-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client: "eliza-test-console" }),
  });
  if (!response.ok) {
    throw new Error(`cloud cli-session failed: HTTP ${response.status}`);
  }
  const { sessionId, browserUrl } = await response.json();
  return { sessionId, browserUrl };
}

export async function pollCloudLogin({
  sessionId,
  baseUrl = DEFAULT_CLOUD_BASE_URL,
}) {
  const response = await fetch(`${baseUrl}/api/auth/cli-session/${sessionId}`);
  if (!response.ok) {
    throw new Error(`cloud cli-session poll failed: HTTP ${response.status}`);
  }
  return response.json();
}
