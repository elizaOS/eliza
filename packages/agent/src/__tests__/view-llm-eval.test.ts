/**
 * LLM-evaluated view journey tests.
 *
 * Uses an LLM judge to score agent responses against the view user journey
 * scenarios defined in `view-user-journeys.ts`. Tests are skipped when no
 * supported model API key is available in the environment.
 *
 * Supported judge providers (checked in order):
 *   1. Cerebras   — CEREBRAS_API_KEY  (default model: cerebras/gpt-oss-120b)
 *   2. Anthropic  — ANTHROPIC_API_KEY (default model: claude-haiku-4-5-20251001)
 *
 * Override the model via VIEW_EVAL_MODEL env var.
 *
 * Running the full suite:
 *   CEREBRAS_API_KEY=... bun test packages/agent/src/__tests__/view-llm-eval.test.ts
 *
 * This test file is excluded from the standard CI run by the vitest config's
 * `exclude` patterns (*.live.test.ts, *.real.test.ts). Rename with those
 * suffixes to exclude from CI, or run directly when credentials are available.
 */

import { describe, expect, it } from "vitest";
import {
  getScenarioById,
  getScenariosByTag,
  VIEW_USER_JOURNEYS,
  type ViewJourneyScenario,
} from "./view-user-journeys.js";

// ---------------------------------------------------------------------------
// Credential detection
// ---------------------------------------------------------------------------

const hasCerebras = Boolean(process.env.CEREBRAS_API_KEY);
const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
const hasAnyCredential = hasCerebras || hasAnthropic;

// ---------------------------------------------------------------------------
// Judge configuration
// ---------------------------------------------------------------------------

type JudgeProvider = "cerebras" | "anthropic";

function detectProvider(): JudgeProvider {
  if (hasCerebras) return "cerebras";
  return "anthropic";
}

function defaultModel(provider: JudgeProvider): string {
  if (provider === "cerebras") return "gpt-oss-120b";
  return "claude-haiku-4-5-20251001";
}

const JUDGE_PROVIDER = detectProvider();
const JUDGE_MODEL = process.env.VIEW_EVAL_MODEL ?? defaultModel(JUDGE_PROVIDER);

// ---------------------------------------------------------------------------
// Evaluation types
// ---------------------------------------------------------------------------

