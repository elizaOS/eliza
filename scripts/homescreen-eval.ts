#!/usr/bin/env bun
/**
 * homescreen-eval — real-Cerebras proof + GEPA optimization for the HOMESCREEN
 * edit/create prompt.
 *
 * The metric here is HARD, not a fuzzy judge: a model output scores 1.0 only if
 * it parses, validates as a scene document (the client's authority,
 * `scene-validate`), applies cleanly through the real reducer
 * (`scene-apply`), AND satisfies the scenario's intent predicate (e.g. "make the
 * background black" => theme.background === 0). Partial credit is given for
 * outputs that parse/validate but miss intent, so GEPA has a gradient.
 *
 * Two modes:
 *   proof  (default) — run the baseline prompt over the scenario set once and
 *                      report the validation/intent success rate. This is the
 *                      real-LLM e2e proof of the edit flow (task #35).
 *   gepa             — reflective prompt optimization: score the baseline, ask
 *                      the model to diagnose failures, generate candidate system
 *                      prefixes, keep the best. Exports the winner (task #36).
 *
 * Usage:
 *   CEREBRAS_API_KEY=csk-... bun run scripts/homescreen-eval.ts            # proof
 *   CEREBRAS_API_KEY=csk-... bun run scripts/homescreen-eval.ts --gepa     # optimize
 *
 * Env:
 *   CEREBRAS_API_KEY   required
 *   CEREBRAS_MODEL     default gpt-oss-120b
 *   HS_GENERATIONS     GEPA generations (default 2)
 *   HS_CANDIDATES      candidate prefixes per generation (default 3)
 *   HS_EXPORT_DIR      default /tmp/homescreen-eval-<ts>
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyHomescreenInstruction } from "../packages/ui/src/homescreen/scene-apply";
import {
  createHistory,
  currentScene,
} from "../packages/ui/src/homescreen/scene-history";
import {
  createDefaultScene,
  type HomescreenScene,
} from "../packages/ui/src/homescreen/scene-types";
import {
  buildHomescreenPrompt,
  extractSceneJson,
  type HomescreenEditMode,
} from "../plugins/plugin-app-control/src/actions/homescreen-prompt";

// ── Config ────────────────────────────────────────────────────────────────

const API_KEY = process.env.CEREBRAS_API_KEY ?? "";
const MODEL = process.env.CEREBRAS_MODEL ?? "gpt-oss-120b";
const BASE_URL = process.env.CEREBRAS_BASE_URL ?? "https://api.cerebras.ai/v1";
const GENERATIONS = Number.parseInt(process.env.HS_GENERATIONS ?? "2", 10);
const CANDIDATES = Number.parseInt(process.env.HS_CANDIDATES ?? "3", 10);
const EXPORT_DIR =
  process.env.HS_EXPORT_DIR ?? `/tmp/homescreen-eval-${Date.now()}`;
const GEPA = process.argv.includes("--gepa");

if (!API_KEY) {
  console.error("CEREBRAS_API_KEY is required.");
  process.exit(1);
}

// ── Cerebras client with backoff (the key is rate-limited; 429s are common) ──

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// Minimum spacing between request *starts* so we stay under the per-minute
// quota instead of stampeding into 429s. The key is shared and tightly
// throttled, so pacing — not retrying — is the real fix.
const MIN_INTERVAL_MS = Number.parseInt(
  process.env.CEREBRAS_MIN_INTERVAL_MS ?? "1500",
  10,
);
// How long a single call may spend backing off before it gives up. Big enough
// to ride out a full quota window (a 60s RPM bucket) even under contention.
const BACKOFF_BUDGET_MS = Number.parseInt(
  process.env.CEREBRAS_BACKOFF_BUDGET_MS ?? "180000",
  10,
);

// Serialize every Cerebras call through one chain and space the starts. This
// guarantees at most one in-flight request and a steady cadence, which is what
// keeps us under the rate limit rather than relying on backoff alone.
let cerebrasChain: Promise<unknown> = Promise.resolve();
let lastStart = 0;
function gate<T>(fn: () => Promise<T>): Promise<T> {
  const run = cerebrasChain.then(async () => {
    const since = Date.now() - lastStart;
    if (since < MIN_INTERVAL_MS) await sleep(MIN_INTERVAL_MS - since);
    lastStart = Date.now();
    return fn();
  });
  cerebrasChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function cerebras(
  messages: ChatMessage[],
  temperature: number,
  maxTokens: number,
): Promise<string> {
  const body = {
    model: MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  return gate(async () => {
    let attempt = 0;
    let waited = 0;
    for (;;) {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        return json.choices?.[0]?.message?.content ?? "";
      }
      if (res.status === 429 && waited < BACKOFF_BUDGET_MS) {
        // Honor the server's Retry-After when present, else exponential
        // backoff; add jitter so concurrent jobs don't resync their retries.
        const retryAfter = Number.parseInt(
          res.headers.get("retry-after") ?? "",
          10,
        );
        const headerWait = Number.isFinite(retryAfter) ? retryAfter * 1000 : 0;
        const backoff = Math.min(2000 * 2 ** attempt, 30_000);
        const wait =
          Math.max(headerWait, backoff) + Math.floor(Math.random() * 500);
        attempt += 1;
        waited += wait;
        console.log(
          `  · 429 rate-limited, backing off ${wait}ms (try ${attempt}, ${Math.round(waited / 1000)}s total)`,
        );
        await sleep(wait);
        continue;
      }
      throw new Error(
        `Cerebras ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    }
  });
}

// ── Scenarios — each is a request + the intent it must satisfy ───────────────

interface Scenario {
  id: string;
  mode: HomescreenEditMode;
  request: string;
  base: () => HomescreenScene;
  /** Hard intent predicate over the applied scene; true = request honored. */
  intent: (scene: HomescreenScene) => boolean;
}

