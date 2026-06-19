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
const MAX_SCENARIOS = Number.parseInt(process.env.HS_MAX_SCENARIOS ?? "0", 10);
const COUNT_SCENARIOS = process.argv.includes("--count-scenarios");
const VALIDATE_SCENARIOS = process.argv.includes("--validate-scenarios");

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

const BASE_SCENARIOS: Scenario[] = [
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

const backgroundScenario = (
  id: string,
  request: string,
  background: number,
): Scenario => ({
  id,
  mode: "edit",
  request,
  base: createDefaultScene,
  intent: (s) => s.theme.background === background,
});

const accentScenario = (
  id: string,
  request: string,
  intent: Scenario["intent"],
): Scenario => ({
  id,
  mode: "edit",
  request,
  base: createDefaultScene,
  intent,
});

const blockScenario = (
  id: string,
  request: string,
  intent: Scenario["intent"],
): Scenario => ({
  id,
  mode: "edit",
  request,
  base: createDefaultScene,
  intent,
});

const createSceneScenario = (
  id: string,
  request: string,
  intent: Scenario["intent"] = (s) =>
    s.background.kind === "preset" || s.background.kind === "script",
): Scenario => ({
  id,
  mode: "create",
  request,
  base: createDefaultScene,
  intent,
});

const scriptScene = (s: HomescreenScene) => s.background.kind === "script";
const renderableScene = (s: HomescreenScene) =>
  s.background.kind === "preset" || s.background.kind === "script";

const EXPANDED_SCENARIOS: Scenario[] = [
  // Theme color precision and named-color grounding.
  backgroundScenario(
    "edge-background-white",
    "make the background pure white",
    0xffffff,
  ),
  backgroundScenario(
    "edge-background-navy",
    "set the page background to midnight navy",
    0x000020,
  ),
  backgroundScenario(
    "edge-background-charcoal",
    "make the background dark charcoal, almost black but not pure black",
    0x111111,
  ),
  backgroundScenario(
    "edge-background-red",
    "turn the background into a saturated red",
    0xff0000,
  ),
  backgroundScenario(
    "edge-background-green",
    "make the background a clean matrix green",
    0x00ff00,
  ),
  backgroundScenario(
    "edge-background-blue",
    "make the background pure electric blue",
    0x0000ff,
  ),
  backgroundScenario(
    "edge-background-magenta",
    "change the background to hot magenta",
    0xff00ff,
  ),
  backgroundScenario(
    "edge-background-cyan",
    "change the background to bright cyan",
    0x00ffff,
  ),
  backgroundScenario(
    "edge-background-yellow",
    "make the background warning-sign yellow",
    0xffff00,
  ),
  backgroundScenario(
    "edge-background-orange-brand",
    "restore the original brand-orange background",
    0xff5800,
  ),

  // Accent edits: broad predicates leave room for different exact shades.
  accentScenario(
    "edge-accent-cyan",
    "make the assistant accent glow cyan",
    (s) => {
      const [r, g, b] = s.theme.accent;
      return g > 0.55 && b > 0.55 && r < 0.35;
    },
  ),
  accentScenario("edge-accent-lime", "change the accent to lime green", (s) => {
    const [r, g, b] = s.theme.accent;
    return g > 0.65 && r > 0.35 && b < 0.25;
  }),
  accentScenario("edge-accent-rose", "make the accent soft rose pink", (s) => {
    const [r, g, b] = s.theme.accent;
    return r > 0.65 && b > 0.35 && g < r;
  }),
  accentScenario("edge-accent-gold", "change the accent to gold", (s) => {
    const [r, g, b] = s.theme.accent;
    return r > 0.75 && g > 0.55 && b < 0.25;
  }),
  accentScenario(
    "edge-accent-ice-blue",
    "make the accent an icy pale blue",
    (s) => {
      const [r, g, b] = s.theme.accent;
      return b > 0.65 && g > 0.45 && r < b;
    },
  ),
  accentScenario(
    "edge-accent-red",
    "change only the accent to alert red",
    (s) => {
      const [r, g, b] = s.theme.accent;
      return r > 0.75 && g < 0.25 && b < 0.25;
    },
  ),
  accentScenario(
    "edge-accent-violet",
    "make the accent violet instead of orange",
    (s) => {
      const [r, g, b] = s.theme.accent;
      return r > 0.35 && b > 0.55 && g < 0.35;
    },
  ),
  accentScenario("edge-accent-teal", "switch the accent to teal", (s) => {
    const [r, g, b] = s.theme.accent;
    return g > 0.4 && b > 0.35 && r < 0.25;
  }),
  accentScenario("edge-accent-white", "make the accent clean white", (s) => {
    const [r, g, b] = s.theme.accent;
    return r > 0.85 && g > 0.85 && b > 0.85;
  }),
  accentScenario(
    "edge-accent-keep-background",
    "make the accent blue but keep the current background color",
    (s) => {
      const [r, _g, b] = s.theme.accent;
      return (
        b > 0.55 &&
        r < b &&
        s.theme.background === createDefaultScene().theme.background
      );
    },
  ),

  // Block layout, hiding, collapsing, and visual overrides.
  blockScenario(
    "edge-hide-apps",
    "hide the apps block so the canvas has more room",
    (s) => s.blocks.apps.layout.hidden,
  ),
  blockScenario(
    "edge-show-apps",
    "make sure the apps block is visible",
    (s) => !s.blocks.apps.layout.hidden,
  ),
  blockScenario(
    "edge-collapse-chat",
    "collapse the chat block into a small handle",
    (s) => s.blocks.chat.layout.collapsed,
  ),
  blockScenario(
    "edge-collapse-notifications",
    "collapse notifications but do not hide them",
    (s) =>
      s.blocks.notifications.layout.collapsed &&
      !s.blocks.notifications.layout.hidden,
  ),
  blockScenario(
    "edge-chat-top-left",
    "move chat to the top left corner",
    (s) => s.blocks.chat.layout.anchor === "top-left",
  ),
  blockScenario(
    "edge-chat-bottom-left",
    "move chat to the bottom left",
    (s) => s.blocks.chat.layout.anchor === "bottom-left",
  ),
  blockScenario(
    "edge-apps-bottom-center",
    "put apps at the bottom center",
    (s) => s.blocks.apps.layout.anchor === "bottom-center",
  ),
  blockScenario(
    "edge-notifications-bottom-right",
    "move notifications to the bottom right",
    (s) => s.blocks.notifications.layout.anchor === "bottom-right",
  ),
  blockScenario(
    "edge-chat-offset-up",
    "nudge the chat panel upward by about 80 pixels",
    (s) => s.blocks.chat.layout.offset.y < -40,
  ),
  blockScenario(
    "edge-apps-offset-right",
    "nudge the apps block to the right without changing its anchor",
    (s) => s.blocks.apps.layout.offset.x > 20,
  ),
  blockScenario(
    "edge-rounder-chat",
    "make the chat panel corners noticeably rounder",
    (s) => (s.blocks.chat.theme.radius ?? 0) >= 12,
  ),
  blockScenario(
    "edge-frosted-apps",
    "make the apps block more frosted and blurry",
    (s) => (s.blocks.apps.theme.blur ?? 0) >= 8,
  ),

  // Create-mode coverage: realistic visual requests with broad renderability checks.
  createSceneScenario(
    "edge-create-radar",
    "create a green radar sweep interface that reacts to voice energy",
    scriptScene,
  ),
  createSceneScenario(
    "edge-create-orbit-map",
    "create an orbital map with small nodes circling the assistant",
    scriptScene,
  ),
  createSceneScenario(
    "edge-create-rain-window",
    "create a rainy cyberpunk window scene with slow droplets",
    scriptScene,
  ),
  createSceneScenario(
    "edge-create-audio-rings",
    "create concentric rings that expand when either user or assistant audio is active",
    scriptScene,
  ),
  createSceneScenario(
    "edge-create-minimal-focus",
    "create a minimal distraction-free focus scene",
    renderableScene,
  ),
  createSceneScenario(
    "edge-create-retro-terminal",
    "create a retro terminal homescreen with subtle scanlines",
    scriptScene,
  ),
  createSceneScenario(
    "edge-create-solar-system",
    "create a tiny solar-system scene with slow orbiting planets",
    scriptScene,
  ),
  createSceneScenario(
    "edge-create-particle-nebula",
    "create a purple particle nebula that stays lightweight",
    scriptScene,
  ),
  createSceneScenario(
    "edge-create-glass-dashboard",
    "create a glass dashboard background with soft depth",
    renderableScene,
  ),
  createSceneScenario(
    "edge-create-meditation",
    "create a calm meditation scene with a slow breathing glow",
    scriptScene,
  ),
  createSceneScenario(
    "edge-create-night-drive",
    "create a night-drive dashboard vibe with moving horizon lights",
    scriptScene,
  ),
  createSceneScenario(
    "edge-create-ocean-depths",
    "create an ocean-depths scene with slow drifting light beams",
    scriptScene,
  ),

  // Boundary behavior: keep valid JSON, preserve renderability, and use script when required by live inputs.
  createSceneScenario(
    "edge-react-listening-phase",
    "create a scene that visibly changes when inputs.phase is listening",
    scriptScene,
  ),
  createSceneScenario(
    "edge-react-speaking-phase",
    "create a scene that pulses when the assistant is speaking",
    scriptScene,
  ),
  createSceneScenario(
    "edge-react-pointer",
    "create a scene where the pointer position gently pulls particles around",
    scriptScene,
  ),
  createSceneScenario(
    "edge-react-frequency-bands",
    "create an equalizer background driven by low, mid, and high frequency bands",
    scriptScene,
  ),
  createSceneScenario(
    "edge-performance-low-poly",
    "create a low-poly scene with an optimize(tier) method for slow devices",
    scriptScene,
  ),
  {
    id: "edge-edit-preserve-renderable-after-complex-request",
    mode: "edit",
    request:
      "make it feel like a holographic command center, but keep it valid and renderable",
    base: createDefaultScene,
    intent: renderableScene,
  },
];

if (EXPANDED_SCENARIOS.length !== BASE_SCENARIOS.length * 10) {
  throw new Error(
    `homescreen scenario expansion must add exactly 10x (${BASE_SCENARIOS.length * 10}); got ${EXPANDED_SCENARIOS.length}`,
  );
}

const SCENARIOS: Scenario[] = [...BASE_SCENARIOS, ...EXPANDED_SCENARIOS];
const EVAL_SCENARIOS =
  Number.isFinite(MAX_SCENARIOS) && MAX_SCENARIOS > 0
    ? SCENARIOS.slice(0, MAX_SCENARIOS)
    : SCENARIOS;

if (COUNT_SCENARIOS) {
  console.log(
    JSON.stringify(
      {
        suite: "homescreen",
        existing: BASE_SCENARIOS.length,
        added: EXPANDED_SCENARIOS.length,
        total: SCENARIOS.length,
        multiplierAdded: EXPANDED_SCENARIOS.length / BASE_SCENARIOS.length,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (VALIDATE_SCENARIOS) {
  const ids = new Set<string>();
  const duplicates = SCENARIOS.filter((s) => {
    if (ids.has(s.id)) return true;
    ids.add(s.id);
    return false;
  }).map((s) => s.id);
  const badModes = SCENARIOS.filter(
    (s) => s.mode !== "edit" && s.mode !== "create",
  ).map((s) => s.id);
  if (duplicates.length || badModes.length) {
    console.error(
      JSON.stringify({ suite: "homescreen", duplicates, badModes }, null, 2),
    );
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      {
        suite: "homescreen",
        valid: true,
        scenarios: SCENARIOS.length,
        uniqueIds: ids.size,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (!API_KEY) {
  console.error("CEREBRAS_API_KEY is required.");
  process.exit(1);
}

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
  for (const scenario of EVAL_SCENARIOS) {
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
    `\nReal-Cerebras proof · model ${MODEL} · ${EVAL_SCENARIOS.length}${EVAL_SCENARIOS.length !== SCENARIOS.length ? `/${SCENARIOS.length}` : ""} scenarios\n`,
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
