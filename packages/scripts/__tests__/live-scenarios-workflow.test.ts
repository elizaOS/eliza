/**
 * Locks the credentialed scenario and model-heavy benchmark authorities to
 * their checked-in manifests while keeping retired no-op workflows absent.
 */

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PLUGIN_ROUTE_COVERAGE } from "../e2e-coverage/manifest.ts";
import { loadLiveScenarioManifest } from "../live-scenario-matrix.mjs";

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

test("builds the dist-exported runtime closure before each live shard", () => {
  const liveWorkflow = readWorkflow("live-scenarios.yml");
  const runStep = "- name: Run live scenario shard";

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
