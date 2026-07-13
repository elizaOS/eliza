/**
 * Locks the credentialed scenario and model-heavy benchmark authorities to
 * their checked-in manifests while keeping retired no-op workflows absent.
 */

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PLUGIN_ROUTE_COVERAGE } from "../e2e-coverage/manifest.ts";
import {
  LIVE_SCENARIO_CREDENTIAL_PROFILES,
  loadLiveScenarioManifest,
} from "../live-scenario-matrix.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workflow = (name: string) =>
  fileURLToPath(new URL(`../../../.github/workflows/${name}`, import.meta.url));
const readWorkflow = (name: string) => readFileSync(workflow(name), "utf8");

const expectedE2eEnvironmentNames = [
  "ELIZA_E2E_ANTHROPIC_API_KEY",
  "ELIZA_E2E_APPLE_APNS_KEY_ID",
  "ELIZA_E2E_APPLE_APNS_KEY_P8",
  "ELIZA_E2E_APPLE_APNS_TOPIC",
  "ELIZA_E2E_APPLE_TEAM_ID",
  "ELIZA_E2E_BLUEBUBBLES_PASSWORD",
  "ELIZA_E2E_BLUEBUBBLES_RECIPIENT_HANDLE",
  "ELIZA_E2E_BLUEBUBBLES_SERVER_URL",
  "ELIZA_E2E_CALENDLY_ACCESS_TOKEN",
  "ELIZA_E2E_CALENDLY_EVENT_TYPE_URI",
  "ELIZA_E2E_CALENDLY_HOST_URI",
  "ELIZA_E2E_DISCORD_BOT_TOKEN",
  "ELIZA_E2E_DISCORD_CLIENT_ID",
  "ELIZA_E2E_DISCORD_CLIENT_SECRET",
  "ELIZA_E2E_DISCORD_QA_CHANNEL_ID",
  "ELIZA_E2E_DISCORD_QA_GUILD_ID",
  "ELIZA_E2E_DISCORD_USER_RELAY_TOKEN",
  "ELIZA_E2E_ELIZACLOUD_API_KEY",
  "ELIZA_E2E_ELIZACLOUD_BASE_URL",
  "ELIZA_E2E_GITHUB_AGENT_PAT",
  "ELIZA_E2E_GITHUB_ORG",
  "ELIZA_E2E_GITHUB_TEMPLATE_REPO",
  "ELIZA_E2E_GITHUB_USER_PAT",
  "ELIZA_E2E_GMAIL_TESTAGENT_ADDRESS",
  "ELIZA_E2E_GMAIL_TESTAGENT_CLIENT_ID",
  "ELIZA_E2E_GMAIL_TESTAGENT_CLIENT_SECRET",
  "ELIZA_E2E_GMAIL_TESTAGENT_REFRESH_TOKEN",
  "ELIZA_E2E_GMAIL_TESTOWNER_ADDRESS",
  "ELIZA_E2E_GMAIL_TESTOWNER_CLIENT_ID",
  "ELIZA_E2E_GMAIL_TESTOWNER_CLIENT_SECRET",
  "ELIZA_E2E_GMAIL_TESTOWNER_REFRESH_TOKEN",
  "ELIZA_E2E_GOOGLE_GENERATIVE_AI_API_KEY", // gitleaks:allow - environment variable name, not a credential.
  "ELIZA_E2E_GROQ_API_KEY",
  "ELIZA_E2E_ONEPASS_SA_TOKEN", // gitleaks:allow - environment variable name, not a credential.
  "ELIZA_E2E_ONEPASS_VAULT_ID",
  "ELIZA_E2E_OPENAI_API_KEY",
  "ELIZA_E2E_OPENROUTER_API_KEY",
  "ELIZA_E2E_SIGNAL_DATA_DIR",
  "ELIZA_E2E_SIGNAL_PHONE_NUMBER",
  "ELIZA_E2E_SIGNAL_RECIPIENT_PHONE_NUMBER",
  "ELIZA_E2E_TELEGRAM_APP_HASH",
  "ELIZA_E2E_TELEGRAM_APP_ID",
  "ELIZA_E2E_TELEGRAM_BOT_TOKEN",
  "ELIZA_E2E_TELEGRAM_CHAT_ID",
  "ELIZA_E2E_TELEGRAM_USERBOT_PHONE_NUMBER",
  "ELIZA_E2E_TELEGRAM_USERBOT_SESSION_STRING",
  "ELIZA_E2E_TWILIO_ACCOUNT_SID",
  "ELIZA_E2E_TWILIO_API_KEY_SECRET", // gitleaks:allow - environment variable name, not a credential.
  "ELIZA_E2E_TWILIO_API_KEY_SID",
  "ELIZA_E2E_TWILIO_MESSAGING_SERVICE_SID",
  "ELIZA_E2E_TWILIO_RECIPIENT",
  "ELIZA_E2E_TWILIO_SMS_FROM",
  "ELIZA_E2E_TWILIO_VOICE_FROM",
  "ELIZA_E2E_TWITTER_CLIENT_ID",
  "ELIZA_E2E_TWITTER_CLIENT_SECRET",
  "ELIZA_E2E_TWITTER_FRIEND_HANDLE",
  "ELIZA_E2E_TWITTER_FRIEND_REFRESH_TOKEN",
  "ELIZA_E2E_TWITTER_USER_HANDLE",
  "ELIZA_E2E_TWITTER_USER_REFRESH_TOKEN",
  "ELIZA_E2E_WHATSAPP_ACCESS_TOKEN",
  "ELIZA_E2E_WHATSAPP_BUSINESS_ACCOUNT_ID",
  "ELIZA_E2E_WHATSAPP_PHONE_NUMBER_ID",
  "ELIZA_E2E_WHATSAPP_RECIPIENT_PHONE_NUMBER",
  "ELIZA_E2E_WHATSAPP_WEBHOOK_VERIFY_TOKEN",
];

