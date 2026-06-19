/**
 * Why small/local models need MULTI-SHOT demos as CHAT TURNS (not a system-prompt
 * "Demonstrations:" block) for action routing.
 *
 * Finding (eliza-1-0_8b, English view-switching, schema-constrained decode):
 *   - prompt-only optimization (instruction rewrite / GEPA / bootstrap demos in a
 *     system block) is FLAT — the 0.8B ignores system-prompt guidance.
 *   - the SAME demos placed as prior user/assistant conversation turns ~2x the
 *     score (0.25 -> ~0.58). The 0.8B pattern-matches on in-context turns it
 *     cannot follow as a system instruction.
 *   - it still plateaus ~0.5-0.6 and is phrasing-fragile (does not generalize the
 *     "nav intent -> VIEWS" rule, and MORE demos can hurt) — which is why the
 *     production fix for the 0.8B is the deterministic view-navigation evaluator
 *     (resolveIntentView: 100%, multilingual, phrasing-robust), not the model.
 *
 * This is the reproducible evidence. It is a measurement script, not a product
 * path. Start a llama-server (see lib/llamacpp.ts), then run:
 *   LLAMACPP_URL=http://127.0.0.1:8080 LABEL=eliza-1-2b \
 *     bun run plugins/plugin-training/scripts/multishot-view-switching.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractPlannerAction,
  extractPlannerView,
  scorePlannerAction,
} from "../src/optimizers/scoring.js";

// llama.cpp llama-server (eliza fork), NOT Ollama. Start a server with one GGUF
// loaded; LABEL is for display only (the served model is whatever llama-server
// has). See lib/llamacpp.ts.
const LLAMACPP_URL = process.env.LLAMACPP_URL ?? "http://127.0.0.1:8080";
const LABEL = process.env.LABEL ?? "eliza-1-2b";
const DATASET = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "optimizers",
  "__fixtures__",
  "view-switching.action_planner.jsonl",
);
const VIEW_IDS = [
  "calendar",
  "inbox",
  "wallet",
  "finances",
  "todos",
  "goals",
  "health",
  "documents",
  "relationships",
  "focus",
  "companion",
  "task-coordinator",
  "none",
];
const SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["VIEWS", "REPLY"] },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["show"] },
        view: { type: "string", enum: VIEW_IDS },
      },
    },
    thought: { type: "string" },
  },
  required: ["action"],
};
const MULTILINGUAL =
  /mu[eé]strame|revisa mis|cu[aá]nto|gastado|montre-moi|ouvre mes|zeig mir|我的|待办/i;
const SYS =
  "You are the action planner. If the user asks to see/open/check/go to an app surface (calendar, inbox/messages/email, wallet, finances, todos, goals, health, documents, relationships, focus), set action=VIEWS with parameters.action=show and parameters.view=that surface. Otherwise action=REPLY.";

// Balanced demos (5 VIEWS / 4 REPLY) — the empirical sweet spot. Imbalance
// over-fires VIEWS on plain questions; >~10 demos starts to degrade.
const V = (view: string) => ({
  action: "VIEWS",
  parameters: { action: "show", view },
});
const R = { action: "REPLY", parameters: {} };
const DEMOS: Array<[string, object]> = [
  ["open my calendar", V("calendar")],
  ["check my messages", V("inbox")],
  ["show my wallet balance", V("wallet")],
  ["open my todos", V("todos")],
  ["go to my goals", V("goals")],
  ["tell me a joke", R],
  ["what is 2 plus 2", R],
  ["write a short story", R],
  ["thanks so much", R],
];
const DEMO_INPUTS = new Set(DEMOS.map((d) => d[0]));

async function call(
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const res = await fetch(`${LLAMACPP_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: "out", schema: SCHEMA, strict: true },
      },
      chat_template_kwargs: { enable_thinking: false },
      temperature: 0,
      max_tokens: 80,
    }),
  });
  if (!res.ok) throw new Error(`llama-server ${res.status}`);
  return (
    (
      (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      }
    ).choices?.[0]?.message?.content ?? ""
  );
}

function loadEnglish() {
  return readFileSync(DATASET, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const r = JSON.parse(l) as {
        request: { messages: Array<{ content: string }> };
        response: { text: string };
      };
      return {
        user: r.request.messages.at(-1)?.content ?? "",
        expected: r.response.text,
      };
    })
    .filter((e) => !MULTILINGUAL.test(e.user) && !DEMO_INPUTS.has(e.user));
}

async function main() {
  const english = loadEnglish();
  console.log(
    `${LABEL}: eval on ${english.length} english rows (demos excluded)`,
  );
  const demoTurns = DEMOS.flatMap(([u, o]) => [
    { role: "user", content: u },
    { role: "assistant", content: JSON.stringify(o) },
  ]);
  let single = 0;
  let multi = 0;
  for (const ex of english) {
    const s = await call([
      { role: "system", content: SYS },
      { role: "user", content: ex.user },
    ]);
    const m = await call([
      { role: "system", content: SYS },
      ...demoTurns,
      { role: "user", content: ex.user },
    ]);
    const ss = scorePlannerAction(s, ex.expected);
    const ms = scorePlannerAction(m, ex.expected);
    single += ss;
    multi += ms;
    const tag = ms > ss ? "  ↑MULTI" : ms < ss ? "  ↓multi" : "";
    console.log(
      `  [${ex.user}] single=${ss} (${extractPlannerAction(s)}/${extractPlannerView(s)}) multi=${ms} (${extractPlannerAction(m)}/${extractPlannerView(m)})${tag}`,
    );
  }
  console.log(
    `\n  SINGLE-shot english = ${(single / english.length).toFixed(3)}`,
  );
  console.log(`  MULTI-shot  english = ${(multi / english.length).toFixed(3)}`);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
