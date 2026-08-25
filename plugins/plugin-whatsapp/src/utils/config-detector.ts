/**
 * Resolves which transport a config selects: an explicit `authMethod` wins
 * (rejecting unknown values), otherwise presence of Baileys auth-dir fields
 * chooses Baileys and Cloud API credentials choose cloudapi. Used by ClientFactory.
 */
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

  // Cloud API credentials must be present and non-empty: an empty
  // accessToken/phoneNumberId would select cloudapi and then fail downstream
  // at auth time with a confusing error. Mirrors the authDir truthiness check
  // above (an empty authDir already falls through to the error below).
  if (
    (config as { accessToken?: unknown }).accessToken &&
    (config as { phoneNumberId?: unknown }).phoneNumberId
  ) {
    return "cloudapi";
  }

  throw new Error(
    "Cannot detect auth method. Provide either authDir (Baileys) or accessToken + phoneNumberId (Cloud API)."
  );
}
