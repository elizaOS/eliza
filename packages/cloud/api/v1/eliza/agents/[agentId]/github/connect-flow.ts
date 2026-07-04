// Handles v1 cloud API v1 eliza agents agentid github connect flow route traffic with route-local auth expectations.
export const GITHUB_DEVICE_CONNECT_EXPIRES_IN_SECONDS = 600;
export const GITHUB_DEVICE_CONNECT_POLL_INTERVAL_SECONDS = 2;

export function resolveManagedGitHubReturnUrl(
  agentId: string,
  organizationId: string,
  userId: string,
  args?: {
    postMessage?: boolean;
    returnUrl?: string;
  },
): string {
  const params = new URLSearchParams({
    agent_id: agentId,
    org_id: organizationId,
    user_id: userId,
  });
  if (args?.postMessage) {
    params.set("post_message", "1");
  }
  if (args?.returnUrl) {
    params.set("return_url", args.returnUrl);
  }
  return `/api/v1/eliza/github-oauth-complete?${params.toString()}`;
}

export function resolveManagedGitHubPollUrl(agentId: string): string {
  return `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/github`;
}
