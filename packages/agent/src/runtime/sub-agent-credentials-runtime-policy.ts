export function shouldRegisterSubAgentCredentialsPlugin(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !(
    env.SANDBOX_AGENT_ID?.trim() ||
    env.SANDBOX_ROUTE_AGENT_ID?.trim() ||
    env.SANDBOX_SERVER_NAME?.trim() ||
    env.PARALLAX_SESSION_ID?.trim()
  );
}
