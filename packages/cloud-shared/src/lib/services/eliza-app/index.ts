/**
 * Eliza App Services
 *
 * Authentication and user management services for the Eliza App.
 * Auth methods: Telegram OAuth, Discord OAuth2, and iMessage (auto-provision).
 */

export { elizaAppConfig } from "./config";
export {
  connectionEnforcementService,
  detectProviderFromMessage,
  type MessagingPlatform,
  NUDGE_INTERVAL,
  type NudgeParams,
  REQUIRED_PLATFORMS,
  type RequiredPlatform,
} from "./connection-enforcement";
export { type DiscordUserData, discordAuthService } from "./discord-auth";
export {
  type ElizaAppSessionPayload,
  elizaAppSessionService,
  type SessionResult,
  type ValidatedSession,
} from "./session-service";
export { type TelegramAuthData, telegramAuthService } from "./telegram-auth";
export { elizaAppUserService, type FindOrCreateResult } from "./user-service";
export { whatsAppAuthService } from "./whatsapp-auth";
