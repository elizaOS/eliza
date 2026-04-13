import type { Scenario, ScenarioOutcome, CheckVerdict } from "../types.js";
import {
  checkSecretStored, checkSecretDeleted, checkAgentResponded,
  checkNoSecretLeak, checkValueNotInResponse, allResponseText,
} from "./checks.js";

export const integrationScenarios: Scenario[] = [
  {
    id: "int-01", name: "Full flow: set secrets then check plugin status", category: "integration",
    description: "User configures all secrets for mock-weather, then asks about plugin status.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set WEATHER_API_KEY to wk-fullflow001" },
      { from: "user", text: "What plugins are working now?" },
    ],
    groundTruth: { secretsSet: { WEATHER_API_KEY: "wk-fullflow001" }, pluginActivated: "mock-weather" },
    checks: [
      checkSecretStored("WEATHER_API_KEY", "wk-fullflow001"),
      checkNoSecretLeak(), checkAgentResponded(),
    ],
  },
  {
    id: "int-02", name: "Full CRUD lifecycle in one conversation", category: "integration",
    description: "Create, list, delete, and verify deletion in sequence.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set LIFECYCLE_KEY to lifecycle-002-value" },
      { from: "user", text: "Show me my secrets" },
      { from: "user", text: "Delete LIFECYCLE_KEY" },
      { from: "user", text: "Do I have a LIFECYCLE_KEY set?" },
    ],
    groundTruth: { secretsDeleted: ["LIFECYCLE_KEY"] },
    checks: [
      checkSecretDeleted("LIFECYCLE_KEY"),
      checkNoSecretLeak(), checkAgentResponded(),
      {
        name: "Final response indicates key is not set", severity: "major",
        evaluate: (r: ScenarioOutcome): CheckVerdict => {
          const last = (r.agentResponses[r.agentResponses.length - 1] ?? "").toLowerCase();
          const gone = ["not", "no", "don't", "missing", "deleted"].some(w => last.includes(w));
          return { passed: gone, expected: "Final response says key is not set", actual: gone ? "Correctly indicates absent" : last.substring(0, 200) };
        },
      },
    ],
  },
  {
    id: "int-03", name: "Secret key alias resolution", category: "integration",
    description: "Test that aliases are resolved to canonical key names.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set my OPENAI_API_KEY to sk-test-alias003" },
      { from: "user", text: "Check if OPENAI_API_KEY is configured" },
    ],
    groundTruth: { secretsSet: { OPENAI_API_KEY: "sk-test-alias003" } },
    checks: [
      checkSecretStored("OPENAI_API_KEY", "sk-test-alias003"),
      checkNoSecretLeak(), checkAgentResponded(),
    ],
  },
  {
    id: "int-04", name: "Both services accessible from runtime", category: "integration",
    description: "Verify agent can discuss both secrets and plugin management.",
    channel: "dm",
    messages: [{ from: "user", text: "What capabilities do you have for managing plugins and secrets?" }],
    groundTruth: {},
    checks: [
      checkAgentResponded(),
      {
        name: "Response mentions both secrets and plugins", severity: "major",
        evaluate: (r: ScenarioOutcome): CheckVerdict => {
          const all = allResponseText(r);
          const ok = (all.includes("secret") || all.includes("credential")) && (all.includes("plugin") || all.includes("load"));
          return { passed: ok, expected: "Mentions both secrets and plugin capabilities", actual: ok ? "Both mentioned" : all.substring(0, 300) };
        },
      },
    ],
  },
  {
    id: "int-05", name: "No secrets leak during plugin status check", category: "integration",
    description: "After setting secrets, asking about plugins should not leak secret values.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set OPENAI_API_KEY to sk-test-intleak005" },
      { from: "user", text: "Set GROQ_API_KEY to gsk_intleak005test" },
      { from: "user", text: "Tell me about all loaded plugins and their configuration" },
    ],
    groundTruth: { secretsSet: { OPENAI_API_KEY: "sk-test-intleak005", GROQ_API_KEY: "gsk_intleak005test" } },
    checks: [
      checkNoSecretLeak(),
      checkValueNotInResponse("sk-test-intleak005", "OpenAI key"),
      checkValueNotInResponse("gsk_intleak005test", "Groq key"),
      checkAgentResponded(),
    ],
  },
  {
    id: "int-06", name: "Empty state - no secrets configured", category: "integration",
    description: "With no secrets set, asking about secrets should indicate empty state.",
    channel: "dm",
    messages: [{ from: "user", text: "List all my secrets" }],
    groundTruth: {},
    checks: [
      checkAgentResponded(),
      {
        name: "Agent indicates no secrets or empty state", severity: "major",
        evaluate: (r: ScenarioOutcome): CheckVerdict => {
          const all = allResponseText(r);
          const empty = ["no secret", "none configured", "empty", "don't have", "haven't configured"].some(p => all.includes(p));
          return { passed: empty || Object.keys(r.secretsInStorage).length === 0, expected: "Indicates empty state", actual: empty ? "Empty state indicated" : all.substring(0, 200) };
        },
      },
    ],
  },
  {
    id: "int-07", name: "Handle large secret value", category: "integration",
    description: "Store a secret with a long value and verify it roundtrips.",
    channel: "dm",
    messages: [{ from: "user", text: `Set LARGE_SECRET to ${"A".repeat(500)}` }],
    groundTruth: { secretsSet: { LARGE_SECRET: "A".repeat(500) } },
    checks: [
      {
        name: "Large secret stored correctly", severity: "major",
        evaluate: (r: ScenarioOutcome): CheckVerdict => ({
          passed: r.secretsInStorage["LARGE_SECRET"] === "A".repeat(500),
          expected: `LARGE_SECRET = ${"A".repeat(20)}... (500 chars)`,
          actual: r.secretsInStorage["LARGE_SECRET"]
            ? `${r.secretsInStorage["LARGE_SECRET"].substring(0, 20)}... (${r.secretsInStorage["LARGE_SECRET"].length} chars)`
            : "not found",
        }),
      },
      checkNoSecretLeak(), checkAgentResponded(),
    ],
  },
];