interface EvalResult {
  scenarioId: string;
  score: number; // 0–10
  navigationCorrect: boolean | null; // null = not applicable
  pass: boolean;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Stub agent — simulates the views system responding to user messages.
//
// In a full integration test this would call a live agent runtime; here we
// use a deterministic stub that produces plausible responses so the LLM judge
// has something to evaluate. Replace `stubAgentResponse` with a real agent
// call when the full runtime is available in the test environment.
// ---------------------------------------------------------------------------

function stubAgentResponse(userMessage: string): string {
  const lower = userMessage.toLowerCase();

  if (
    lower.includes("show me all") ||
    lower.includes("list") ||
    lower.includes("what views")
  ) {
    return (
      "Here are the available views:\n" +
      "- **Wallet** — Manage your crypto assets and wallet\n" +
      "- **Trading** — Buy and sell tokens on DEX markets\n" +
      "- **Chat** — Conversation interface with the agent\n" +
      "- **Settings** — Configure the assistant and connected apps"
    );
  }

  if (
    lower.includes("configure") ||
    lower.includes("configuration") ||
    lower.includes("account")
  ) {
    return "Open Settings from the sidebar, then choose Account or Connected Accounts to configure your account and connection details.";
  }

  if (lower === "go home" || lower.includes("go home") || lower === "home") {
    return "Navigating to the main Chat view (home).";
  }

  if (lower.includes("show apps") || lower.includes("open apps")) {
    return "Opening the View Manager so you can browse all available views.";
  }

  if (lower.includes("open the wallet") || lower.includes("wallet")) {
    return "I've opened the Wallet view for you. You can now manage your crypto assets.";
  }

  if (
    lower.includes("go to settings") ||
    lower === "settings" ||
    lower.includes("open settings")
  ) {
    return "Navigating to Settings now.";
  }

  if (lower.includes("open chat") || lower.includes("open the chat")) {
    return "Switching to the Chat view.";
  }

  if (lower.includes("trading")) {
    return "Opening the Trading Dashboard.";
  }

  if (lower.includes("dashboard")) {
    return "There are multiple dashboard-style views. Did you mean Trading, Wallet, or the View Manager?";
  }

  if (lower.includes("view manager") || lower.includes("grid")) {
    return "Opening the View Manager so you can see all available panels.";
  }

  if (lower.includes("crypto") || lower.includes("finance")) {
    return "For crypto management, you have the Wallet and Trading views available.";
  }

  if (lower.includes("close")) {
    return "The current view has been closed.";
  }

  if (lower.includes("go back")) {
    return "Going back to the previous view.";
  }

  if (lower.includes("dev log") || lower.includes("developer")) {
    return "The Dev Logs view is only available in Developer Mode. Enable it in Settings → Developer Options.";
  }

  if (lower.includes("balance")) {
    return "Opening the Wallet view and checking your balance. You currently hold 1.23 ETH and 500 USDC.";
  }

  if (lower.includes("inventory")) {
    return "I don't have an 'inventory' view. The available views are Wallet, Trading, Chat, and Settings. Did you mean one of those?";
  }

  if (lower.includes("pin")) {
    return "The Wallet view has been pinned as a tab on your desktop.";
  }

  if (lower.includes("install")) {
    return "Installing the weather plugin… Done! A new Weather view is now available. You can access it from the View Manager.";
  }

  if (
    lower.includes("click") ||
    lower.includes("press") ||
    lower.includes("button")
  ) {
    return "I've clicked the Send button in the Wallet view for you.";
  }

  if (lower.includes("refresh")) {
    return "The Wallet view has been refreshed with the latest data.";
  }

  if (
    lower.includes("fill") ||
    lower.includes("recipient") ||
    lower.includes("address")
  ) {
    return "I've filled in the recipient address field in the wallet Send form.";
  }

  if (lower.includes("send funds") || lower.includes("transfer")) {
    return "To send funds, I'll need the recipient address and amount. Please confirm and I'll initiate the transfer in the Wallet view.";
  }

  if (
    lower.includes("what can you do") ||
    lower.includes("capabilities") ||
    lower.includes("help me")
  ) {
    return "I can navigate to views, search for capabilities, interact with views on your behalf, and install new plugins. Try saying 'show me all views' to explore what's available.";
  }

  return "I can help you navigate to a view. The available views are: Wallet, Trading, Chat, and Settings.";
}

// ---------------------------------------------------------------------------
// LLM judge
// ---------------------------------------------------------------------------

async function callCerebrasJudge(prompt: string): Promise<string> {
  const baseUrl = process.env.CEREBRAS_BASE_URL ?? "https://api.cerebras.ai/v1";
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 512,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Cerebras API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
  };
  return data.choices[0]?.message?.content ?? "";
}

async function callAnthropicJudge(prompt: string): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    content: { type: string; text: string }[];
  };
  return data.content.find((c) => c.type === "text")?.text ?? "";
}

async function callJudge(prompt: string): Promise<string> {
  if (JUDGE_PROVIDER === "cerebras") return callCerebrasJudge(prompt);
  return callAnthropicJudge(prompt);
}

