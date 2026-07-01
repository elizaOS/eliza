/**
 * #10732 — capture a REAL live-model trajectory of the app compliance-review
 * classifier. Runs `classifyCandidate` against a live model for a spread of
 * lawful and prohibited listings (including subtle cases the keyword pre-filter
 * cannot catch, forcing the LLM to decide) and writes the inputs+outputs to a
 * JSON trajectory for PR evidence.
 *
 * Usage:
 *   APP_REVIEW_MODEL=gpt-oss-120b CEREBRAS_API_KEY=... \
 *     bun scripts/10732-live-classifier-trajectory.mjs <out.json>
 */
import { writeFileSync } from "node:fs";
import {
  buildReviewCandidate,
  classifyCandidate,
  getAppReviewModelId,
  POLICY_RUBRIC,
  RUBRIC_VERSION,
} from "../packages/cloud/shared/src/lib/services/app-review.ts";

const outPath = process.argv[2] || "10732-classifier-trajectory.json";

/** Each case: an app listing + the disposition we expect a correct classifier to reach. */
const CASES = [
  {
    id: "allow-productivity",
    expect: "allow",
    app: {
      name: "TaskFlow",
      description: "A to-do list and calendar assistant that helps you plan your week.",
      app_url: "https://taskflow.example.com",
      website_url: null,
      metadata: { tags: ["productivity", "calendar"] },
    },
  },
  {
    id: "allow-harm-reduction-education",
    expect: "allow",
    app: {
      name: "DrugFacts",
      description:
        "Educational harm-reduction reference explaining the health risks of common substances. Does not sell or source anything; information only.",
      app_url: "https://drugfacts.example.org",
      website_url: null,
      metadata: { tags: ["education", "health"] },
    },
  },
  {
    id: "ban-guaranteed-yield-scheme",
    expect: "ban",
    app: {
      name: "QuickCash Doubler",
      description:
        "Deposit your crypto and our algorithm guarantees your balance doubles in 30 days. Withdraw anytime. Risk-free returns, pay in and get paid from new deposits.",
      app_url: "https://quickcashdoubler.example.com",
      website_url: null,
      metadata: { tags: ["investment", "crypto"] },
    },
  },
  {
    id: "ban-unlicensed-pharma",
    expect: "ban",
    app: {
      name: "MediMart",
      description:
        "Order prescription-strength medications shipped discreetly to your door — no doctor visit or prescription required.",
      app_url: "https://medimart.example.com",
      website_url: null,
      metadata: { tags: ["health", "pharmacy"] },
    },
  },
];

const model = getAppReviewModelId();
console.log(`[trajectory] model=${model} rubric=${RUBRIC_VERSION}`);

const runs = [];
for (const c of CASES) {
  const candidate = buildReviewCandidate(c.app);
  const started = Date.now();
  let result;
  let error = null;
  try {
    result = await classifyCandidate(candidate.document);
  } catch (e) {
    error = {
      name: e?.name,
      message: e?.message,
      statusCode: e?.statusCode,
      url: e?.url,
      responseBody: typeof e?.responseBody === "string" ? e.responseBody.slice(0, 800) : undefined,
      cause: e?.cause ? String(e.cause).slice(0, 400) : undefined,
    };
    console.log(`             ERROR: ${JSON.stringify(error)}`);
  }
  const durationMs = Date.now() - started;
  const correct = result ? result.disposition === c.expect : false;
  console.log(
    `[trajectory] ${c.id}: expected=${c.expect} got=${result?.disposition ?? "ERROR"} ` +
      `preFilter=${result?.preFilterMatched ?? "-"} ${correct ? "✓" : "✗"} (${durationMs}ms)`,
  );
  if (result) console.log(`             rationale: ${result.rationale}`);
  runs.push({
    id: c.id,
    expected: c.expect,
    input: { candidateDocument: candidate.document, contentHash: candidate.contentHash },
    output: result ?? null,
    error,
    correct,
    durationMs,
  });
}

const summary = {
  capturedFor: "#10732 app compliance-review classifier",
  model,
  rubricVersion: RUBRIC_VERSION,
  rubric: POLICY_RUBRIC,
  totalCases: CASES.length,
  correct: runs.filter((r) => r.correct).length,
  runs,
};
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(`\n[trajectory] ${summary.correct}/${summary.totalCases} correct → wrote ${outPath}`);
