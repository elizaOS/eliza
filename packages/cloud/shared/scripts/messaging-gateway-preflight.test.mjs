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
import { parseDocument } from "yaml";
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
const CONFIGURATION_CONTEXT_IDENTIFIER =
  /(^|[^A-Za-z0-9_])(secrets|vars|inputs)(?=$|[^A-Za-z0-9_])/i;
const GITHUB_EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const EXPECTED_SOURCE_ONLY_WORKFLOW = {
  name: "Cloud Gateway Discord",
  on: { workflow_call: null },
  concurrency: {
    group: "cloud-gateway-discord-${{ github.ref }}",
    "cancel-in-progress": true,
  },
  defaults: {
    run: {
      "working-directory": "packages/cloud/shared",
    },
  },
  env: {
    BUN_VERSION: "1.3.14",
  },
  permissions: {
    contents: "read",
  },
  jobs: {
    test: {
      name: "Test",
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 10,
      steps: [
        {
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          with: {
            "persist-credentials": false,
          },
        },
        {
          uses: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
          with: {
            "bun-version": "${{ env.BUN_VERSION }}",
          },
        },
        {
          name: "Install root dependencies",
          run: "bun install --frozen-lockfile --no-save && git diff --exit-code -- bun.lock",
        },
        {
          name: "Verify source-only workflow contract",
          "working-directory": ".",
          run: "bun test packages/cloud/shared/scripts/messaging-gateway-preflight.test.mjs",
        },
        {
          name: "Generate source keyword modules",
          "working-directory": ".",
          run: "bun run --cwd packages/shared build:i18n",
        },
        {
          name: "Run service tests",
          "working-directory": "packages/cloud/services/gateway-discord",
          run: "bun --conditions=eliza-source test tests/ --timeout 60000",
          env: {
            SKIP_SERVER_CHECK: "true",
          },
        },
        {
          name: "Run lib tests",
          run: "bun --conditions=eliza-source test src/lib/services/gateway-discord/__tests__ --timeout 60000",
          env: {
            SKIP_SERVER_CHECK: "true",
          },
        },
      ],
    },
  },
};
const EXPECTED_DEVELOP_CALLER = {
  needs: "plan",
  if: "needs.plan.outputs.run_cloud_gateway_discord == 'true'",
  uses: "./.github/workflows/cloud-gateway-discord.yml",
};

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireMapping(value, label) {
  assert.ok(isMapping(value), `${label} must be a YAML mapping`);
  return value;
}

function parseWorkflow(source, label) {
  const document = parseDocument(source, { merge: true, uniqueKeys: true });

  assert.equal(
    document.errors.length,
    0,
    `${label} must be valid YAML: ${document.errors.map((error) => error.message).join("; ")}`,
  );

  return requireMapping(document.toJS(), label);
}

function expressionReferencesConfigurationContext(expression) {
  const withoutStringLiterals = expression.replace(/'(?:''|[^'])*'|"(?:\\.|[^"\\])*"/g, "");
  return CONFIGURATION_CONTEXT_IDENTIFIER.test(withoutStringLiterals);
}

function stringReferencesConfigurationContext(value, implicitExpression) {
  if (implicitExpression && expressionReferencesConfigurationContext(value)) return true;

  return Array.from(value.matchAll(GITHUB_EXPRESSION)).some((match) =>
    expressionReferencesConfigurationContext(match[1]),
  );
}

function isSemanticConfigurationKey(valuePath, key) {
  if (key === "inputs") {
    return valuePath === "$.on.workflow_call" || valuePath === "$.on.workflow_dispatch";
  }
  if (key !== "secrets") return false;
  return valuePath === "$.on.workflow_call" || /^\$\.jobs\.[^.]+$/.test(valuePath);
}

function findConfigurationContextReferences(
  value,
  valuePath = "$",
  references = [],
  implicitExpression = false,
) {
  if (typeof value === "string") {
    if (stringReferencesConfigurationContext(value, implicitExpression)) {
      references.push(valuePath);
    }
    return references;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      findConfigurationContextReferences(
        item,
        `${valuePath}[${index}]`,
        references,
        implicitExpression,
      ),
    );
    return references;
  }

  if (!isMapping(value)) return references;

  for (const [key, item] of Object.entries(value)) {
    if (isSemanticConfigurationKey(valuePath, key)) {
      references.push(`${valuePath}{key:${key}}`);
    }
    findConfigurationContextReferences(item, `${valuePath}.${key}`, references, key === "if");
  }

  return references;
}

