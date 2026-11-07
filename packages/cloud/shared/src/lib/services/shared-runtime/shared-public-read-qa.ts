/** Matches a deployer-owned QA selector; this grants no tools, capture, or spending. */
export function matchesTypedPublicReadQaPolicy(
  raw: string | undefined,
  scope: {
    organizationId: string;
    userId: string;
    agentId: string;
    roomKey: string;
    channelSource: "blooio";
  },
): boolean {
  if (!raw || raw.length > 4096) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // error-policy:J3 Invalid server configuration keeps this rollout off.
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const policy = parsed as Record<string, unknown>;
  const keys = ["version", "organizationId", "userId", "agentId", "roomKey", "channelSource"];
  return (
    Object.keys(policy).length === keys.length &&
    keys.every((key) => Object.hasOwn(policy, key)) &&
    keys.slice(1).every((key) => {
      const value = policy[key];
      return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 128 &&
        value.trim() === value
      );
    }) &&
    policy.version === 1 &&
    policy.channelSource === "blooio" &&
    policy.organizationId === scope.organizationId &&
    policy.userId === scope.userId &&
    policy.agentId === scope.agentId &&
    policy.roomKey === scope.roomKey &&
    policy.channelSource === scope.channelSource
  );
}
