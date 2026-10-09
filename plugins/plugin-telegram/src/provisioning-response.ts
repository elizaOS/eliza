import { ElizaError } from "@elizaos/core";

/** Parse provisioning responses without exposing an untrusted response body. */
export function parseProvisioningBody(text: string): unknown {
  if (text.includes("Sorry, too many tries")) {
    throw new ElizaError("Telegram provisioning is rate limited right now", {
      code: "TELEGRAM_PROVISIONING_RATE_LIMITED",
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ElizaError("Telegram provisioning returned a non-JSON response", {
      code: "TELEGRAM_PROVISIONING_RESPONSE_INVALID",
    });
  }
}
