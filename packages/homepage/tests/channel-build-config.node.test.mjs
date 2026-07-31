/**
 * Verifies that deployment requires every public channel identifier while
 * ordinary CI and local homepage builds remain configuration-independent.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
  new URL("../scripts/verify-channel-build-config.mjs", import.meta.url),
);
const requiredNames = [
  "VITE_TELEGRAM_BOT_ID",
  "VITE_TELEGRAM_BOT_USERNAME",
  "VITE_DISCORD_CLIENT_ID",
  "VITE_WHATSAPP_PHONE_NUMBER",
];

function runGuard(overrides = {}) {
  const env = { ...process.env };
  delete env.ELIZA_REQUIRE_CHANNEL_CONFIG;
  for (const name of requiredNames) delete env[name];
  Object.assign(env, overrides);
  return spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env,
  });
}

test("generic CI does not require deployment identifiers", () => {
  const result = runGuard({ CI: "true" });
  assert.equal(result.status, 0, result.stderr);
});

test("deployment lists every missing identifier", () => {
  const result = runGuard({ ELIZA_REQUIRE_CHANNEL_CONFIG: "1" });
  assert.equal(result.status, 1);
  for (const name of requiredNames)
    assert.match(result.stderr, new RegExp(name));
});

test("deployment accepts a complete configuration", () => {
  const result = runGuard({
    ELIZA_REQUIRE_CHANNEL_CONFIG: "1",
    VITE_TELEGRAM_BOT_ID: "1001",
    VITE_TELEGRAM_BOT_USERNAME: "eliza_bot",
    VITE_DISCORD_CLIENT_ID: "2002",
    VITE_WHATSAPP_PHONE_NUMBER: "15555550123",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("whitespace-only identifiers are missing", () => {
  const result = runGuard({
    ELIZA_REQUIRE_CHANNEL_CONFIG: "1",
    VITE_TELEGRAM_BOT_ID: "1001",
    VITE_TELEGRAM_BOT_USERNAME: " ",
    VITE_DISCORD_CLIENT_ID: "2002",
    VITE_WHATSAPP_PHONE_NUMBER: "15555550123",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /VITE_TELEGRAM_BOT_USERNAME/);
});
