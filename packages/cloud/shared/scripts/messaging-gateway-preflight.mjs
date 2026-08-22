#!/usr/bin/env node

/**
 * Validates channel-scoped messaging gateway configuration at operator and CI
 * boundaries. Strict mode exits non-zero when a selected channel is missing a
 * required value; callers decide whether values are real deployment settings
 * or deterministic contract sentinels.
 */

const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");
const channelsArg = process.argv.find((arg) => arg.startsWith("--channels="));
const selectedChannels = new Set(
  (channelsArg?.split("=")[1] ?? "shared,telegram,discord,whatsapp,imessage")
    .split(",")
    .map((channel) => channel.trim())
    .filter(Boolean),
);

const checks = [];

function addCheck(channel, name, ok, detail, fix = "") {
  checks.push({ channel, name, ok: Boolean(ok), detail, fix });
}

function optionNames(option) {
  return Array.isArray(option) ? option : [option];
}

function hasAny(names) {
  return names.some((option) =>
    optionNames(option).some((name) => Boolean(process.env[name]?.trim())),
  );
}

function missing(names) {
  return names
    .filter((option) => optionNames(option).every((name) => !process.env[name]?.trim()))
    .map((option) => optionNames(option).join(" or "));
}

function checkTelegram() {
  addCheck(
    "telegram",
    "bot token",
    hasAny(["ELIZA_APP_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN"]),
    "Telegram bot token is configured",
    "Create a bot with BotFather and set ELIZA_APP_TELEGRAM_BOT_TOKEN.",
  );
  addCheck(
    "telegram",
    "webhook secret",
    hasAny(["TELEGRAM_WEBHOOK_SECRET", "ELIZA_APP_TELEGRAM_WEBHOOK_SECRET"]),
    "Telegram webhook secret is configured",
    "Set a per-environment secret and configure it as x-telegram-bot-api-secret-token.",
  );
}

function checkDiscord() {
  const missingDiscord = missing([
    ["DISCORD_CLIENT_ID", "ELIZA_APP_DISCORD_APPLICATION_ID"],
    ["DISCORD_CLIENT_SECRET", "ELIZA_APP_DISCORD_CLIENT_SECRET"],
  ]);
  addCheck(
    "discord",
    "application credentials",
    missingDiscord.length === 0,
    "Discord OAuth client id/secret are configured",
    `Missing: ${missingDiscord.join(", ")}`,
  );
  addCheck(
    "discord",
    "bot token",
    hasAny(["DISCORD_BOT_TOKEN", "ELIZA_APP_DISCORD_BOT_TOKEN"]),
    "Discord system bot token is configured",
    "Set DISCORD_BOT_TOKEN for the managed Eliza App bot gateway.",
  );
}

function checkWhatsApp() {
  const missingWhatsapp = missing([
    ["WHATSAPP_ACCESS_TOKEN", "ELIZA_APP_WHATSAPP_ACCESS_TOKEN"],
    ["WHATSAPP_PHONE_NUMBER_ID", "ELIZA_APP_WHATSAPP_PHONE_NUMBER_ID"],
    ["WHATSAPP_APP_SECRET", "ELIZA_APP_WHATSAPP_APP_SECRET"],
    ["WHATSAPP_VERIFY_TOKEN", "ELIZA_APP_WHATSAPP_VERIFY_TOKEN"],
  ]);
  addCheck(
    "whatsapp",
    "Meta credentials",
    missingWhatsapp.length === 0,
    "WhatsApp Business Platform credentials are configured",
    `Missing: ${missingWhatsapp.join(", ")}`,
  );
}

function checkIMessage() {
  addCheck(
    "imessage",
    "Blooio API key",
    hasAny(["ELIZA_APP_BLOOIO_API_KEY"]),
    "Hosted Blooio API key is configured",
    "Set ELIZA_APP_BLOOIO_API_KEY for authenticated hosted iMessage delivery.",
  );
  addCheck(
    "imessage",
    "Blooio webhook signing secret",
    hasAny(["ELIZA_APP_BLOOIO_WEBHOOK_SECRET", "BLOOIO_WEBHOOK_SECRET"]),
    "Hosted Blooio webhook signing secret is configured",
    "Set ELIZA_APP_BLOOIO_WEBHOOK_SECRET (or BLOOIO_WEBHOOK_SECRET) for signed iMessage ingress.",
  );
}

function checkShared() {
  addCheck(
    "shared",
    "cloud API base",
    hasAny(["ELIZACLOUD_API_URL", "ELIZA_CLOUD_API_URL", "ELIZA_CLOUD_URL", "PUBLIC_API_BASE_URL"]),
    "Cloud API base URL is configured",
    "Set the production Cloud API base URL used by gateway services.",
  );
  addCheck(
    "shared",
    "Cerebras onboarding model",
    hasAny(["CEREBRAS_API_KEY"]),
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
    hasAny(["ELIZA_APP_WEBHOOK_GATEWAY_URL", "WEBHOOK_GATEWAY_URL", "GATEWAY_WEBHOOK_URL"]),
    "Webhook gateway upstream URL is configured",
    "Set ELIZA_APP_WEBHOOK_GATEWAY_URL (or WEBHOOK_GATEWAY_URL / GATEWAY_WEBHOOK_URL) to the gateway-webhook service URL.",
  );
  addCheck(
    "shared",
    "webhook gateway forwarder secret",
    hasAny(["ELIZA_APP_WEBHOOK_GATEWAY_SECRET"]),
    "Webhook gateway forwarder secret is configured",
    "Set ELIZA_APP_WEBHOOK_GATEWAY_SECRET to the shared BFF→gateway trust secret.",
  );
  addCheck(
    "shared",
    "internal delivery secret",
    hasAny(["GATEWAY_INTERNAL_SECRET"]),
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
