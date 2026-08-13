/**
 * Validates the operator-configured watchdog for deferred plugin registration.
 */

const DEFAULT_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DECIMAL_INTEGER = /^\d+$/;

export function parseDeferredPluginRegistrationTimeoutMs(
  raw: string | undefined,
): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS;

  if (!DECIMAL_INTEGER.test(value)) {
    throw new Error(
      `ELIZA_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS must be a positive decimal integer no greater than ${MAX_TIMER_DELAY_MS}; received ${JSON.stringify(raw)}`,
    );
  }

  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(
      `ELIZA_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS must be a positive decimal integer no greater than ${MAX_TIMER_DELAY_MS}; received ${JSON.stringify(raw)}`,
    );
  }

  return parsed;
}
