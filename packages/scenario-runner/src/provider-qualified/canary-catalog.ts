/**
 * Defines the release-blocking provider canary inventory without importing
 * executable scenario modules. Catalog assembly and corpus coverage tests use
 * this ordered list as the repository-owned completeness authority.
 */

export const PROVIDER_CANARY_SCENARIO_IDS = [
  "provider.bluebubbles-imessage.confirmed-send",
  "provider.discord.confirmed-send",
  "provider.duffel-travel.booking",
  "provider.gmail.confirmed-send",
  "provider.google-calendar.create",
  "provider.google-sheets.create",
  "provider.signal.confirmed-send",
  "provider.slack.confirmed-send",
  "provider.telegram.confirmed-send",
  "provider.twilio-sms.confirmed-send",
  "provider.twilio-voice.confirmed-call",
  "provider.whatsapp.confirmed-send",
  "provider.x-dm.confirmed-send",
] as const;

export type ProviderCanaryScenarioId =
  (typeof PROVIDER_CANARY_SCENARIO_IDS)[number];
