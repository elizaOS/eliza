/** Existing durable Discord install-welcome keyspace. */
export const DISCORD_WELCOME_PENDING =
  "discord:eliza-app:install-welcome:pending";
export const DISCORD_WELCOME_PROCESSING =
  "discord:eliza-app:install-welcome:processing";
export const DISCORD_WELCOME_DELIVERED =
  "discord:eliza-app:install-welcome:delivered:";
export const DISCORD_WELCOME_REQUEUE_HEADER = "x-eliza-discord-welcome-requeue";

/** Replace one exact processing member with its pending retry. */
export const DISCORD_WELCOME_REQUEUE = `
if not redis.call('LPOS', KEYS[1], ARGV[1]) then return 0 end
redis.call('LPUSH', KEYS[2], ARGV[2])
return redis.call('LREM', KEYS[1], 1, ARGV[1])
`;

export class DiscordWelcomeStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordWelcomeStateError";
  }
}
