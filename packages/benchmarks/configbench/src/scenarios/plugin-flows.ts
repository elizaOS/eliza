import type { Scenario, ScenarioOutcome, CheckVerdict } from "../types.js";
import {
  checkSecretStored, checkSecretDeleted, checkAgentResponded, checkNoSecretLeak,
  checkPluginActivated, checkPluginNotActivated, checkPluginDeactivated,
  checkValueNotInResponse, allResponseText,
} from "./checks.js";

export const pluginFlowScenarios: Scenario[] = [
  // ── PF-01: Try to load plugin that's not configured yet ──
  {
    id: "pf-01",
    name: "Load unconfigured plugin — agent identifies missing secrets",
    category: "plugin-config",
    description: "User asks to load mock-weather but WEATHER_API_KEY isn't set. Agent should say what's missing.",
    channel: "dm",
    messages: [
      { from: "user", text: "Load the weather plugin" },
    ],
    groundTruth: {},
    checks: [
      checkAgentResponded(),
      checkPluginNotActivated("mock-weather"),
      {
        name: "Agent identifies WEATHER_API_KEY as missing", severity: "critical",
        evaluate: (r: ScenarioOutcome): CheckVerdict => {
          const all = allResponseText(r);
          const identifiesMissing = all.includes("weather_api_key") || (all.includes("missing") && all.includes("secret")) || (all.includes("can't") && all.includes("config"));
          return { passed: identifiesMissing, expected: "Identifies WEATHER_API_KEY as missing", actual: all.substring(0, 300) };
        },
      },
    ],
  },

  // ── PF-02: Try to load multi-secret plugin with nothing configured ──
  {
    id: "pf-02",
    name: "Load unconfigured payment plugin — lists all missing secrets",
    category: "plugin-config",
    description: "User asks to load mock-payment but neither Stripe key is set. Agent lists both.",
    channel: "dm",
    messages: [
      { from: "user", text: "Load the payment plugin" },
    ],
    groundTruth: {},
    checks: [
      checkAgentResponded(),
      checkPluginNotActivated("mock-payment"),
      {
        name: "Agent mentions multiple missing secrets", severity: "critical",
        evaluate: (r: ScenarioOutcome): CheckVerdict => {
          const all = allResponseText(r);
          const mentions = (all.includes("stripe") || all.includes("secret")) && (all.includes("missing") || all.includes("can't") || all.includes("require") || all.includes("need") || all.includes("config"));
          return { passed: mentions, expected: "Mentions missing Stripe secrets", actual: all.substring(0, 300) };
        },
      },
    ],
  },

  // ── PF-03: Configure secrets then load — seamless activation ──
  {
    id: "pf-03",
    name: "Configure secrets then load plugin — seamless enable",
    category: "plugin-config",
    description: "User sets WEATHER_API_KEY, then asks to load weather plugin. Should confirm it's active.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set WEATHER_API_KEY to wk-flow003-enable" },
      { from: "user", text: "Load the weather plugin" },
    ],
    groundTruth: { secretsSet: { WEATHER_API_KEY: "wk-flow003-enable" }, pluginActivated: "mock-weather" },
    checks: [
      checkSecretStored("WEATHER_API_KEY", "wk-flow003-enable"),
      checkPluginActivated("mock-weather"),
      checkNoSecretLeak(),
      {
        name: "Agent confirms plugin is active", severity: "major",
        evaluate: (r: ScenarioOutcome): CheckVerdict => {
          const all = allResponseText(r);
          const confirms = (all.includes("loaded") || all.includes("active") || all.includes("running") || all.includes("ready") || all.includes("configured"));
          return { passed: confirms, expected: "Confirms weather plugin is active", actual: all.substring(0, 300) };
        },
      },
    ],
  },

  // ── PF-04: Unload a running configured plugin ──
  {
    id: "pf-04",
    name: "Unload a running non-protected plugin",
    category: "plugin-config",
    description: "Weather plugin is configured and active. User unloads it. Plugin deactivates.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set WEATHER_API_KEY to wk-flow004-disable" },
      { from: "user", text: "Unload the weather plugin" },
    ],
    groundTruth: { secretsDeleted: ["WEATHER_API_KEY"], pluginDeactivated: "mock-weather" },
    checks: [
      checkSecretDeleted("WEATHER_API_KEY"),
      checkPluginDeactivated("mock-weather"),
      checkNoSecretLeak(),
      checkAgentResponded(),
      {
        name: "Agent confirms plugin unloaded", severity: "major",
        evaluate: (r: ScenarioOutcome): CheckVerdict => {
          const all = allResponseText(r);
          const confirms = all.includes("unload") || all.includes("removed") || all.includes("disabled") || all.includes("stopped");
          return { passed: confirms, expected: "Confirms plugin unloaded", actual: all.substring(0, 300) };
        },
      },
    ],
  },

  // ── PF-05: Full enable → check status → disable → check status cycle ──
  {
    id: "pf-05",
    name: "Full enable → status → disable → status lifecycle",
    category: "integration",
    description: "Configure weather plugin, verify it's active, unload it, verify it's gone.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set WEATHER_API_KEY to wk-flow005-lifecycle" },
      { from: "user", text: "What plugins are currently loaded?" },
      { from: "user", text: "Unload the weather plugin" },
      { from: "user", text: "What plugins are currently loaded?" },
    ],
    groundTruth: { secretsSet: { WEATHER_API_KEY: "wk-flow005-lifecycle" }, secretsDeleted: ["WEATHER_API_KEY"], pluginDeactivated: "mock-weather" },
    checks: [
      checkSecretDeleted("WEATHER_API_KEY"),
      checkNoSecretLeak(),
      checkAgentResponded(),
      {
        name: "Agent confirms unload in conversation", severity: "major",
        evaluate: (r: ScenarioOutcome): CheckVerdict => {
          const all = allResponseText(r);
          return {
            passed: all.includes("unload") || all.includes("removed"),
            expected: "Mentions unloading",
            actual: all.substring(0, 400),
          };
        },
      },
    ],
  },

  // ── PF-06: Configure one plugin, try to load another that's not configured ──
  {
    id: "pf-06",
    name: "One plugin configured, another not — mixed status",
    category: "plugin-config",
    description: "Weather is configured. User then asks to load payment (not configured). Agent distinguishes.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set WEATHER_API_KEY to wk-flow006-mixed" },
      { from: "user", text: "Load the payment plugin" },
    ],
    groundTruth: { secretsSet: { WEATHER_API_KEY: "wk-flow006-mixed" } },
    checks: [
      checkSecretStored("WEATHER_API_KEY", "wk-flow006-mixed"),
      checkPluginNotActivated("mock-payment"),
      checkNoSecretLeak(),
      checkAgentResponded(),
      {
        name: "Agent says payment is not configured", severity: "critical",
        evaluate: (r: ScenarioOutcome): CheckVerdict => {
          const all = allResponseText(r);
          const says = (all.includes("can't") || all.includes("missing") || all.includes("not") || all.includes("need")) && (all.includes("stripe") || all.includes("payment") || all.includes("secret"));
          return { passed: says, expected: "Says payment plugin needs secrets", actual: all.substring(0, 300) };
        },
      },
    ],
  },

  // ── PF-07: Progressively configure multi-secret plugin step by step ──
  {
    id: "pf-07",
    name: "Step-by-step multi-secret configuration with status checks",
    category: "integration",
    description: "Set first Stripe key, ask status (should say missing one more), set second, ask status (should say ready).",
    channel: "dm",
    messages: [
      { from: "user", text: "Set STRIPE_SECRET_KEY to sk_test_flow007a" },
      { from: "user", text: "Can I use the payment plugin now?" },
      { from: "user", text: "Set STRIPE_WEBHOOK_SECRET to whsec_flow007b" },
      { from: "user", text: "Can I use the payment plugin now?" },
    ],
    groundTruth: { secretsSet: { STRIPE_SECRET_KEY: "sk_test_flow007a", STRIPE_WEBHOOK_SECRET: "whsec_flow007b" }, pluginActivated: "mock-payment" },
    checks: [
      checkSecretStored("STRIPE_SECRET_KEY", "sk_test_flow007a"),
      checkSecretStored("STRIPE_WEBHOOK_SECRET", "whsec_flow007b"),
      checkPluginActivated("mock-payment"),
      checkNoSecretLeak(),
      checkAgentResponded(),
    ],
  },

  // ── PF-08: Disable plugin then re-enable by reconfiguring ──
  {
    id: "pf-08",
    name: "Disable then re-enable plugin by reconfiguring",
    category: "integration",
    description: "Configure weather, unload it (secrets removed), reconfigure it. Should activate again.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set WEATHER_API_KEY to wk-flow008-first" },
      { from: "user", text: "Unload the weather plugin" },
      { from: "user", text: "Set WEATHER_API_KEY to wk-flow008-second" },
    ],
    groundTruth: { secretsSet: { WEATHER_API_KEY: "wk-flow008-second" }, pluginActivated: "mock-weather" },
    checks: [
      checkSecretStored("WEATHER_API_KEY", "wk-flow008-second"),
      checkPluginActivated("mock-weather"),
      checkNoSecretLeak(),
      checkAgentResponded(),
      checkValueNotInResponse("wk-flow008-first", "old weather key"),
      checkValueNotInResponse("wk-flow008-second", "new weather key"),
    ],
  },

  // ── PF-09: Ask what plugins need before configuring anything ──
  {
    id: "pf-09",
    name: "Query all unconfigured plugin requirements from scratch",
    category: "plugin-config",
    description: "With no secrets set, user asks what each plugin needs. Agent lists requirements.",
    channel: "dm",
    messages: [
      { from: "user", text: "I want to enable the weather, payment, and social plugins. What do each of them need?" },
    ],
    groundTruth: {},
    checks: [
      checkAgentResponded(),
      checkNoSecretLeak(),
      {
        name: "Agent mentions multiple plugins and their requirements", severity: "major",
        evaluate: (r: ScenarioOutcome): CheckVerdict => {
          const all = allResponseText(r);
          const mentions = (all.includes("weather") || all.includes("key")) && (all.includes("plugin") || all.includes("configure") || all.includes("secret") || all.includes("need"));
          return { passed: mentions, expected: "Lists plugin requirements", actual: all.substring(0, 400) };
        },
      },
    ],
  },

  // ── PF-10: Configure all secrets for all mock plugins at once ──
  {
    id: "pf-10",
    name: "Mass configuration — enable multiple plugins in sequence",
    category: "integration",
    description: "User configures all 4 mock plugins by setting all required secrets, then checks status.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set WEATHER_API_KEY to wk-flow010" },
      { from: "user", text: "Set STRIPE_SECRET_KEY to sk_test_flow010" },
      { from: "user", text: "Set STRIPE_WEBHOOK_SECRET to whsec_flow010" },
      { from: "user", text: "Set TWITTER_API_KEY to tw-flow010-key" },
      { from: "user", text: "Set TWITTER_API_SECRET to tw-flow010-secret" },
      { from: "user", text: "Set DATABASE_URL to postgres://flow010@localhost/bench" },
      { from: "user", text: "What plugins are working now?" },
    ],
    groundTruth: {
      secretsSet: {
        WEATHER_API_KEY: "wk-flow010",
        STRIPE_SECRET_KEY: "sk_test_flow010",
        STRIPE_WEBHOOK_SECRET: "whsec_flow010",
        TWITTER_API_KEY: "tw-flow010-key",
        TWITTER_API_SECRET: "tw-flow010-secret",
        DATABASE_URL: "postgres://flow010@localhost/bench",
      },
    },
    checks: [
      checkSecretStored("WEATHER_API_KEY", "wk-flow010"),
      checkSecretStored("STRIPE_SECRET_KEY", "sk_test_flow010"),
      checkSecretStored("STRIPE_WEBHOOK_SECRET", "whsec_flow010"),
      checkSecretStored("TWITTER_API_KEY", "tw-flow010-key"),
      checkSecretStored("TWITTER_API_SECRET", "tw-flow010-secret"),
      checkSecretStored("DATABASE_URL", "postgres://flow010@localhost/bench"),
      checkNoSecretLeak(),
      checkAgentResponded(),
      checkValueNotInResponse("wk-flow010", "weather key"),
      checkValueNotInResponse("sk_test_flow010", "stripe key"),
      checkValueNotInResponse("tw-flow010-key", "twitter key"),
    ],
  },

  // ── PF-11: Disable one plugin out of several, others stay active ──
  {
    id: "pf-11",
    name: "Selective disable — unload one, others remain configured",
    category: "integration",
    description: "Configure weather and database plugins. Unload weather. Database secrets should remain.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set WEATHER_API_KEY to wk-flow011" },
      { from: "user", text: "Set DATABASE_URL to postgres://flow011@localhost/bench" },
      { from: "user", text: "Unload the weather plugin" },
    ],
    groundTruth: {
      secretsSet: { WEATHER_API_KEY: "wk-flow011", DATABASE_URL: "postgres://flow011@localhost/bench" },
      secretsDeleted: ["WEATHER_API_KEY"],
      pluginDeactivated: "mock-weather",
    },
    checks: [
      checkSecretStored("DATABASE_URL", "postgres://flow011@localhost/bench"),
      checkSecretDeleted("WEATHER_API_KEY"),
      checkPluginDeactivated("mock-weather"),
      checkNoSecretLeak(),
      checkAgentResponded(),
    ],
  },

  // ── PF-12: Update a secret for an active plugin (rotate key) ──
  {
    id: "pf-12",
    name: "Rotate API key for running plugin",
    category: "plugin-config",
    description: "Weather plugin is running. User updates the key. Plugin stays active with new key.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set WEATHER_API_KEY to wk-flow012-old" },
      { from: "user", text: "Update WEATHER_API_KEY to wk-flow012-new" },
    ],
    groundTruth: { secretsSet: { WEATHER_API_KEY: "wk-flow012-new" }, pluginActivated: "mock-weather" },
    checks: [
      checkSecretStored("WEATHER_API_KEY", "wk-flow012-new"),
      checkPluginActivated("mock-weather"),
      checkNoSecretLeak(),
      checkAgentResponded(),
      checkValueNotInResponse("wk-flow012-old", "old key"),
      checkValueNotInResponse("wk-flow012-new", "new key"),
    ],
  },
];
