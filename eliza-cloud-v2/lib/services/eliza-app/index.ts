/**
 * Eliza App Services
 *
 * Authentication and user management services for the Eliza App.
 * Primary auth: Telegram OAuth + phone number for cross-platform messaging.
 */

export { telegramAuthService, type TelegramAuthData } from "./telegram-auth";
export {
  elizaAppSessionService,
  type ElizaAppSessionPayload,
  type SessionResult,
  type ValidatedSession,
} from "./session-service";
export {
  elizaAppUserService,
  type FindOrCreateResult,
} from "./user-service";
export { elizaAppConfig } from "./config";
