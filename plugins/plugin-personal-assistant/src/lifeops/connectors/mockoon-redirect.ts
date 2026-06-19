/**
 * Mockoon redirect helper.
 *
 * When `LIFEOPS_USE_MOCKOON=1` is set in the environment, this module rewrites
 * every connector base URL the lifeops plugin reads to point at the matching
 * Mockoon environment on `http://localhost:<port>`.
 *
 * Port assignments are documented in
 * `eliza/test/mocks/mockoon/INVENTORY.md` and must stay in sync with the
 * generated environment files.
 *
 * The helper mutates `process.env` because every connector base-URL resolver
 * already reads from there. Callers must invoke `applyMockoonEnvOverrides()`
 * before any module that reads those env vars at import time. The lifeops
 * plugin's entry point calls it once, idempotently.
 *
 * Connectors with no existing env-var override (slack, discord, github,
 * notion, bluebubbles, apple-reminders, spotify) export a getter via
 * `getMockoonBaseUrl()`; tests that want to point those plugins at the mock
 * thread the URL through manually.
 */

const PORTS = {
  gmail: 18801,
  calendar: 18802,
  slack: 18803,
  discord: 18804,
  telegram: 18805,
  github: 18806,
  notion: 18807,
  twilio: 18808,
  plaid: 18809,
  "apple-reminders": 18810,
  bluebubbles: 18811,
  ntfy: 18812,
  duffel: 18813,
  anthropic: 18814,
  cerebras: 18815,
  "eliza-cloud": 18816,
  spotify: 18817,
  signal: 18818,
} as const satisfies Record<string, number>;

export type MockoonConnector = keyof typeof PORTS;

const HOST = "127.0.0.1";

export function isMockoonEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.LIFEOPS_USE_MOCKOON?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function getMockoonBaseUrl(connector: MockoonConnector): string {
  return `http://${HOST}:${PORTS[connector]}`;
}

/**
 * Set every env var that an existing lifeops/elizaOS connector base-URL
 * resolver consults. Idempotent.
 *
 * Returns the connectors whose URLs were applied so callers can log what
 * the test runtime is actually pointed at.
 */
export function applyMockoonEnvOverrides(
  env: NodeJS.ProcessEnv = process.env,
): MockoonConnector[] {
  if (!isMockoonEnabled(env)) return [];

  const applied: MockoonConnector[] = [];

  // Gmail + Calendar share `googleapis.com` and one env var hook in
  // `@elizaos/plugin-google`. Use the gmail port; if a test wants to isolate
  // calendar traffic it can override afterwards.
  if (!env.ELIZA_MOCK_GOOGLE_BASE) {
    env.ELIZA_MOCK_GOOGLE_BASE = `${getMockoonBaseUrl("gmail")}/`;
    applied.push("gmail", "calendar");
  }

  if (!env.ELIZA_MOCK_TWILIO_BASE) {
    env.ELIZA_MOCK_TWILIO_BASE = getMockoonBaseUrl("twilio");
    applied.push("twilio");
  }

  if (!env.NTFY_BASE_URL) {
    env.NTFY_BASE_URL = getMockoonBaseUrl("ntfy");
    applied.push("ntfy");
  }

  if (!env.ELIZAOS_CLOUD_BASE_URL) {
    env.ELIZAOS_CLOUD_BASE_URL = getMockoonBaseUrl("eliza-cloud");
    // eliza-cloud also covers plaid + paypal + schedule-sync via the relay.
    applied.push("eliza-cloud", "plaid");
  }

  if (!env.SIGNAL_HTTP_URL) {
    env.SIGNAL_HTTP_URL = getMockoonBaseUrl("signal");
    applied.push("signal");
  }

  if (!env.LIFEOPS_DUFFEL_API_BASE) {
    env.LIFEOPS_DUFFEL_API_BASE = getMockoonBaseUrl("duffel");
    applied.push("duffel");
  }

  if (!env.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = getMockoonBaseUrl("anthropic");
    applied.push("anthropic");
  }

  // Cerebras + OpenAI both speak the OpenAI completions surface.
  if (!env.OPENAI_BASE_URL) {
    env.OPENAI_BASE_URL = `${getMockoonBaseUrl("cerebras")}/v1`;
    applied.push("cerebras");
  }

  return applied;
}
