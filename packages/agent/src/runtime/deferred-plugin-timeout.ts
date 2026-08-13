/**
 * Validates the operator-configured watchdog for deferred plugin registration.
 */

import { ElizaError } from "@elizaos/core";

const DEFAULT_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DECIMAL_INTEGER = /^\d+$/;
const SETTING_NAME = "ELIZA_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS";

function invalidDeferredPluginRegistrationTimeout(raw: string): ElizaError {
  return new ElizaError(
    `${SETTING_NAME} must be a positive decimal integer no greater than ${MAX_TIMER_DELAY_MS}`,
    {
      code: "DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_INVALID",
      context: {
        setting: SETTING_NAME,
        received: raw,
        minimum: 1,
        maximum: MAX_TIMER_DELAY_MS,
      },
      severity: "fatal",
    },
  );
}

export function parseDeferredPluginRegistrationTimeoutMs(
  raw: string | undefined,
): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS;

  if (!DECIMAL_INTEGER.test(value)) {
    throw invalidDeferredPluginRegistrationTimeout(raw ?? value);
  }

  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_TIMER_DELAY_MS
  ) {
    throw invalidDeferredPluginRegistrationTimeout(raw ?? value);
  }

  return parsed;
}
