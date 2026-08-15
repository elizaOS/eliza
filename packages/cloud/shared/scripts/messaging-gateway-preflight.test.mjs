/**
 * Exercises the real messaging gateway preflight process and its GitHub
 * workflow wiring with deterministic configuration; no credentials, network,
 * provider, or deployed gateway is used.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../../..");
const SCRIPT = path.join(
  REPOSITORY_ROOT,
  "packages/cloud/shared/scripts/messaging-gateway-preflight.mjs",
);
const WORKFLOW = path.join(REPOSITORY_ROOT, ".github/workflows/cloud-gateway-discord.yml");

const SHARED_ENV = {
  ELIZACLOUD_API_URL: "https://api.example.invalid",
  CEREBRAS_API_KEY: "contract-value",
  ELIZA_APP_WEBHOOK_GATEWAY_URL: "https://gateway.example.invalid",
  ELIZA_APP_WEBHOOK_GATEWAY_SECRET: "contract-value",
};

function runStrict(channels, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, "--strict", `--channels=${channels}`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
}

test("requires both halves of the shared webhook forwarding boundary", () => {
  for (const missingKey of ["ELIZA_APP_WEBHOOK_GATEWAY_URL", "ELIZA_APP_WEBHOOK_GATEWAY_SECRET"]) {
    const env = { ...SHARED_ENV };
    delete env[missingKey];
    const result = runStrict("shared", env);

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /\[fail\] shared: webhook gateway/);
    assert.match(result.stderr, /1 gateway preflight check\(s\) failed/);
  }
});

test("accepts every maintained webhook gateway URL alias", () => {
  for (const key of [
    "ELIZA_APP_WEBHOOK_GATEWAY_URL",
    "WEBHOOK_GATEWAY_URL",
    "GATEWAY_WEBHOOK_URL",
  ]) {
    const env = { ...SHARED_ENV };
    delete env.ELIZA_APP_WEBHOOK_GATEWAY_URL;
    env[key] = "https://gateway.example.invalid";
    const result = runStrict("shared", env);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /All gateway preflight checks passed/);
  }
});

test("channel scoping does not require unrelated connector credentials", () => {
  const result = runStrict("discord", {
    ELIZA_APP_DISCORD_APPLICATION_ID: "contract-value",
    ELIZA_APP_DISCORD_CLIENT_SECRET: "contract-value",
    ELIZA_APP_DISCORD_BOT_TOKEN: "contract-value",
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /telegram|whatsapp|imessage/i);
});

test("workflow separates fork-safe sentinels from trusted configuration", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /Run fork-safe messaging gateway preflight/);
  assert.match(workflow, /if: github\.event_name == 'pull_request'/);
  assert.match(workflow, /ELIZA_APP_WEBHOOK_GATEWAY_URL: https:\/\/gateway\.example\.invalid/);
  assert.match(workflow, /Enforce trusted messaging gateway configuration/);
  assert.match(workflow, /if: github\.event_name != 'pull_request'/);
  assert.match(
    workflow,
    /ELIZA_APP_WEBHOOK_GATEWAY_URL: \$\{\{ vars\.ELIZA_APP_WEBHOOK_GATEWAY_URL \}\}/,
  );
  assert.doesNotMatch(
    workflow,
    /ELIZA_APP_WEBHOOK_GATEWAY_URL: \$\{\{ secrets\.ELIZA_APP_WEBHOOK_GATEWAY_URL \}\}/,
  );
});
