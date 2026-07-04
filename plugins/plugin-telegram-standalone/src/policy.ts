import { lifeOpsPassiveConnectorsEnabled } from "@elizaos/core";

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
 * connectors are explicitly disabled AND `ELIZA_TELEGRAM_STANDALONE_BOT` is
 * truthy. In the default (passive-connectors-on) posture it never starts, so
 * the passive telegram connector owns the long-poll instead.
 */
export function shouldStartTelegramStandaloneBot(env: NodeJS.ProcessEnv = process.env): boolean {
  if (lifeOpsPassiveConnectorsEnabled(null, env)) {
    return false;
  }
  return isExplicitTrue(env.ELIZA_TELEGRAM_STANDALONE_BOT);
}