const SCENARIOS: Scenario[] = [
  {
    id: "background-black",
    mode: "edit",
    request: "make the background black",
    base: createDefaultScene,
    intent: (s) => s.theme.background === 0,
  },
  {
    id: "accent-recolor",
    mode: "edit",
    request: "change the accent to a deep purple",
    base: createDefaultScene,
    intent: (s) => {
      const [r, g, b] = s.theme.accent;
      // Purple: meaningful red + blue, low green.
      return r > 0.25 && b > 0.25 && g < r && g < b;
    },
  },
  {
    id: "keep-crystal-ball",
    mode: "edit",
    request: "keep the crystal ball but make it pulse faster",
    base: createDefaultScene,
    // A small tweak must keep a renderable background (preset or script).
    intent: (s) =>
      s.background.kind === "preset" || s.background.kind === "script",
  },
  {
    id: "scifi-jarvis",
    mode: "create",
    request:
      "give me a totally sci-fi looking Jarvis style interface, glowing cyan",
    base: createDefaultScene,
    intent: (s) =>
      s.background.kind === "preset" || s.background.kind === "script",
  },
  {
    id: "calm-deep-space",
    mode: "create",
    request: "a calm deep space scene with slow drifting stars",
    base: createDefaultScene,
    intent: (s) =>
      s.background.kind === "preset" || s.background.kind === "script",
  },
];

// ── Scoring — the hard metric ────────────────────────────────────────────────

interface ScoreDetail {
  scenario: string;
  score: number;
  reason: string;
}

function scoreOutput(scenario: Scenario, raw: string): ScoreDetail {
  const json = extractSceneJson(raw);
  if (!json) {
    return { scenario: scenario.id, score: 0, reason: "no JSON object found" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      scenario: scenario.id,
      score: 0.2,
      reason: `JSON.parse failed: ${(err as Error).message}`,
    };
  }
  // Run the exact client reducer the live app uses.
  const result = applyHomescreenInstruction(createHistory(scenario.base()), {
    op: scenario.mode,
    sceneJson: json,
  });
  if (result.error) {
    return {
      scenario: scenario.id,
      score: 0.5,
      reason: `validation rejected: ${result.error}`,
    };
  }
  const applied = currentScene(result.history);
  if (!scenario.intent(applied)) {
    return {
      scenario: scenario.id,
      score: 0.75,
      reason: "valid + applied but intent not satisfied",
    };
  }
  void (parsed as HomescreenScene);
  return {
    scenario: scenario.id,
    score: 1,
    reason: "valid + applied + intent",
  };
}

// ── One eval pass over all scenarios with a given system prefix ──────────────

const BASELINE_SYSTEM =
  "You output ONLY a JSON homescreen scene document — no markdown fence, no " +
  "prose, no explanation. Follow the OUTPUT SCHEMA exactly.";

async function evalPass(
  systemPrefix: string,
  label: string,
): Promise<{ mean: number; details: ScoreDetail[] }> {
  const details: ScoreDetail[] = [];
  for (const scenario of SCENARIOS) {
    const user = buildHomescreenPrompt({
      mode: scenario.mode,
      request: scenario.request,
      currentSceneJson: JSON.stringify(scenario.base()),
    });
    const raw = await cerebras(
      [
        { role: "system", content: systemPrefix },
        { role: "user", content: user },
      ],
      0.2,
      8192,
    );
    const detail = scoreOutput(scenario, raw);
    details.push(detail);
    console.log(
      `  [${label}] ${scenario.id}: ${detail.score.toFixed(2)} — ${detail.reason}`,
    );
    if (process.env.HS_DEBUG && detail.score < 0.5) {
      console.log(
        `    raw[len=${raw.length}] head: ${JSON.stringify(raw.slice(0, 120))}`,
      );
      console.log(`    raw tail: ${JSON.stringify(raw.slice(-120))}`);
    }
    // Gentle spacing between calls to respect the rate limit.
    await sleep(700);
  }
  const mean = details.reduce((a, d) => a + d.score, 0) / details.length;
  return { mean, details };
}

