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
import {
  missingWhatsAppCredentialRefs,
  WHATSAPP_CREDENTIAL_SETS,
} from "./messaging-gateway-preflight-contract.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../../..");
const SCRIPT = path.join(
  REPOSITORY_ROOT,
  "packages/cloud/shared/scripts/messaging-gateway-preflight.mjs",
);
const WORKFLOW = path.join(REPOSITORY_ROOT, ".github/workflows/cloud-gateway-discord.yml");
const DEVELOP_WORKFLOW = path.join(REPOSITORY_ROOT, ".github/workflows/develop-full.yml");

const SHARED_ENV = {
  ELIZACLOUD_API_URL: "https://api.example.invalid",
  CEREBRAS_API_KEY: "contract-value",
  ELIZA_APP_WEBHOOK_GATEWAY_URL: "https://gateway.example.invalid",
  ELIZA_APP_WEBHOOK_GATEWAY_SECRET: "contract-value",
  GATEWAY_INTERNAL_SECRET: "contract-value",
};

const SHARED_PRESENCE_ENV = {
  HAS_ELIZACLOUD_API_URL: "true",
  HAS_CEREBRAS_API_KEY: "true",
  HAS_ELIZA_APP_WEBHOOK_GATEWAY_URL: "true",
  HAS_ELIZA_APP_WEBHOOK_GATEWAY_SECRET: "true",
  HAS_GATEWAY_INTERNAL_SECRET: "true",
};

const TELEGRAM_PRESENCE_ENV = {
  HAS_ELIZA_APP_TELEGRAM_BOT_TOKEN: "true",
  HAS_ELIZA_APP_TELEGRAM_WEBHOOK_SECRET: "true",
};

const DISCORD_ENV = {
  ELIZA_APP_DISCORD_APPLICATION_ID: "contract-value",
  ELIZA_APP_DISCORD_BOT_ENABLED: "true",
  ELIZA_APP_DISCORD_BOT_TOKEN: "contract-value",
};

const DISCORD_PRESENCE_ENV = {
  HAS_ELIZA_APP_DISCORD_APPLICATION_ID: "true",
  ELIZA_APP_DISCORD_BOT_ENABLED: "true",
  HAS_ELIZA_APP_DISCORD_BOT_TOKEN: "true",
};

const WHATSAPP_CONTRACT_VALUE = "whatsapp-contract-value-never-print";

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

test("shared and Telegram checks accept exact names-only presence sentinels", () => {
  for (const [channel, env] of [
    ["shared", SHARED_PRESENCE_ENV],
    ["telegram", TELEGRAM_PRESENCE_ENV],
  ]) {
    const result = runStrict(channel, env);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /All gateway preflight checks passed/);
  }

  for (const invalid of ["false", "TRUE", "1", " true "]) {
    const result = runStrict("shared", {
      ...SHARED_PRESENCE_ENV,
      HAS_CEREBRAS_API_KEY: invalid,
    });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /\[fail\] shared: Cerebras onboarding model/);
  }
});

test("channel scoping does not require unrelated connector credentials", () => {
  const result = runStrict("discord", DISCORD_PRESENCE_ENV);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /telegram|whatsapp|imessage/i);
});

test("strict preflight rejects empty, unknown, and duplicate channel selectors", () => {
  for (const channels of [
    "",
    "discrod",
    "discord,unknown",
    "discord,,telegram",
    "discord,discord",
  ]) {
    const result = runStrict(channels, DISCORD_ENV);
    const output = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.status, 2, output);
    assert.match(result.stderr, /Invalid --channels selection/);
    assert.doesNotMatch(result.stdout, /All gateway preflight checks passed/);
    assert.doesNotMatch(output, /discrod|unknown/);
  }
});

test("Discord preflight accepts raw operator values or exact names-only presence sentinels", () => {
  for (const env of [DISCORD_ENV, DISCORD_PRESENCE_ENV]) {
    const result = runStrict("discord", env);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }

  for (const invalid of ["false", "TRUE", "1", " true "]) {
    const result = runStrict("discord", {
      ...DISCORD_PRESENCE_ENV,
      HAS_ELIZA_APP_DISCORD_BOT_TOKEN: invalid,
    });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(
      result.stdout,
      /\[fail\] discord: system bot token - Discord system bot token is not configured/,
    );
    assert.doesNotMatch(
      result.stdout,
      /\[fail\] discord: system bot token - Discord system bot token is configured/,
    );
  }
});