function assertSourceTestOnlyWorkflow(workflow) {
  const jobs = requireMapping(workflow.jobs, "cloud-gateway-discord jobs");

  for (const [jobName, value] of Object.entries(jobs)) {
    const job = requireMapping(value, `cloud-gateway-discord job ${jobName}`);
    assert.equal(
      Object.hasOwn(job, "environment"),
      false,
      `cloud-gateway-discord job ${jobName} must not attach an environment`,
    );
  }

  assert.deepEqual(Object.keys(jobs), ["test"], "cloud-gateway-discord must contain only test");
  assert.deepEqual(
    Object.keys(workflow),
    Object.keys(EXPECTED_SOURCE_ONLY_WORKFLOW),
    "cloud-gateway-discord top-level keys must match the exact source-only contract",
  );
  const testJob = requireMapping(jobs.test, "cloud-gateway-discord test job");
  assert.equal(Object.hasOwn(testJob, "env"), false, "test job must not define environment values");
  assert.equal(
    Object.hasOwn(testJob, "permissions"),
    false,
    "test job must not override workflow permissions",
  );
  assert.deepEqual(
    Object.keys(testJob),
    ["name", "runs-on", "timeout-minutes", "steps"],
    "test job keys must match the exact source-only contract",
  );
  assert.deepEqual(
    findConfigurationContextReferences(workflow),
    [],
    "cloud-gateway-discord must not reference secrets, variables, or reusable-workflow inputs",
  );
  assert.deepEqual(
    workflow,
    EXPECTED_SOURCE_ONLY_WORKFLOW,
    "cloud-gateway-discord must match the exact source-only workflow contract",
  );

  return testJob;
}

function assertDevelopSourceOnlyCaller(caller) {
  assert.deepEqual(
    findConfigurationContextReferences(caller),
    [],
    "develop-full caller must not pass configuration contexts",
  );
  assert.deepEqual(
    caller,
    EXPECTED_DEVELOP_CALLER,
    "develop-full caller must match the exact source-only contract",
  );
}

function replaceExactlyOnce(source, expected, replacement) {
  const firstIndex = source.indexOf(expected);
  assert.notEqual(firstIndex, -1, `mutation target not found: ${expected}`);
  assert.equal(
    source.indexOf(expected, firstIndex + expected.length),
    -1,
    `mutation target is not unique: ${expected}`,
  );
  return source.slice(0, firstIndex) + replacement + source.slice(firstIndex + expected.length);
}

function assertWorkflowSourceRejected(source, expectedError) {
  assert.throws(
    () =>
      assertSourceTestOnlyWorkflow(parseWorkflow(source, "mutated cloud-gateway-discord workflow")),
    expectedError,
  );
}

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
  const workflow = parseWorkflow(readFileSync(WORKFLOW, "utf8"), "cloud-gateway-discord workflow");
  const developWorkflow = parseWorkflow(
    readFileSync(DEVELOP_WORKFLOW, "utf8"),
    "develop-full workflow",
  );
  assertSourceTestOnlyWorkflow(workflow);
  const developPush = requireMapping(developWorkflow.on, "develop-full triggers").push;
  const caller = requireMapping(
    requireMapping(developWorkflow.jobs, "develop-full jobs")["cloud-gateway-discord"],
    "develop-full cloud-gateway-discord caller",
  );

  assert.deepEqual(requireMapping(developPush, "develop-full push trigger").branches, ["develop"]);
  assertDevelopSourceOnlyCaller(caller);
});

test("configuration-context scan accepts benign prose", () => {
  const benignWorkflow = parseWorkflow(
    [
      "name: Mention secrets safely",
      "on:",
      "  workflow_call:",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-24.04",
      "    steps:",
      "      - name: Explain secrets, vars, and inputs",
      "        uses: owner/action@0123456789abcdef",
      "        with:",
      "          note: Secrets, vars, and inputs remain unavailable.",
    ].join("\n"),
    "benign prose workflow",
  );

  assert.deepEqual(findConfigurationContextReferences(benignWorkflow), []);

  const workflowSource = readFileSync(WORKFLOW, "utf8");
  assert.doesNotThrow(() =>
    assertSourceTestOnlyWorkflow(
      parseWorkflow(
        "# Benign prose: secrets, vars, and inputs are unavailable.\n" + workflowSource,
        "commented cloud-gateway-discord workflow",
      ),
    ),
  );
});