// ── GEPA-style reflective optimization ───────────────────────────────────────

async function reflect(
  systemPrefix: string,
  details: ScoreDetail[],
): Promise<string> {
  const failures = details
    .filter((d) => d.score < 1)
    .map((d) => `- ${d.scenario}: ${d.reason}`)
    .join("\n");
  const user =
    "You are optimizing the SYSTEM PROMPT given to a model that must output a " +
    "JSON homescreen scene document. Here is the current system prompt:\n\n" +
    `"""${systemPrefix}"""\n\n` +
    `These scenarios scored below 1.0:\n${failures || "(none)"}\n\n` +
    "Write an improved system prompt that fixes these failure modes. It must " +
    "push the model to emit STRICT JSON (no fence, no prose), honor explicit " +
    "user requests (e.g. 'make the background black' => theme.background must be " +
    "0), and keep a renderable background. Reply with ONLY the new system " +
    "prompt text, nothing else.";
  const out = await cerebras(
    [
      {
        role: "system",
        content: "You are a precise prompt engineer. Output only the prompt.",
      },
      { role: "user", content: user },
    ],
    0.7,
    1024,
  );
  return out.trim().replace(/^"+|"+$/g, "");
}

async function runGepa(): Promise<void> {
  console.log(
    `\nGEPA optimization · ${GENERATIONS} generations × ${CANDIDATES} candidates\n`,
  );
  let best = BASELINE_SYSTEM;
  const baseline = await evalPass(best, "baseline");
  let bestScore = baseline.mean;
  let bestDetails = baseline.details;
  console.log(`baseline mean: ${bestScore.toFixed(3)}\n`);

  const lineage: Array<{ gen: number; cand: number; score: number }> = [
    { gen: 0, cand: 0, score: bestScore },
  ];

  for (let gen = 1; gen <= GENERATIONS && bestScore < 1; gen++) {
    for (let cand = 1; cand <= CANDIDATES && bestScore < 1; cand++) {
      const candidate = await reflect(best, bestDetails);
      const pass = await evalPass(candidate, `gen${gen}.${cand}`);
      lineage.push({ gen, cand, score: pass.mean });
      console.log(`gen${gen}.${cand} mean: ${pass.mean.toFixed(3)}\n`);
      if (pass.mean > bestScore) {
        bestScore = pass.mean;
        best = candidate;
        bestDetails = pass.details;
        console.log(`  ★ new best: ${bestScore.toFixed(3)}\n`);
      }
    }
  }

  mkdirSync(EXPORT_DIR, { recursive: true });
  writeFileSync(
    join(EXPORT_DIR, "homescreen-edit-optimized.txt"),
    best,
    "utf8",
  );
  writeFileSync(
    join(EXPORT_DIR, "homescreen-edit-baseline.txt"),
    BASELINE_SYSTEM,
    "utf8",
  );
  writeFileSync(
    join(EXPORT_DIR, "homescreen-edit-report.json"),
    JSON.stringify(
      { model: MODEL, baseline: baseline.mean, best: bestScore, lineage },
      null,
      2,
    ),
    "utf8",
  );
  console.log(
    `\nDone. baseline ${baseline.mean.toFixed(3)} → best ${bestScore.toFixed(3)}`,
  );
  console.log(`Exported to ${EXPORT_DIR}`);
}

async function runProof(): Promise<void> {
  console.log(
    `\nReal-Cerebras proof · model ${MODEL} · ${SCENARIOS.length} scenarios\n`,
  );
  const { mean, details } = await evalPass(BASELINE_SYSTEM, "proof");
  const fullPass = details.filter((d) => d.score === 1).length;
  const validApplied = details.filter((d) => d.score >= 0.75).length;
  console.log(`\nmean score: ${mean.toFixed(3)}`);
  console.log(`valid + applied: ${validApplied}/${details.length}`);
  console.log(`intent satisfied: ${fullPass}/${details.length}`);
  mkdirSync(EXPORT_DIR, { recursive: true });
  writeFileSync(
    join(EXPORT_DIR, "homescreen-proof-report.json"),
    JSON.stringify({ model: MODEL, mean, details }, null, 2),
    "utf8",
  );
  console.log(`Report: ${join(EXPORT_DIR, "homescreen-proof-report.json")}`);
}

await (GEPA ? runGepa() : runProof());
