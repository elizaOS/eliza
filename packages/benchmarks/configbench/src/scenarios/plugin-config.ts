import type { Scenario, ScenarioOutcome, CheckVerdict } from "../types.js";
import {
  checkSecretStored, checkSecretDeleted, checkAgentResponded, checkNoSecretLeak,
  checkPluginActivated, checkPluginNotActivated, allResponseText,
} from "./checks.js";

export const pluginConfigScenarios: Scenario[] = [
  {
    id: "pc-01", name: "Configure secret for mock-weather plugin", category: "plugin-config",
    description: "Set the WEATHER_API_KEY that mock-weather requires. Plugin should activate.",
    channel: "dm",
    messages: [{ from: "user", text: "Set WEATHER_API_KEY to wk-test-weather001" }],
    groundTruth: { secretsSet: { WEATHER_API_KEY: "wk-test-weather001" }, pluginActivated: "mock-weather" },
    checks: [
      checkSecretStored("WEATHER_API_KEY", "wk-test-weather001"),
      checkPluginActivated("mock-weather"),
      checkNoSecretLeak(), checkAgentResponded(),
    ],
  },
  {
    id: "pc-02", name: "Configure both secrets for mock-payment plugin", category: "plugin-config",
    description: "Set both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET. Plugin activates after both.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set STRIPE_SECRET_KEY to sk_test_stripe002abc" },
      { from: "user", text: "Set STRIPE_WEBHOOK_SECRET to whsec_test002xyz" },
    ],
    groundTruth: { secretsSet: { STRIPE_SECRET_KEY: "sk_test_stripe002abc", STRIPE_WEBHOOK_SECRET: "whsec_test002xyz" }, pluginActivated: "mock-payment" },
    checks: [
      checkSecretStored("STRIPE_SECRET_KEY", "sk_test_stripe002abc"),
      checkSecretStored("STRIPE_WEBHOOK_SECRET", "whsec_test002xyz"),
      checkPluginActivated("mock-payment"),
      checkNoSecretLeak(), checkAgentResponded(),
    ],
  },
  {
    id: "pc-03", name: "Partial secrets do not activate plugin", category: "plugin-config",
    description: "Set only one of two required secrets for mock-social. Plugin should remain pending.",
    channel: "dm",
    messages: [{ from: "user", text: "Set TWITTER_API_KEY to tw-partial003-key" }],
    groundTruth: { secretsSet: { TWITTER_API_KEY: "tw-partial003-key" } },
    checks: [
      checkSecretStored("TWITTER_API_KEY", "tw-partial003-key"),
      checkPluginNotActivated("mock-social"),
      checkNoSecretLeak(), checkAgentResponded(),
    ],
  },
  {
    id: "pc-04", name: "Complete remaining secret activates plugin", category: "plugin-config",
    description: "Provide both secrets to activate mock-social.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set TWITTER_API_KEY to tw-complete004-key" },
      { from: "user", text: "Set TWITTER_API_SECRET to tw-complete004-secret" },
    ],
    groundTruth: { secretsSet: { TWITTER_API_KEY: "tw-complete004-key", TWITTER_API_SECRET: "tw-complete004-secret" }, pluginActivated: "mock-social" },
    checks: [
      {
        name: "Both Twitter secrets stored", severity: "major",
        evaluate: (r: ScenarioOutcome): CheckVerdict => ({
          passed: r.secretsInStorage["TWITTER_API_KEY"] === "tw-complete004-key" && r.secretsInStorage["TWITTER_API_SECRET"] === "tw-complete004-secret",
          expected: "Both TWITTER_API_KEY and TWITTER_API_SECRET stored",
          actual: `KEY=${r.secretsInStorage["TWITTER_API_KEY"] ?? "missing"}, SECRET=${r.secretsInStorage["TWITTER_API_SECRET"] ?? "missing"}`,
        }),
      },
      checkPluginActivated("mock-social"),
      checkNoSecretLeak(),
    ],
  },
  {
    id: "pc-05", name: "Plugin with only optional secrets loads without them", category: "plugin-config",
    description: "mock-database has DATABASE_URL required, DATABASE_POOL_SIZE optional. Set only required.",
    channel: "dm",
    messages: [{ from: "user", text: "Set DATABASE_URL to postgres://test:test@localhost:5432/bench" }],
    groundTruth: { secretsSet: { DATABASE_URL: "postgres://test:test@localhost:5432/bench" }, pluginActivated: "mock-database" },
    checks: [
      checkSecretStored("DATABASE_URL", "postgres://test:test@localhost:5432/bench"),
      checkPluginActivated("mock-database"),
      checkNoSecretLeak(),
    ],
  },
  {
    id: "pc-06", name: "Deleting a required secret is reflected", category: "plugin-config",
    description: "Set a secret then delete it. The system should know the secret is gone.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set WEATHER_API_KEY to wk-delete006-temp" },
      { from: "user", text: "Delete my WEATHER_API_KEY" },
    ],
    groundTruth: { secretsDeleted: ["WEATHER_API_KEY"] },
    checks: [checkSecretDeleted("WEATHER_API_KEY"), checkNoSecretLeak(), checkAgentResponded()],
  },
  {
    id: "pc-07", name: "Guided onboarding for missing secrets", category: "plugin-config",
    description: "User asks what needs configuring. Agent identifies missing secrets.",
    channel: "dm",
    messages: [{ from: "user", text: "What do I need to configure to get all plugins working?" }],
    groundTruth: {},
    checks: [
      checkAgentResponded(),
      {
        name: "Agent identifies missing configuration", severity: "major",
        evaluate: (r: ScenarioOutcome): CheckVerdict => {
          const all = allResponseText(r);
          const ok = (all.includes("key") || all.includes("secret")) && (all.includes("configure") || all.includes("missing") || all.includes("require") || all.includes("need") || all.includes("set up"));
          return { passed: ok, expected: "Identifies missing configuration", actual: ok ? "Properly identified" : all.substring(0, 300) };
        },
      },
      checkNoSecretLeak(),
    ],
  },
  {
    id: "pc-08", name: "Validation rejects bad API key format", category: "plugin-config",
    description: "User provides an OpenAI key that doesn't match the sk- prefix pattern.",
    channel: "dm",
    messages: [{ from: "user", text: "Set my OpenAI API key to bad-format-no-prefix" }],
    groundTruth: {},
    checks: [
      checkAgentResponded(), checkNoSecretLeak(),
      {
        name: "Agent handles potential format mismatch gracefully", severity: "minor",
        evaluate: (r: ScenarioOutcome): CheckVerdict => ({
          passed: r.agentResponses.length > 0,
          expected: "Agent responds (may warn about format or accept)",
          actual: `${r.agentResponses.length} responses`,
        }),
      },
    ],
  },
];