test("source-only workflow guard rejects adversarial YAML source mutations", () => {
  const workflowSource = readFileSync(WORKFLOW, "utf8");
  const testName = "    name: Test";
  const contractStep = [
    "      - name: Verify source-only workflow contract",
    "        working-directory: .",
    "        run: bun test packages/cloud/shared/scripts/messaging-gateway-preflight.test.mjs",
  ].join("\n");

  assertWorkflowSourceRejected(
    replaceExactlyOnce(workflowSource, testName, testName + "\n    environment: production"),
    /job test must not attach an environment/,
  );

  for (const scalarSource of [
    "${{ secrets.DOT_TOKEN }}",
    "\"${{ secrets['BRACKET_TOKEN'] }}\"",
    JSON.stringify('${{ secrets["ESCAPED_TOKEN"] }}'),
    '"${{ ' + "\\u0073" + 'ecrets[\\"YAML_ESCAPED_TOKEN\\"] }}"',
    "${{ secrets }}",
    "${{ toJSON(secrets) }}",
  ]) {
    assertWorkflowSourceRejected(
      replaceExactlyOnce(
        workflowSource,
        contractStep,
        contractStep + "\n        env:\n          TOKEN: " + scalarSource,
      ),
      /must not reference secrets, variables, or reusable-workflow inputs/,
    );
  }

  assertWorkflowSourceRejected(
    replaceExactlyOnce(
      workflowSource,
      contractStep,
      contractStep +
        "\n\n      - name: Unvalidated command\n        run: curl https://example.invalid",
    ),
    /must match the exact source-only workflow contract/,
  );

  assertWorkflowSourceRejected(
    replaceExactlyOnce(
      workflowSource,
      testName,
      testName + "\n    env:\n      ENDPOINT: ${{ vars.DISCORD_ENDPOINT }}",
    ),
    /test job must not define environment values/,
  );

  assertWorkflowSourceRejected(
    replaceExactlyOnce(
      workflowSource,
      testName,
      testName + "\n    permissions:\n      contents: write\n      id-token: write",
    ),
    /test job must not override workflow permissions/,
  );

  assertWorkflowSourceRejected(
    replaceExactlyOnce(workflowSource, testName, testName + "\n    container: node:24"),
    /test job keys must match the exact source-only contract/,
  );

  assertWorkflowSourceRejected(
    replaceExactlyOnce(
      workflowSource,
      "name: Cloud Gateway Discord",
      "name: Cloud Gateway Discord\nrun-name: Unvalidated",
    ),
    /top-level keys must match the exact source-only contract/,
  );

  const inputWorkflow = replaceExactlyOnce(
    replaceExactlyOnce(
      workflowSource,
      "  workflow_call:",
      [
        "  workflow_call:",
        "    inputs:",
        "      CONFIG:",
        "        required: false",
        "        type: string",
      ].join("\n"),
    ),
    contractStep,
    contractStep + "\n        env:\n          CONFIG: ${{ inputs.CONFIG }}",
  );
  assertWorkflowSourceRejected(
    inputWorkflow,
    /must not reference secrets, variables, or reusable-workflow inputs/,
  );

  assertWorkflowSourceRejected(
    replaceExactlyOnce(
      workflowSource,
      "    runs-on: ubuntu-24.04",
      "    runs-on: ubuntu-24.04\n    runs-on: self-hosted",
    ),
    /must be valid YAML/,
  );

  let mergedEnvironmentWorkflow = replaceExactlyOnce(
    workflowSource,
    "jobs:",
    ["x-job-defaults: &job-defaults", "  environment: production", "", "jobs:"].join("\n"),
  );
  mergedEnvironmentWorkflow = replaceExactlyOnce(
    mergedEnvironmentWorkflow,
    "  test:",
    "  test:\n    <<: *job-defaults",
  );
  assertWorkflowSourceRejected(
    mergedEnvironmentWorkflow,
    /job test must not attach an environment/,
  );

  const developSource = readFileSync(DEVELOP_WORKFLOW, "utf8");
  const callerBlock = [
    "  cloud-gateway-discord:",
    "    needs: plan",
    "    if: needs.plan.outputs.run_cloud_gateway_discord == 'true'",
    "    uses: ./.github/workflows/cloud-gateway-discord.yml",
  ].join("\n");
  const callerWithInputSource = replaceExactlyOnce(
    developSource,
    callerBlock,
    callerBlock + "\n    with:\n      CONFIG: untrusted",
  );
  const callerWithInputWorkflow = parseWorkflow(
    callerWithInputSource,
    "mutated develop-full workflow",
  );
  const callerWithInput = requireMapping(
    requireMapping(callerWithInputWorkflow.jobs, "mutated develop-full jobs")[
      "cloud-gateway-discord"
    ],
    "mutated develop-full cloud-gateway-discord caller",
  );
  assert.throws(
    () => assertDevelopSourceOnlyCaller(callerWithInput),
    /caller must match the exact source-only contract/,
  );
});
