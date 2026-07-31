#!/usr/bin/env node
/**
 * Enforces the public channel identifiers required by a deployable homepage bundle.
 * Deployment opts into the guard explicitly so generic CI and local builds can
 * compile the site without production provider configuration.
 */

const REQUIRED = [
  ["VITE_TELEGRAM_BOT_ID", "Telegram OAuth (get-started login)"],
  ["VITE_TELEGRAM_BOT_USERNAME", "Telegram Login Widget (data-telegram-login)"],
  ["VITE_DISCORD_CLIENT_ID", "Discord OAuth (get-started + connected)"],
  [
    "VITE_WHATSAPP_PHONE_NUMBER",
    "WhatsApp deep link (falls back to the SMS number)",
  ],
];

const enforced = process.env.ELIZA_REQUIRE_CHANNEL_CONFIG === "1";

if (!enforced) {
  process.exit(0);
}

const missing = REQUIRED.filter(([name]) => !process.env[name]?.trim());

if (missing.length > 0) {
  console.error("Missing channel build configuration:\n");
  for (const [name, purpose] of missing) {
    console.error(`  ${name}  —  ${purpose}`);
  }
  console.error(
    "\nVite inlines these at build time, so an unset value ships a bundle with" +
      "\nnon-functional channel buttons rather than failing. They are public" +
      "\nidentifiers, not secrets — the bundle exposes them either way." +
      "\nSet them as repository variables (Settings -> Actions -> Variables).\n",
  );
  process.exit(1);
}

console.log(
  `Channel build configuration present (${REQUIRED.length}/${REQUIRED.length}).`,
);
