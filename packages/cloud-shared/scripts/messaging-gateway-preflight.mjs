#!/usr/bin/env node

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
