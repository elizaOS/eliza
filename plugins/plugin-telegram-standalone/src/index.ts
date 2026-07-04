import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { TelegramStandaloneService } from "./service";

export const TELEGRAM_STANDALONE_PLUGIN_NAME = "@elizaos/plugin-telegram-standalone";

/**
 * Opt-in standalone Telegram polling bot.
 *
 * This plugin is loaded only when the standalone gate is set
 * (`ELIZA_TELEGRAM_STANDALONE_BOT` with LifeOps passive connectors disabled);
 * see `telegramStandaloneRequested` in the agent plugin collector. It exposes a
 * single runtime Service that owns the Telegraf long-poll lifecycle, replacing
 * the connector that used to be inlined in the app-core boot orchestrator.
 */
const telegramStandalonePlugin: Plugin = {
  name: TELEGRAM_STANDALONE_PLUGIN_NAME,
  description: "Opt-in standalone Telegram polling bot (gate ELIZA_TELEGRAM_STANDALONE_BOT).",
  services: [TelegramStandaloneService],
  async dispose(runtime: IAgentRuntime) {
    await TelegramStandaloneService.stop(runtime);
  },
};

export type { TelegramStandaloneContext } from "./handler";
export { handleTelegramStandaloneMessage } from "./handler";
export { shouldStartTelegramStandaloneBot } from "./policy";
export {
  TELEGRAM_STANDALONE_SERVICE_NAME,
  TelegramStandaloneService,
} from "./service";
export default telegramStandalonePlugin;
