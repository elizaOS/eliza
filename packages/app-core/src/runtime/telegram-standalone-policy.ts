import { lifeOpsPassiveConnectorsEnabled } from "@elizaos/core";

function isExplicitTrue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function shouldStartTelegramStandaloneBot(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (lifeOpsPassiveConnectorsEnabled(null, env)) {
    return false;
  }
  return isExplicitTrue(env.ELIZA_TELEGRAM_STANDALONE_BOT);
}