const expectedRuntimeCredentialEnvironmentNames = [
  "ANTHROPIC_API_KEY",
  "CALENDLY_API_TOKEN",
  "CEREBRAS_API_KEY",
  "DISCORD_BOT_TOKEN",
  "DISCORD_TEST_CHANNEL_ID",
  "DISCORD_TEST_GUILD_ID",
  "GMAIL_TEST_ACCOUNT_EMAIL",
  "GMAIL_TEST_ACCOUNT_REFRESH_TOKEN",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REFRESH_TOKEN",
  "GROQ_API_KEY",
  "IMESSAGE_BRIDGE_URL",
  "IMESSAGE_TEST_HANDLE",
  "NOTIFICATION_RELAY_TOKEN",
  "NOTIFICATION_RELAY_URL",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "SIGNAL_CLI_URL",
  "SIGNAL_TEST_NUMBER",
  "TELEGRAM_API_HASH",
  "TELEGRAM_API_ID",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_TEST_CHAT_ID",
  "TRAVEL_BOOKING_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "TWILIO_TEST_TO_NUMBER",
  "WHATSAPP_PHONE_ID",
  "WHATSAPP_TEST_CONTACT",
  "WHATSAPP_TOKEN",
  "X_ACCESS_SECRET",
  "X_ACCESS_TOKEN",
  "X_API_KEY",
  "X_API_SECRET",
  "X_TEST_DM_HANDLE",
];

const modelCredentialEnvironmentNames = new Set([
  "ANTHROPIC_API_KEY",
  "CEREBRAS_API_KEY",
  "ELIZA_E2E_ANTHROPIC_API_KEY",
  "ELIZA_E2E_GOOGLE_GENERATIVE_AI_API_KEY",
  "ELIZA_E2E_GROQ_API_KEY",
  "ELIZA_E2E_OPENAI_API_KEY",
  "ELIZA_E2E_OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
]);