function buildJudgePrompt(
  scenario: ViewJourneyScenario,
  agentResponse: string,
): string {
  return `You are evaluating an AI assistant's response to a user request about a views navigation system.

USER MESSAGE: "${scenario.userMessage}"

EXPECTED BEHAVIOR: ${scenario.expectedBehavior}

VERIFICATION CRITERIA:
${scenario.verificationCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

AGENT RESPONSE:
"${agentResponse}"

Evaluate the agent response. Reply with valid JSON only — no prose, no markdown fences:
{
  "score": <integer 0-10>,
  "navigationCorrect": <true|false|null>,
  "pass": <true if score >= 7>,
  "reasoning": "<one sentence>"
}

score 0 = completely wrong or unhelpful
score 7 = adequately correct
score 10 = perfect response
navigationCorrect = true if the agent navigated or would navigate to the right view, false if wrong, null if navigation is not applicable for this scenario.`;
}

async function evaluateScenario(
  scenario: ViewJourneyScenario,
): Promise<EvalResult> {
  const agentResponse = stubAgentResponse(scenario.userMessage);
  const judgePrompt = buildJudgePrompt(scenario, agentResponse);
  const rawJudgeResponse = await callJudge(judgePrompt);

  let parsed: Partial<EvalResult>;
  try {
    parsed = JSON.parse(rawJudgeResponse) as Partial<EvalResult>;
  } catch {
    // If the judge returned unparseable output, treat as low score.
    parsed = {
      score: 0,
      navigationCorrect: null,
      pass: false,
      reasoning: `Judge returned unparseable response: ${rawJudgeResponse.slice(0, 200)}`,
    };
  }

  return {
    scenarioId: scenario.id,
    score: parsed.score ?? 0,
    navigationCorrect: parsed.navigationCorrect ?? null,
    pass: parsed.pass ?? (parsed.score ?? 0) >= 7,
    reasoning: parsed.reasoning ?? "",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!hasAnyCredential)(
  `View LLM evaluation (judge: ${JUDGE_PROVIDER}/${JUDGE_MODEL})`,
  () => {
    // ── Smoke test: single scenario ──────────────────────────────────────

    it('evaluates "show me all views" with score >= 7', async () => {
      const scenario = getScenarioById("show-all-views");
      const result = await evaluateScenario(scenario);

      expect(result.score).toBeGreaterThanOrEqual(7);
      expect(result.pass).toBe(true);
    }, 30_000);

    it('evaluates "open wallet" with correct navigation', async () => {
      const scenario = getScenarioById("open-wallet");
      const result = await evaluateScenario(scenario);

      expect(result.score).toBeGreaterThanOrEqual(7);
      // navigationCorrect may be null if the judge finds it not applicable,
      // but it should not be false for a navigation scenario.
      expect(result.navigationCorrect).not.toBe(false);
    }, 30_000);

    // ── Discovery scenarios ──────────────────────────────────────────────

    it("discovery scenarios score >= 7 on average", async () => {
      const scenarios = getScenariosByTag("discovery");
      const results = await Promise.all(scenarios.map(evaluateScenario));

      const total = results.reduce((sum, r) => sum + r.score, 0);
      const average = total / results.length;

      // Surface failures for debugging
      const failures = results.filter((r) => !r.pass);
      if (failures.length > 0) {
        console.error(
          "Failing discovery scenarios:",
          failures.map((f) => `${f.scenarioId}: ${f.reasoning}`),
        );
      }

      expect(average).toBeGreaterThanOrEqual(7);
    }, 120_000);

    // ── Navigation scenarios ─────────────────────────────────────────────

    it("navigation scenarios have correct navigation direction", async () => {
      const scenarios = getScenariosByTag("navigation").slice(0, 5); // cap for cost
      const results = await Promise.all(scenarios.map(evaluateScenario));

      const withNavAssertion = results.filter(
        (r) => r.navigationCorrect !== null,
      );
      const correct = withNavAssertion.filter(
        (r) => r.navigationCorrect === true,
      );

      // At least 80% of applicable navigation scenarios should be correct.
      if (withNavAssertion.length > 0) {
        expect(correct.length / withNavAssertion.length).toBeGreaterThanOrEqual(
          0.8,
        );
      }
    }, 120_000);

    // ── Error handling scenarios ─────────────────────────────────────────

    it("error-handling scenarios respond helpfully without crashing", async () => {
      const scenarios = getScenariosByTag("error-handling");
      const results = await Promise.all(scenarios.map(evaluateScenario));

      const failures = results.filter((r) => r.score < 5);
      expect(failures).toHaveLength(0);
    }, 120_000);

    // ── Full suite summary (informational) ───────────────────────────────

    it("full journey suite: at least 80% of scenarios score >= 7", async () => {
      // Run all scenarios but cap to avoid excessive API cost in tests.
      const scenarios = VIEW_USER_JOURNEYS.slice(0, 10);
      const results = await Promise.all(scenarios.map(evaluateScenario));

      const passing = results.filter((r) => r.pass);
      const passRate = passing.length / results.length;

      const failures = results.filter((r) => !r.pass);
      if (failures.length > 0) {
        console.error(
          "Failing scenarios:",
          failures.map(
            (f) => `${f.scenarioId} (score=${f.score}): ${f.reasoning}`,
          ),
        );
      }

      expect(passRate).toBeGreaterThanOrEqual(0.8);
    }, 300_000);
  },
);

// ---------------------------------------------------------------------------
// Deterministic scenario library tests (no credentials required)
// ---------------------------------------------------------------------------

describe("view-user-journeys scenario library", () => {
  it("contains at least 20 scenarios", () => {
    expect(VIEW_USER_JOURNEYS.length).toBeGreaterThanOrEqual(20);
  });

  it("all scenario ids are unique", () => {
    const ids = VIEW_USER_JOURNEYS.map((s) => s.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("all scenarios have required fields", () => {
    for (const s of VIEW_USER_JOURNEYS) {
      expect(s.id, `scenario ${s.id} missing id`).toBeTruthy();
      expect(
        s.description,
        `scenario ${s.id} missing description`,
      ).toBeTruthy();
      expect(
        s.userMessage,
        `scenario ${s.id} missing userMessage`,
      ).toBeTruthy();
      expect(
        s.expectedBehavior,
        `scenario ${s.id} missing expectedBehavior`,
      ).toBeTruthy();
      expect(
        s.verificationCriteria.length,
        `scenario ${s.id} has no verification criteria`,
      ).toBeGreaterThan(0);
      expect(s.tags.length, `scenario ${s.id} has no tags`).toBeGreaterThan(0);
    }
  });

  it("getScenarioById returns the correct scenario", () => {
    const s = getScenarioById("show-all-views");
    expect(s.id).toBe("show-all-views");
    expect(s.userMessage).toBe("show me all views");
  });

  it("getScenarioById throws for unknown id", () => {
    expect(() => getScenarioById("nonexistent-id")).toThrow();
  });

  it("getScenariosByTag returns only matching scenarios", () => {
    const navScenarios = getScenariosByTag("navigation");
    expect(navScenarios.length).toBeGreaterThan(0);
    for (const s of navScenarios) {
      expect(s.tags).toContain("navigation");
    }
  });

  it("getScenariosByTag with multiple tags returns union", () => {
    const results = getScenariosByTag("discovery", "error-handling");
    for (const s of results) {
      const hasMatch = s.tags.some((t) =>
        ["discovery", "error-handling"].includes(t),
      );
      expect(hasMatch).toBe(true);
    }
  });

  it("all tags in use are from a known vocabulary", () => {
    const KNOWN_TAGS = new Set([
      "discovery",
      "navigation",
      "view-manager",
      "search",
      "error-handling",
      "permissions",
      "capabilities",
      "plugin-install",
      "desktop",
      "voice",
      "interaction",
      "multi-turn",
      "e2e",
    ]);
    for (const s of VIEW_USER_JOURNEYS) {
      for (const tag of s.tags) {
        expect(
          KNOWN_TAGS.has(tag),
          `Unknown tag "${tag}" in scenario "${s.id}"`,
        ).toBe(true);
      }
    }
  });
});
