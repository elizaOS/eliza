import type { WhatsAppConfig } from "../types";

export function detectAuthMethod(
  config: WhatsAppConfig | Record<string, unknown>
): "baileys" | "cloudapi" {
  const explicitMethod = (config as { authMethod?: unknown }).authMethod;
  if (explicitMethod !== undefined) {
    if (explicitMethod === "baileys" || explicitMethod === "cloudapi") {
      return explicitMethod;
    }
    throw new Error(
      `Invalid authMethod: "${String(explicitMethod)}". Must be either "baileys" or "cloudapi".`
    );
  }

  if ("authDir" in config && config.authDir) {
    return "baileys";
  }

  if ("accessToken" in config && "phoneNumberId" in config) {
    return "cloudapi";
  }

  throw new Error(
    "Cannot detect auth method. Provide either authDir (Baileys) or accessToken + phoneNumberId (Cloud API)."
  );
}
