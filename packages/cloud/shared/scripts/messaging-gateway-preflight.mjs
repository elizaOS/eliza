#!/usr/bin/env node

/**
 * Validates channel-scoped messaging gateway configuration at operator and CI
 * boundaries. Strict mode exits non-zero when a selected channel is missing a
 * required value; callers decide whether values are real deployment settings
 * or deterministic contract sentinels.
 */

import { missingWhatsAppCredentialRefs } from "./messaging-gateway-preflight-contract.mjs";

const cliArgs = process.argv.slice(2);
const args = new Set(cliArgs);
const strict = args.has("--strict");
const supportedChannels = ["shared", "telegram", "discord", "whatsapp", "imessage"];
const supportedChannelSet = new Set(supportedChannels);
const channelArgs = cliArgs.filter((arg) => arg.startsWith("--channels="));
const requestedChannels =
  channelArgs.length === 0
    ? supportedChannels
    : channelArgs[0]
        .slice("--channels=".length)
        .split(",")
        .map((channel) => channel.trim());
const selectedChannels = new Set(requestedChannels);
const invalidChannelSelection =
  channelArgs.length > 1 ||
  requestedChannels.length === 0 ||
  requestedChannels.some((channel) => !supportedChannelSet.has(channel)) ||
  selectedChannels.size !== requestedChannels.length;

if (invalidChannelSelection) {
  console.error(
    `Invalid --channels selection. Use a non-empty comma-separated subset of: ${supportedChannels.join(", ")}. Each channel may appear once.`,
  );
  process.exit(2);
}

const checks = [];

function addCheck(channel, name, ok, detail, fix = "") {
  checks.push({ channel, name, ok: Boolean(ok), detail, fix });
}

function hasAny(names) {
  return names.some((name) => Boolean(process.env[name]?.trim()));
}

function hasConfiguredValue(valueNames, presenceName) {
  return hasAny(valueNames) || process.env[presenceName] === "true";
}

function checkTelegram() {
  addCheck(
    "telegram",
    "bot token",
    hasConfiguredValue(
      ["ELIZA_APP_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN"],
      "HAS_ELIZA_APP_TELEGRAM_BOT_TOKEN",
    ),
    "Telegram bot token is configured",
    "Create a bot with BotFather and set ELIZA_APP_TELEGRAM_BOT_TOKEN.",
  );
  addCheck(
    "telegram",
    "webhook secret",
    hasConfiguredValue(
      ["TELEGRAM_WEBHOOK_SECRET", "ELIZA_APP_TELEGRAM_WEBHOOK_SECRET"],
      "HAS_ELIZA_APP_TELEGRAM_WEBHOOK_SECRET",
    ),
    "Telegram webhook secret is configured",
    "Set a per-environment secret and configure it as x-telegram-bot-api-secret-token.",
  );
}

function checkDiscord() {
  const systemBotApplicationIdConfigured = hasConfiguredValue(
    ["ELIZA_APP_DISCORD_APPLICATION_ID"],
    "HAS_ELIZA_APP_DISCORD_APPLICATION_ID",
  );
  const systemBotEnabled = process.env.ELIZA_APP_DISCORD_BOT_ENABLED === "true";
  const systemBotTokenConfigured = hasConfiguredValue(
    ["ELIZA_APP_DISCORD_BOT_TOKEN"],
    "HAS_ELIZA_APP_DISCORD_BOT_TOKEN",
  );

  addCheck(
    "discord",
    "system bot application id",
    systemBotApplicationIdConfigured,
    systemBotApplicationIdConfigured
      ? "Discord system bot application id is configured"
      : "Discord system bot application id is not configured",
    "Set ELIZA_APP_DISCORD_APPLICATION_ID for the maintained Eliza App bot.",
  );
  addCheck(
    "discord",
    "system bot enabled",
    systemBotEnabled,
    systemBotEnabled
      ? "Discord system bot is explicitly enabled"
      : "Discord system bot is not explicitly enabled",
    "Set ELIZA_APP_DISCORD_BOT_ENABLED to exactly true.",
  );
  addCheck(
    "discord",
    "system bot token",
    systemBotTokenConfigured,
    systemBotTokenConfigured
      ? "Discord system bot token is configured"
      : "Discord system bot token is not configured",
    "Set ELIZA_APP_DISCORD_BOT_TOKEN for the maintained Eliza App bot.",
  );
}

function checkWhatsApp() {
  const missingWhatsapp = missingWhatsAppCredentialRefs(process.env);
  addCheck(
    "whatsapp",
    "Meta credentials",
    missingWhatsapp.length === 0,
    "WhatsApp Business Platform credentials are configured",
    `Missing from nearest complete set: ${missingWhatsapp.join(", ")}`,
  );
}

