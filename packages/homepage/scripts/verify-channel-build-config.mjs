#!/usr/bin/env node
/**
 * Fails the homepage build when a channel identifier is missing.
 *
 * Vite inlines `import.meta.env` at build time, so an unset variable does not
 * fail — it bakes an empty string into the bundle and the site ships silently
 * broken provider buttons: "Telegram not configured", Discord OAuth bouncing
 * back to method selection, WhatsApp falling back to the SMS number. #17336
 * was closed for exactly that. The CI workflow guards this too; running it
 * from `prebuild` means a local or Pages-side build cannot bypass the check
 * either.
 *
 * Skipped outside CI unless ELIZA_REQUIRE_CHANNEL_CONFIG=1, so day-to-day
 * local development is unaffected.
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

const enforced =
  process.env.ELIZA_REQUIRE_CHANNEL_CONFIG === "1" || process.env.CI === "true";

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
