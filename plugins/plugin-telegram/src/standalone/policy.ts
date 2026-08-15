/**
 * Selects the opt-in standalone Telegram poller from the resolved runtime
 * plugin set and explicit deployment settings.
 */
import {
  type IAgentRuntime,
  lifeOpsPassiveConnectorsEnabled,
} from "@elizaos/core";

function isExplicitTrue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * The standalone Telegram bot is an opt-in alternative to the full
 * `@elizaos/plugin-telegram` connector: it only runs when LifeOps passive
 * `ELIZA_TELEGRAM_STANDALONE_BOT` is truthy and LifeOps passive mode is not
 * active. Explicit passive-connector settings retain precedence.
 */
export function shouldStartTelegramStandaloneBot(
  env: NodeJS.ProcessEnv = process.env,
  runtime?: Pick<IAgentRuntime, "getSetting" | "plugins">,
): boolean {
  if (lifeOpsPassiveConnectorsEnabled(runtime, env)) {
    return false;
  }
  return isExplicitTrue(env.ELIZA_TELEGRAM_STANDALONE_BOT);
}