const credentialProfileForEnvironment = (environmentName: string): string => {
  if (modelCredentialEnvironmentNames.has(environmentName)) return "model";
  if (
    /^(GOOGLE_OAUTH|GMAIL_TEST_ACCOUNT|ELIZA_E2E_GMAIL_)/.test(environmentName)
  ) {
    return "google-workspace";
  }
  const fragments: Array<[string, string]> = [
    ["CALENDLY", "calendly"],
    ["DISCORD", "discord"],
    ["TELEGRAM", "telegram"],
    ["SIGNAL", "signal"],
    ["IMESSAGE", "imessage"],
    ["BLUEBUBBLES", "bluebubbles"],
    ["WHATSAPP", "whatsapp"],
    ["TWILIO", "twilio"],
    ["TWITTER", "twitter"],
    ["NOTIFICATION", "notifications"],
    ["TRAVEL", "travel"],
    ["GITHUB", "github"],
    ["ONEPASS", "onepassword"],
    ["ELIZACLOUD", "elizacloud"],
    ["APPLE", "apple"],
  ];
  if (environmentName.startsWith("X_")) return "twitter";
  const match = fragments.find(([fragment]) =>
    environmentName.includes(fragment),
  );
  if (!match) {
    throw new Error(
      `credential test inventory has no profile for ${environmentName}`,
    );
  }
  return match[1];
};

test("keeps retired no-op workflows absent", () => {
  expect(existsSync(workflow("gpu-bench-nightly.yml"))).toBe(false);
  expect(existsSync(workflow("scenario-matrix.yml"))).toBe(false);

  const liveWorkflow = readWorkflow("live-scenarios.yml");
  expect(liveWorkflow).not.toMatch(/\n {2}push:/);
  expect(liveWorkflow).not.toContain("Scenario Matrix Disabled");
});

test("resolves scheduled and focused live runs from the canonical shard manifest", () => {
  const liveWorkflow = readWorkflow("live-scenarios.yml");
  const manifest = loadLiveScenarioManifest();

  expect(liveWorkflow).toContain("packages/scripts/live-scenario-matrix.mjs");
  expect(liveWorkflow).toContain(
    `matrix: \${{ fromJSON(needs.plan.outputs.matrix) }}`,
  );
  expect(liveWorkflow).toContain("--lane live-only");
  expect(liveWorkflow).toContain("EXPORT_NATIVE_PATH:");
  expect(liveWorkflow).toContain("scenario_filter requires one explicit shard");
  for (const shard of manifest.shards) {
    expect(liveWorkflow).toContain(`          - ${shard.name}`);
  }
});

test("preserves every structured eliza-e2e credential mapping", () => {
  const liveWorkflow = readWorkflow("live-scenarios.yml");
  const actual = [
    ...new Set(liveWorkflow.match(/ELIZA_E2E_[A-Z0-9_]+/g) ?? []),
  ].sort();

  expect(actual).toEqual(expectedE2eEnvironmentNames);
});

