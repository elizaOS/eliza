/** Existing durable Discord install-welcome keyspace. */
export const DISCORD_WELCOME_PENDING =
  "discord:eliza-app:install-welcome:pending";
export const DISCORD_WELCOME_PROCESSING =
  "discord:eliza-app:install-welcome:processing";
export const DISCORD_WELCOME_DELIVERED =
  "discord:eliza-app:install-welcome:delivered:";
export class DiscordWelcomeStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordWelcomeStateError";
  }
}