test("Discord shared ingress is distinct from human OAuth and generic bot aliases", () => {
  const result = runStrict("discord", {
    DISCORD_CLIENT_ID: "legacy-contract-value-never-print",
    DISCORD_CLIENT_SECRET: "legacy-contract-value-never-print",
    DISCORD_BOT_TOKEN: "legacy-contract-value-never-print",
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(
    result.stdout,
    /\[fail\] discord: system bot application id - Discord system bot application id is not configured/,
  );
  assert.match(
    result.stdout,
    /\[fail\] discord: system bot enabled - Discord system bot is not explicitly enabled/,
  );
  assert.match(
    result.stdout,
    /\[fail\] discord: system bot token - Discord system bot token is not configured/,
  );
  assert.doesNotMatch(result.stdout, /\[fail\].* is configured|\[fail\].* is explicitly enabled/);
  assert.doesNotMatch(output, /legacy-contract-value-never-print/);
});

test("Discord shared ingress requires the runtime's exact enabled value", () => {
  for (const invalid of ["false", "TRUE", "1", " true "]) {
    const result = runStrict("discord", {
      ...DISCORD_ENV,
      ELIZA_APP_DISCORD_BOT_ENABLED: invalid,
    });

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(
      result.stdout,
      /\[fail\] discord: system bot enabled - Discord system bot is not explicitly enabled/,
    );
    assert.doesNotMatch(
      result.stdout,
      /\[fail\] discord: system bot enabled - Discord system bot is explicitly enabled/,
    );
  }
});

test("WhatsApp readiness requires one complete authority across all 256 states", () => {
  const allNames = WHATSAPP_CREDENTIAL_SETS.flat();
  const combinations = 1 << allNames.length;

  for (let mask = 0; mask < combinations; mask += 1) {
    const env = Object.fromEntries(
      allNames
        .filter((_, index) => (mask & (1 << index)) !== 0)
        .map((name) => [name, WHATSAPP_CONTRACT_VALUE]),
    );
    const hasCompleteAuthority = WHATSAPP_CREDENTIAL_SETS.some((credentialSet) =>
      credentialSet.every((name) => Boolean(env[name])),
    );
    const missing = missingWhatsAppCredentialRefs(env);
    assert.equal(missing.length === 0, hasCompleteAuthority);
    assert.doesNotMatch(JSON.stringify(missing), /whatsapp-contract-value-never-print/);
  }
});

test("WhatsApp strict preflight wires complete and split authorities without leaking values", () => {
  for (const credentialSet of WHATSAPP_CREDENTIAL_SETS) {
    const env = Object.fromEntries(credentialSet.map((name) => [name, WHATSAPP_CONTRACT_VALUE]));
    const result = runStrict("whatsapp", env);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(result.stdout, /All gateway preflight checks passed/);
    assert.doesNotMatch(output, /whatsapp-contract-value-never-print/);
  }

  const splitEnv = Object.fromEntries(
    WHATSAPP_CREDENTIAL_SETS.flatMap((credentialSet, setIndex) =>
      credentialSet
        .filter((_, index) => index % 2 === setIndex)
        .map((name) => [name, WHATSAPP_CONTRACT_VALUE]),
    ),
  );
  const split = runStrict("whatsapp", splitEnv);
  const splitOutput = `${split.stdout}\n${split.stderr}`;
  assert.equal(split.status, 1, splitOutput);
  assert.match(split.stdout, /\[fail\] whatsapp: Meta credentials/);
  assert.doesNotMatch(splitOutput, /whatsapp-contract-value-never-print/);
});

test("reusable workflow keeps the develop caller source-test-only", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const developWorkflow = readFileSync(DEVELOP_WORKFLOW, "utf8");
  const testJobStart = workflow.indexOf("\n  test:");

  assert.notEqual(testJobStart, -1);

  const testJob = workflow.slice(testJobStart);

  assert.match(workflow, /on:\s+workflow_call:\s+concurrency:/);
  assert.doesNotMatch(
    workflow,
    /workflow_dispatch|pull_request|dispatch-admission|trusted-config|environment:\s+staging|secrets\./,
  );
  assert.match(developWorkflow, /on:\s+push:\s+branches: \[develop\]/);
  assert.match(
    developWorkflow,
    /cloud-gateway-discord:\s+[\s\S]*?uses: \.\/\.github\/workflows\/cloud-gateway-discord\.yml/,
  );
  assert.doesNotMatch(
    developWorkflow,
    /cloud-gateway-discord:\s+[\s\S]*?uses: \.\/\.github\/workflows\/cloud-gateway-discord\.yml\s+secrets: inherit/,
  );
  assert.doesNotMatch(testJob, /^\s{4}if:/m);
  assert.match(testJob, /^\s{4}runs-on:\s+ubuntu-24\.04$/m);
  assert.doesNotMatch(workflow, /HETZNER_FLEET_ONLINE|self-hosted|hetzner-robot/);
  assert.match(
    workflow,
    /name: Generate source keyword modules\s+working-directory: \.\s+run: bun run --cwd packages\/shared build:i18n/,
  );
  assert.match(
    workflow,
    /working-directory: packages\/cloud\/services\/gateway-discord\s+[\s\S]*?run: bun --conditions=eliza-source test tests\/ --timeout 60000/,
  );
  assert.match(
    workflow,
    /run: bun --conditions=eliza-source test src\/lib\/services\/gateway-discord\/__tests__ --timeout 60000/,
  );
  assert.doesNotMatch(workflow, /run: bun test tests\/ --timeout 60000/);
  assert.doesNotMatch(
    workflow,
    /run: bun test src\/lib\/services\/gateway-discord\/__tests__ --timeout 60000/,
  );
});
