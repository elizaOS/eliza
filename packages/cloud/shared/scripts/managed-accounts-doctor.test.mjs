/**
 * Exercises the real managed-accounts doctor process end to end with
 * deterministic environments; no credentials, network, or provider account is
 * used. Spawns the current bun runtime because the CLI imports the TypeScript
 * manifest directly.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const SCRIPT = path.join(import.meta.dirname, "managed-accounts-doctor.mjs");

const REQUIRED_ENV = {
  GOOGLE_CLIENT_ID: "contract-value",
  GOOGLE_CLIENT_SECRET: "contract-value",
  TELEGRAM_BOT_TOKEN: "contract-value",
  TELEGRAM_WEBHOOK_SECRET: "contract-value",
  DISCORD_CLIENT_ID: "contract-value",
  DISCORD_CLIENT_SECRET: "contract-value",
  DISCORD_BOT_TOKEN: "contract-value",
};

function run(cliArgs, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...cliArgs], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
}

test("strict mode fails closed when required accounts are unprovisioned", () => {
  const result = run(["--strict"]);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /required managed account\(s\) not configured/);
  assert.match(result.stderr, /google/);
});

test("strict mode passes once every required account has one complete credential set", () => {
  const result = run(["--strict"], REQUIRED_ENV);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[configured\] Google/);
  assert.match(result.stdout, /\[configured\] Telegram/);
  assert.match(result.stdout, /\[configured\] Discord/);
});

test("report mode surfaces missing reference names but never fails", () => {
  const result = run([]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /missing: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET/);
  assert.match(result.stdout, /Re-run with --strict in CI to fail closed/);
});

test("json mode emits the machine-readable report without secret values", () => {
  const result = run(["--json"], { TELEGRAM_BOT_TOKEN: "secret-token-value" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed.reports));
  assert.ok(parsed.requiredMissingIds.includes("google"));
  assert.doesNotMatch(result.stdout, /secret-token-value/);
});

test("category filtering scopes the report and rejects unknown categories", () => {
  const scoped = run(["--category=social_communications"]);
  assert.equal(scoped.status, 0, `${scoped.stdout}\n${scoped.stderr}`);
  assert.doesNotMatch(scoped.stdout, /Google \(foundation/);
  assert.match(scoped.stdout, /Telegram/);

  const unknown = run(["--category=nonsense"]);
  assert.equal(unknown.status, 2);
});

test("placeholder credential values do not count as provisioned", () => {
  const result = run(["--strict"], {
    ...REQUIRED_ENV,
    TELEGRAM_BOT_TOKEN: "your_telegram_bot_token_placeholder",
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /telegram/);
});