test("limits each credential profile to the live shard execution step", () => {
  const liveWorkflow = readWorkflow("live-scenarios.yml");
  const jobStart = liveWorkflow.indexOf("  live-scenarios:");
  const runStepStart = liveWorkflow.indexOf(
    "      - name: Run live scenario shard",
  );
  const runEnvironmentStart = liveWorkflow.indexOf(
    "        env:\n",
    runStepStart,
  );
  const runCommandStart = liveWorkflow.indexOf(
    "        run: |",
    runEnvironmentStart,
  );

  expect(jobStart).toBeGreaterThan(-1);
  expect(runStepStart).toBeGreaterThan(jobStart);
  expect(runEnvironmentStart).toBeGreaterThan(runStepStart);
  expect(runCommandStart).toBeGreaterThan(runEnvironmentStart);
  expect(liveWorkflow.slice(0, runEnvironmentStart)).not.toContain("secrets.");
  expect(liveWorkflow.slice(runCommandStart)).not.toContain("secrets.");

  const runEnvironment = liveWorkflow.slice(
    runEnvironmentStart,
    runCommandStart,
  );
  const secretLines = runEnvironment
    .split("\n")
    .filter((line) => line.includes("secrets."));
  const actualEnvironmentNames: string[] = [];
  const actualProfiles = new Set<string>();
  for (const line of secretLines) {
    const mapping = line.match(
      /^ {10}([A-Z0-9_]+): \$\{\{ contains\(matrix\.shard\.credentialProfiles, '([^']+)'\) && \((.*secrets\..*)\) \|\| '' \}\}(?: #.*)?$/,
    );
    expect(mapping, `unconditioned secret mapping: ${line}`).not.toBeNull();
    if (!mapping) continue;
    const [, environmentName, profile] = mapping;
    expect(profile).toBe(credentialProfileForEnvironment(environmentName));
    actualEnvironmentNames.push(environmentName);
    actualProfiles.add(profile);
  }

  expect(actualEnvironmentNames.sort()).toEqual(
    [
      ...expectedE2eEnvironmentNames,
      ...expectedRuntimeCredentialEnvironmentNames,
    ].sort(),
  );
  expect([...actualProfiles].sort()).toEqual(
    [...LIVE_SCENARIO_CREDENTIAL_PROFILES].sort(),
  );
});

test("builds the dist-exported runtime closure before each live shard", () => {
  const liveWorkflow = readWorkflow("live-scenarios.yml");
  const runStep = "- name: Run live scenario shard";
  const buildStep = liveWorkflow.slice(
    liveWorkflow.indexOf("      - name: Build live scenario runtime packages"),
    liveWorkflow.indexOf(`      ${runStep}`),
  );

  expect(liveWorkflow).toMatch(
    /package_dirs=\([\s\S]*plugins\/plugin-local-inference[\s\S]*plugins\/plugin-app-control[\s\S]*plugins\/plugin-health[\s\S]*\)[\s\S]*for package_dir in "\$\{package_dirs\[@\]\}"/,
  );
  expect(liveWorkflow).toMatch(
    /package_dirs=\([\s\S]*plugins\/plugin-blocker[\s\S]*\)[\s\S]*for package_dir in "\$\{package_dirs\[@\]\}"/,
  );
  expect(liveWorkflow.indexOf("package_dirs=(")).toBeLessThan(
    liveWorkflow.indexOf(runStep),
  );
  expect(liveWorkflow).toContain("--conditions=eliza-source");
  for (const providerPackage of [
    "plugins/plugin-groq",
    "plugins/plugin-openai",
    "plugins/plugin-anthropic",
    "plugins/plugin-google-genai",
    "plugins/plugin-openrouter",
  ]) {
    expect(buildStep).toContain(providerPackage);
  }
  expect(buildStep).not.toContain("provider_package");
  expect(buildStep).not.toContain("secrets.");
});

test("maps GPU probe intent to active real voice and local-inference authorities", () => {
  const voiceLive = readWorkflow("voice-live-e2e.yml");
  const localInference = readWorkflow("local-inference-bench.yml");

  expect(voiceLive).toContain("VOICE_LIVE_RUNNER_LABELS");
  expect(voiceLive).toContain("gpu-cuda-12.6");
  expect(voiceLive).toContain("libelizainference");
  expect(localInference).toContain("name: Nightly real-agent profile");
  expect(localInference).toContain("schedule:");
});

test("coverage inventories name the live workflow as their authority", () => {
  const checker = readFileSync(
    `${repositoryRoot}packages/scripts/check-scenario-workflow-coverage.mjs`,
    "utf8",
  );
  const e2eManifest = readFileSync(
    `${repositoryRoot}packages/scripts/e2e-coverage/manifest.ts`,
    "utf8",
  );

  expect(checker).toContain("loadLiveScenarioManifest");
  expect(checker).not.toContain("scenario-matrix.yml");
  expect(e2eManifest).toContain("live-scenarios.yml");
  expect(e2eManifest).not.toContain("scenario-matrix.yml");

  const lifeopsCoverage = PLUGIN_ROUTE_COVERAGE["plugin-personal-assistant"];
  expect(lifeopsCoverage?.status).toBe("exempt");
  expect(lifeopsCoverage?.artifacts).toContain(
    "packages/scripts/__tests__/live-scenarios-workflow.test.ts",
  );
});

test("includes the dynamically loaded app manager in the agent build graph", () => {
  const packageJson = JSON.parse(
    readFileSync(`${repositoryRoot}packages/agent/package.json`, "utf8"),
  ) as { dependencies?: Record<string, string> };
  expect(packageJson.dependencies?.["@elizaos/plugin-app-manager"]).toBe(
    "workspace:*",
  );
});
