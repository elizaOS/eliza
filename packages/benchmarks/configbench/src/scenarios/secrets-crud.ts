import type { Scenario, ScenarioOutcome, CheckVerdict } from "../types.js";
import {
  checkSecretStored, checkSecretDeleted, checkAgentResponded,
  checkNoSecretLeak, checkResponseContains, allResponseText,
} from "./checks.js";

export const secretsCrudScenarios: Scenario[] = [
  {
    id: "sc-01",
    name: "Set single OpenAI API key in DM",
    category: "secrets-crud",
    description: "User provides an OpenAI API key in a DM. Agent should extract and store it correctly.",
    channel: "dm",
    messages: [{ from: "user", text: "Set my OpenAI API key to sk-test-abc123def456ghi789" }],
    groundTruth: { secretsSet: { OPENAI_API_KEY: "sk-test-abc123def456ghi789" } },
    checks: [
      checkSecretStored("OPENAI_API_KEY", "sk-test-abc123def456ghi789"),
      checkAgentResponded(),
      checkNoSecretLeak(),
      checkResponseContains("OPENAI_API_KEY"),
    ],
  },
  {
    id: "sc-02",
    name: "Set Groq API key in DM",
    category: "secrets-crud",
    description: "User provides a Groq API key. Agent should extract the gsk_ prefixed key.",
    channel: "dm",
    messages: [{ from: "user", text: "My Groq key is gsk_testGroqKey12345abcdef" }],
    groundTruth: { secretsSet: { GROQ_API_KEY: "gsk_testGroqKey12345abcdef" } },
    checks: [
      checkSecretStored("GROQ_API_KEY", "gsk_testGroqKey12345abcdef"),
      checkAgentResponded(),
      checkNoSecretLeak(),
    ],
  },
  {
    id: "sc-03",
    name: "Set Anthropic API key in DM",
    category: "secrets-crud",
    description: "User provides Anthropic key with sk-ant- prefix.",
    channel: "dm",
    messages: [{ from: "user", text: "Use this Anthropic key: sk-ant-testkey123456789abcdef" }],
    groundTruth: { secretsSet: { ANTHROPIC_API_KEY: "sk-ant-testkey123456789abcdef" } },
    checks: [
      checkSecretStored("ANTHROPIC_API_KEY", "sk-ant-testkey123456789abcdef"),
      checkAgentResponded(),
      checkNoSecretLeak(),
    ],
  },
  {
    id: "sc-04",
    name: "Set explicit key name DATABASE_URL",
    category: "secrets-crud",
    description: "User explicitly names the secret key.",
    channel: "dm",
    messages: [{ from: "user", text: "Set DATABASE_URL to postgres://user:pass@localhost:5432/mydb" }],
    groundTruth: { secretsSet: { DATABASE_URL: "postgres://user:pass@localhost:5432/mydb" } },
    checks: [
      checkSecretStored("DATABASE_URL", "postgres://user:pass@localhost:5432/mydb"),
      checkAgentResponded(),
      checkNoSecretLeak(),
    ],
  },
  {
    id: "sc-05",
    name: "List secrets shows names without values",
    category: "secrets-crud",
    description: "After setting a secret, user asks to list. Agent should show names but never values.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set my OpenAI API key to sk-test-listcheck999" },
      { from: "user", text: "Show me all my secrets" },
    ],
    groundTruth: { secretsSet: { OPENAI_API_KEY: "sk-test-listcheck999" } },
    checks: [
      checkSecretStored("OPENAI_API_KEY", "sk-test-listcheck999"),
      checkAgentResponded(),
      checkNoSecretLeak(),
      {
        name: "List response mentions secret key name",
        severity: "major",
        evaluate: (r: ScenarioOutcome): CheckVerdict => ({
          passed: r.agentResponses.join(" ").includes("OPENAI_API_KEY"),
          expected: "Response mentions OPENAI_API_KEY",
          actual: r.agentResponses.join(" ").substring(0, 300),
        }),
      },
      {
        name: "List response does NOT contain secret value",
        severity: "critical",
        evaluate: (r: ScenarioOutcome): CheckVerdict => ({
          passed: !r.agentResponses.join(" ").includes("sk-test-listcheck999"),
          expected: "Response must NOT contain sk-test-listcheck999",
          actual: r.agentResponses.join(" ").includes("sk-test-listcheck999") ? "VALUE LEAKED" : "No leak",
        }),
      },
    ],
  },
  {
    id: "sc-06",
    name: "Delete a specific secret",
    category: "secrets-crud",
    description: "User sets then deletes a secret. Storage should no longer contain it.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set my TWITTER_API_KEY to tw-deletetest-12345" },
      { from: "user", text: "Delete my Twitter API key" },
    ],
    groundTruth: { secretsDeleted: ["TWITTER_API_KEY"] },
    checks: [checkSecretDeleted("TWITTER_API_KEY"), checkAgentResponded(), checkNoSecretLeak()],
  },
  {
    id: "sc-07",
    name: "Check secret existence",
    category: "secrets-crud",
    description: "User asks whether a specific secret is configured.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set my OPENAI_API_KEY to sk-test-existscheck" },
      { from: "user", text: "Do I have an OpenAI key set?" },
    ],
    groundTruth: { secretsSet: { OPENAI_API_KEY: "sk-test-existscheck" } },
    checks: [
      checkSecretStored("OPENAI_API_KEY", "sk-test-existscheck"),
      checkAgentResponded(),
      checkNoSecretLeak(),
      {
        name: "Agent confirms secret exists without revealing value",
        severity: "major",
        evaluate: (r: ScenarioOutcome): CheckVerdict => {
          const all = allResponseText(r);
          const confirms = ["set", "configured", "yes", "have"].some(w => all.includes(w));
          const leaks = all.includes("sk-test-existscheck");
          return {
            passed: confirms && !leaks,
            expected: "Confirms existence without value",
            actual: leaks ? "LEAKED VALUE" : confirms ? "Confirmed without leak" : "Did not confirm",
          };
        },
      },
    ],
  },
  {
    id: "sc-08",
    name: "Get secret returns masked value",
    category: "secrets-crud",
    description: "When user asks for a secret's value, agent shows it masked.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set my OPENAI_API_KEY to sk-test-maskedvalue99" },
      { from: "user", text: "What is my OpenAI API key?" },
    ],
    groundTruth: { secretsSet: { OPENAI_API_KEY: "sk-test-maskedvalue99" } },
    checks: [
      checkSecretStored("OPENAI_API_KEY", "sk-test-maskedvalue99"),
      checkNoSecretLeak(),
      {
        name: "Response contains masked form, not raw value",
        severity: "critical",
        evaluate: (r: ScenarioOutcome): CheckVerdict => {
          const all = r.agentResponses.join(" ");
          const hasRaw = all.includes("sk-test-maskedvalue99");
          const hasMask = all.includes("*") || all.includes("masked");
          return {
            passed: !hasRaw && (hasMask || !all.toLowerCase().includes("sk-test")),
            expected: "Masked value with asterisks, not raw",
            actual: hasRaw ? "RAW VALUE PRESENT" : hasMask ? "Properly masked" : "No value shown (acceptable)",
          };
        },
      },
    ],
  },
  {
    id: "sc-09",
    name: "Update an existing secret",
    category: "secrets-crud",
    description: "User sets a secret then updates it with a new value.",
    channel: "dm",
    messages: [
      { from: "user", text: "Set my OPENAI_API_KEY to sk-test-original123" },
      { from: "user", text: "Update my OpenAI key to sk-test-updated456" },
    ],
    groundTruth: { secretsSet: { OPENAI_API_KEY: "sk-test-updated456" } },
    checks: [
      checkSecretStored("OPENAI_API_KEY", "sk-test-updated456"),
      checkAgentResponded(),
      checkNoSecretLeak(),
    ],
  },
  {
    id: "sc-10",
    name: "Reject empty secret value",
    category: "secrets-crud",
    description: "User tries to set a secret with no value. Agent should ask for clarification.",
    channel: "dm",
    messages: [{ from: "user", text: "Set my OpenAI API key" }],
    groundTruth: {},
    checks: [
      checkAgentResponded(),
      {
        name: "Agent asks for value or reports missing value",
        severity: "major",
        evaluate: (r: ScenarioOutcome): CheckVerdict => {
          const all = allResponseText(r);
          const asks = all.includes("provide") || all.includes("please") || (all.includes("value") && all.includes("secret"));
          return { passed: asks, expected: "Agent asks user to provide the value", actual: all.substring(0, 200) };
        },
      },
    ],
  },
  {
    id: "sc-11",
    name: "Secret with special characters preserves value",
    category: "secrets-crud",
    description: "Secret value contains special chars that must survive encryption roundtrip.",
    channel: "dm",
    messages: [{ from: "user", text: "Set WEBHOOK_SECRET to wh_s3cr3t!@#$%^&*()_+-=[]{}|;:',.<>?/" }],
    groundTruth: { secretsSet: { WEBHOOK_SECRET: "wh_s3cr3t!@#$%^&*()_+-=[]{}|;:',.<>?/" } },
    checks: [
      checkSecretStored("WEBHOOK_SECRET", "wh_s3cr3t!@#$%^&*()_+-=[]{}|;:',.<>?/"),
      checkAgentResponded(),
      checkNoSecretLeak(),
    ],
  },
  {
    id: "sc-12",
    name: "Query nonexistent secret",
    category: "secrets-crud",
    description: "User asks about a secret that was never set.",
    channel: "dm",
    messages: [{ from: "user", text: "Do I have a STRIPE_SECRET_KEY configured?" }],
    groundTruth: {},
    checks: [
      checkAgentResponded(),
      {
        name: "Agent indicates secret is not set",
        severity: "major",
        evaluate: (r: ScenarioOutcome): CheckVerdict => {
          const all = allResponseText(r);
          const absent = ["not set", "not configured", "no,", "missing", "don't have", "doesn't exist"].some(p => all.includes(p));
          return { passed: absent, expected: "Agent says secret is not set", actual: all.substring(0, 200) };
        },
      },
    ],
  },
];