function checkIMessage() {
  addCheck(
    "imessage",
    "BlueBubbles relay URL",
    hasAny([
      "BLUEBUBBLES_RELAY_URL",
      "IMESSAGE_RELAY_URL",
      "ELIZA_APP_BLOOIO_API_URL",
      "ELIZA_APP_BLOOIO_API_KEY",
    ]),
    "BlueBubbles relay URL or hosted Blooio API key is configured",
    "Register the Mac relay and set BLUEBUBBLES_RELAY_URL, or configure ELIZA_APP_BLOOIO_API_KEY for the hosted iMessage bridge.",
  );
  addCheck(
    "imessage",
    "relay signing secret",
    hasAny([
      "BLUEBUBBLES_RELAY_SIGNING_SECRET",
      "IMESSAGE_RELAY_SIGNING_SECRET",
      "ELIZA_APP_BLOOIO_API_KEY",
    ]),
    "BlueBubbles relay signing secret is configured",
    "Generate a relay signing secret and store only the hash/server secret in cloud.",
  );
  addCheck(
    "imessage",
    "Headscale gateway tag",
    hasAny(["HEADSCALE_IMESSAGE_GATEWAY_TAG"]),
    "Headscale iMessage gateway tag is configured",
    "Use a dedicated tag such as tag:imessage-gateway and restrict ACLs to the gateway/proxy service.",
  );
}

function checkShared() {
  addCheck(
    "shared",
    "cloud API base",
    hasConfiguredValue(
      ["ELIZACLOUD_API_URL", "ELIZA_CLOUD_API_URL", "ELIZA_CLOUD_URL", "PUBLIC_API_BASE_URL"],
      "HAS_ELIZACLOUD_API_URL",
    ),
    "Cloud API base URL is configured",
    "Set the production Cloud API base URL used by gateway services.",
  );
  addCheck(
    "shared",
    "Cerebras onboarding model",
    hasConfiguredValue(["CEREBRAS_API_KEY"], "HAS_CEREBRAS_API_KEY"),
    "Cerebras API key is configured",
    "Set CEREBRAS_API_KEY for the stateless onboarding worker.",
  );
  // The BFF forwarder in packages/cloud/api/eliza-app/webhook/_forward.ts reads
  // these as a pair: the URL is the upstream webhook gateway it proxies to, and
  // the secret is the shared "came from the BFF" proof the gateway validates
  // (x-eliza-webhook-forwarder-secret). _forward.ts only stamps the header when
  // the secret is set, so an absent secret silently downgrades the gateway's
  // trust boundary — surface that here rather than at deploy time.
  addCheck(
    "shared",
    "webhook gateway URL",
    hasConfiguredValue(
      ["ELIZA_APP_WEBHOOK_GATEWAY_URL", "WEBHOOK_GATEWAY_URL", "GATEWAY_WEBHOOK_URL"],
      "HAS_ELIZA_APP_WEBHOOK_GATEWAY_URL",
    ),
    "Webhook gateway upstream URL is configured",
    "Set ELIZA_APP_WEBHOOK_GATEWAY_URL (or WEBHOOK_GATEWAY_URL / GATEWAY_WEBHOOK_URL) to the gateway-webhook service URL.",
  );
  addCheck(
    "shared",
    "webhook gateway forwarder secret",
    hasConfiguredValue(
      ["ELIZA_APP_WEBHOOK_GATEWAY_SECRET"],
      "HAS_ELIZA_APP_WEBHOOK_GATEWAY_SECRET",
    ),
    "Webhook gateway forwarder secret is configured",
    "Set ELIZA_APP_WEBHOOK_GATEWAY_SECRET to the shared BFF→gateway trust secret.",
  );
  addCheck(
    "shared",
    "internal delivery secret",
    hasConfiguredValue(["GATEWAY_INTERNAL_SECRET"], "HAS_GATEWAY_INTERNAL_SECRET"),
    "Internal reminder delivery secret is configured",
    "Set GATEWAY_INTERNAL_SECRET consistently on the Cloud Worker and messaging gateways.",
  );
}

if (selectedChannels.has("shared")) checkShared();
if (selectedChannels.has("telegram")) checkTelegram();
if (selectedChannels.has("discord")) checkDiscord();
if (selectedChannels.has("whatsapp")) checkWhatsApp();
if (selectedChannels.has("imessage")) checkIMessage();

console.log("Eliza messaging gateway preflight");
console.log(`Channels: ${[...selectedChannels].join(", ")}`);
for (const check of checks) {
  const mark = check.ok ? "ok" : strict ? "fail" : "missing";
  console.log(`- [${mark}] ${check.channel}: ${check.name} - ${check.detail}`);
  if (!check.ok && check.fix) {
    console.log(`  fix: ${check.fix}`);
  }
}

const failed = checks.filter((check) => !check.ok);
if (strict && failed.length > 0) {
  console.error(`\n${failed.length} gateway preflight check(s) failed.`);
  process.exit(1);
}

if (failed.length > 0) {
  console.log(`\n${failed.length} check(s) missing. Re-run with --strict in CI to fail closed.`);
} else {
  console.log("\nAll gateway preflight checks passed.");
}
