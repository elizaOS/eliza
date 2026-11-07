export const DISCORD_LEASE_DELETE =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0';
export const DISCORD_LEASE_EXPIRE =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], tonumber(ARGV[2])) end return 0';
export const DISCORD_DEFAULT_LEADER = "discord:eliza-app-bot:leader";
export function isDiscordCoordinationKey(
  key: unknown,
  leaderKey = DISCORD_DEFAULT_LEADER,
): key is string {
  return (
    typeof key === "string" &&
    (key === leaderKey ||
      key === "discord:active_pods" ||
      key === "discord:eliza-app-bot:dm-channels" ||
      [
        "discord:pod:",
        "discord:session:",
        "discord:failover:lock:",
        "discord:eliza-app-bot:dm-state:",
        "discord:eliza-app-bot:dm-message:",
      ].some((prefix) => key.startsWith(prefix) && key.length > prefix.length))
  );
}
export class DiscordCoordinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordCoordinationError";
  }
}
