/**
 * End-to-end prompt optimization eval harness v2.
 *
 * Runs GEPA over 5 core tasks with 5 experiments (generations) per prompt.
 * Uses LLM-as-judge for open-ended response quality tasks, exact-match for
 * structured tasks. Exports trajectories + per-task optimized prompts.
 *
 * Usage:
 *   CEREBRAS_API_KEY=csk-... bun run scripts/eval-prompts.ts
 *
 * Env:
 *   CEREBRAS_API_KEY   — required
 *   CEREBRAS_MODEL     — default gpt-oss-120b
 *   EVAL_OPTIMIZER     — gepa | bootstrap-fewshot (default gepa)
 *   GEPA_GENERATIONS   — default 5
 *   GEPA_POPULATION    — default 8
 *   EXPORT_DIR         — default /tmp/eliza-eval-<timestamp>
 *   EVAL_TASKS         — comma-separated task names to run (default: all)
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

interface LlmAdapter {
  complete(input: {
    system?: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<string>;
}

interface OptimizationExample {
  id?: string;
  input: { system?: string; user: string };
  expectedOutput: string;
  reward?: number;
  rubric?: string; // for LLM-as-judge
}

interface OptimizerResult {
  optimizedPrompt: string;
  score: number;
  baseline: number;
  lineage: Array<{ round: number; variant: number; score: number; notes?: string }>;
  fewShotExamples?: OptimizationExample[];
}

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface TrajectoryEntry {
  timestamp: string;
  task: string;
  optimizer: string;
  step: string;
  systemPrompt?: string;
  userInput?: string;
  output?: string;
  score?: number;
  tokenUsage?: TokenUsage;
  notes?: string;
}

// ── Config ───────────────────────────────────────────────────────────────────

const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY ?? "";
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL ?? "gpt-oss-120b";
const CEREBRAS_BASE_URL = process.env.CEREBRAS_BASE_URL ?? "https://api.cerebras.ai/v1";
const OPTIMIZER = (process.env.EVAL_OPTIMIZER ?? "gepa") as "gepa" | "bootstrap-fewshot";
const GEPA_GENERATIONS = parseInt(process.env.GEPA_GENERATIONS ?? "5", 10);
const GEPA_POPULATION = parseInt(process.env.GEPA_POPULATION ?? "8", 10);
const EXPORT_DIR = process.env.EXPORT_DIR ?? `/tmp/eliza-eval-${Date.now()}`;
const EVAL_TASKS = process.env.EVAL_TASKS?.split(",").map(t => t.trim()) ?? null;

if (!CEREBRAS_API_KEY) {
  console.error("CEREBRAS_API_KEY is required");
  process.exit(1);
}

// ── Token counting ────────────────────────────────────────────────────────────

function countTokensApprox(text: string): number {
  if (!text) return 0;
  const words = text.split(/\s+/).filter(Boolean);
  let count = 0;
  for (const word of words) {
    count += Math.ceil(word.length / 4);
  }
  return count;
}

interface TemplateTokenReport {
  templateTokens: number;
  userTokens: number;
  totalInputTokens: number;
}

function countPromptTokens(system: string | undefined, user: string): TemplateTokenReport {
  const templateTokens = countTokensApprox(system ?? "");
  const userTokens = countTokensApprox(user);
  return { templateTokens, userTokens, totalInputTokens: templateTokens + userTokens };
}

// ── Cerebras API client ───────────────────────────────────────────────────────

interface CerebrasResponse {
  text: string;
  usage: TokenUsage;
}

let totalApiCalls = 0;
let totalPromptTokens = 0;
let totalCompletionTokens = 0;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function callCerebras(
  system: string | undefined,
  user: string,
  temperature = 0,
  maxTokens = 1024,
  _retryCount = 0,
): Promise<CerebrasResponse> {
  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });

  const body: Record<string, unknown> = {
    model: CEREBRAS_MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (CEREBRAS_MODEL.startsWith("gpt-oss")) {
    body.reasoning_effort = "low";
  }

  const resp = await fetch(`${CEREBRAS_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CEREBRAS_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    // Retry on rate limit with exponential backoff
    if (resp.status === 429 && _retryCount < 6) {
      const backoffMs = Math.min(5000 * Math.pow(2, _retryCount), 60000);
      console.log(`    [rate-limit] 429 — waiting ${(backoffMs/1000).toFixed(0)}s (retry ${_retryCount + 1}/6)...`);
      await sleep(backoffMs);
      return callCerebras(system, user, temperature, maxTokens, _retryCount + 1);
    }
    throw new Error(`Cerebras error ${resp.status}: ${err.slice(0, 300)}`);
  }

  const data = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  const text = data.choices[0]?.message?.content ?? "";
  const usage: TokenUsage = {
    promptTokens: data.usage.prompt_tokens,
    completionTokens: data.usage.completion_tokens,
    totalTokens: data.usage.total_tokens,
  };

  totalApiCalls++;
  totalPromptTokens += usage.promptTokens;
  totalCompletionTokens += usage.completionTokens;

  return { text, usage };
}

// ── Scorers ────────────────────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s_-]+/g, " ").split(/\s+/).filter(t => t.length > 0),
  );
}

function jaccardScore(actual: string, expected: string): number {
  const a = tokenize(actual);
  const e = tokenize(expected);
  if (e.size === 0 && a.size === 0) return 1;
  if (e.size === 0 || a.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (e.has(t)) intersection++;
  const union = a.size + e.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function extractPlannerAction(text: string): string | null {
  try {
    const obj = JSON.parse(text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, ""));
    if (Array.isArray(obj.toolCalls) && obj.toolCalls[0]) {
      const name = obj.toolCalls[0].name ?? obj.toolCalls[0].action;
      if (typeof name === "string") return name.trim().toUpperCase();
    }
    const n = obj.action ?? obj.actionName ?? obj.name;
    if (typeof n === "string") return n.trim().toUpperCase();
  } catch {}
  const m = text.match(/\b([A-Z][A-Z0-9_]{2,})\b/);
  return m?.[1] ?? null;
}

// LLM-as-judge: scores 0.0-1.0
const JUDGE_SYSTEM = `Score the following AI assistant response on a scale from 0.0 to 1.0.

Rubric:
- 1.0: Perfect — answers the question accurately, concisely, and helpfully
- 0.8: Good — mostly correct, minor gaps or excess verbiage
- 0.6: Adequate — partially addresses the question but missing key points
- 0.4: Poor — tangential or superficially related but mostly unhelpful
- 0.2: Very poor — significantly off-topic or wrong
- 0.0: Fails completely

Output ONLY a decimal number (e.g. 0.8). No explanation.`;

// Strict judge for response quality — penalizes padding, preambles, hedging
const JUDGE_SYSTEM_RESPONSE = `Score the AI response quality strictly from 0.0 to 1.0. Be a tough grader.

AUTOMATIC PENALTIES (apply first, then score):
- Starts with "Sure!", "Certainly!", "Great question!", "Absolutely!", "Of course!", "Happy to help!" → cap at 0.5
- Contains "As an AI" or "language model" → cap at 0.4
- Ends with "I hope this helps" or "Let me know if you need anything" → subtract 0.15
- Has a preamble or acknowledgment before answering → subtract 0.2
- Unnecessary caveats or hedging when a direct answer exists → subtract 0.2

Scoring (after penalties):
- 1.0: Perfect — answers first, correct, concise, no padding whatsoever
- 0.8: Good — direct answer, maybe one unnecessary sentence
- 0.6: Correct answer buried in verbiage, or minor inaccuracy
- 0.4: Heavily padded or hedged but essentially correct
- 0.2: Wrong or majorly off-target
- 0.0: Factual error on a verifiable fact (wrong city as capital, wrong math answer, etc.)

IMPORTANT: If the question asks for a simple fact (capital city, math, yes/no) and the answer is wrong, output 0.0.

Output ONLY a decimal number. No explanation.`;

async function llmJudgeScore(userQuery: string, response: string, rubric?: string): Promise<number> {
  const judgeUser = `Question: ${userQuery}\n\nResponse: ${response}${rubric ? `\n\nAdditional rubric: ${rubric}` : ""}`;
  const { text } = await callCerebras(JUDGE_SYSTEM, judgeUser, 0, 512);
  const num = parseFloat(text.trim());
  if (isNaN(num) || num < 0 || num > 1) return 0.5;
  return num;
}

async function responseQualityScore(userQuery: string, response: string, rubric?: string): Promise<number> {
  const judgeUser = `Question: ${userQuery}\n\nResponse to grade: ${response}${rubric ? `\n\nSpec: ${rubric}` : ""}`;
  const { text } = await callCerebras(JUDGE_SYSTEM_RESPONSE, judgeUser, 0, 256);
  const num = parseFloat(text.trim());
  if (isNaN(num) || num < 0 || num > 1) return 0.5;
  return num;
}

// Struct-aware judge for tasks that require JSON output with specific structure
const JUDGE_SYSTEM_STRUCT = `Score the correctness of this AI response to 0.0–1.0.
The response should produce a specific JSON structure. Check against the rubric.

Scoring:
- 1.0: Correct op type, category, field values — exactly right
- 0.8: Mostly correct, minor field variation (e.g. slightly different keywords or wording)
- 0.6: Right op type but wrong category, or vice versa
- 0.4: Partially correct structure but meaningful errors
- 0.2: Wrong op entirely, or response fails to parse as valid JSON
- 0.0: Empty output when ops were needed, or ops when empty was correct

Output ONLY a decimal number. No explanation.`;

async function structJudgeScore(userContext: string, actual: string, rubric: string): Promise<number> {
  const judgeUser = `Context: ${userContext}\n\nActual output: ${actual}\n\nRubric: ${rubric}`;
  const { text } = await callCerebras(JUDGE_SYSTEM_STRUCT, judgeUser, 0, 256);
  const num = parseFloat(text.trim());
  if (isNaN(num) || num < 0 || num > 1) return 0.5;
  return num;
}

// Extract a named field from JSON output, returning lowercase string or null
function extractJsonField(text: string, field: string): string | null {
  try {
    const obj = JSON.parse(text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, ""));
    const val = obj[field];
    if (val !== undefined && val !== null) return String(val).toLowerCase().trim();
  } catch {}
  const m = text.match(new RegExp(`"${field}"\\s*:\\s*(?:"([^"]*)"|(true|false|\\d+))`));
  if (m) return ((m[1] ?? m[2]) ?? "").toLowerCase().trim();
  return null;
}

// Extract action name from autonomy decision output
function extractAutonomyAction(text: string): string | null {
  try {
    const obj = JSON.parse(text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, ""));
    if (Array.isArray(obj.actions) && obj.actions.length > 0 && obj.actions[0]?.name) {
      return (obj.actions[0].name as string).toUpperCase().trim();
    }
    if (Array.isArray(obj.actions) && obj.actions.length === 0) return "NONE";
    if (obj.action?.name) return (obj.action.name as string).toUpperCase().trim();
  } catch {}
  const m = text.match(/"name"\s*:\s*"([A-Z][A-Z0-9_]+)"/);
  if (m) return m[1]!;
  if (text.includes('"actions":[]') || text.includes('"actions": []')) return "NONE";
  return null;
}

// Tasks that use struct-aware LLM judge (complex JSON output)
const STRUCT_JUDGE_TASKS = new Set([
  "fact_extraction", "extract_action_params",
  "add_contact", "search_contacts", "schedule_follow_up",
  "extract_secrets", "custom_action_generate",
  "observation_extraction", "long_term_extraction", "extract_secret_operation",
]);

// Tasks that use exact-match on a single extracted JSON field
const FIELD_MATCH_TASKS: Record<string, string> = {
  update_role: "new_role",
  choose_option: "selected_id",
};

function buildScorer(task: string, _adapter: LlmAdapter, useJudge: boolean) {
  return async (prompt: string, examples: OptimizationExample[]): Promise<number> => {
    if (examples.length === 0) return 0;
    let total = 0;
    for (const ex of examples) {
      const resp = await callCerebras(prompt, ex.input.user, 0, 1024);
      const actual = resp.text;

      if (task === "action_planner" || task === "message_handler") {
        const a = extractPlannerAction(actual);
        const e = extractPlannerAction(ex.expectedOutput);
        total += a && e && a === e ? 1 : 0;

      } else if (task === "should_respond" || task === "should_respond_runtime") {
        const aYes = actual.toLowerCase().includes("yes") || actual.toLowerCase().includes("respond");
        const eYes = ex.expectedOutput.toLowerCase().includes("yes") || ex.expectedOutput.toLowerCase().includes("respond");
        const aVerdict = aYes && !actual.toLowerCase().includes("ignore") ? "yes" : "no";
        const eVerdict = eYes ? "yes" : "no";
        total += aVerdict === eVerdict ? 1 : 0;

      } else if (task === "autonomy_decision") {
        const expectedAction = extractAutonomyAction(ex.expectedOutput) ?? "NONE";
        const actualAction = extractAutonomyAction(actual) ?? "NONE";
        total += actualAction === expectedAction ? 1 : 0;

      } else if (
        task === "should_follow_room" || task === "should_mute_room" ||
        task === "should_unfollow_room" || task === "should_unmute_room"
      ) {
        const expectedDecision = extractJsonField(ex.expectedOutput, "decision");
        const actualDecision = extractJsonField(actual, "decision");
        total += expectedDecision !== null && actualDecision !== null && expectedDecision === actualDecision ? 1 : 0;

      } else if (task === "option_extraction") {
        const eTaskId = extractJsonField(ex.expectedOutput, "taskId");
        const aTaskId = extractJsonField(actual, "taskId");
        const eOpt = extractJsonField(ex.expectedOutput, "selectedOption");
        const aOpt = extractJsonField(actual, "selectedOption");
        const nullish = (v: string | null) => v === null || v === "null";
        const taskMatch = nullish(eTaskId) ? nullish(aTaskId) : eTaskId === aTaskId;
        const optMatch = nullish(eOpt) ? nullish(aOpt) : eOpt === aOpt;
        total += taskMatch && optMatch ? 1 : 0;

      } else if (FIELD_MATCH_TASKS[task]) {
        const field = FIELD_MATCH_TASKS[task]!;
        const expected = extractJsonField(ex.expectedOutput, field);
        const actual2 = extractJsonField(actual, field);
        total += expected !== null && actual2 !== null && expected === actual2 ? 1 : 0;

      } else if (STRUCT_JUDGE_TASKS.has(task)) {
        const score = await structJudgeScore(ex.input.user, actual, ex.rubric ?? ex.expectedOutput);
        total += score;

      } else if (useJudge) {
        const score = task === "response"
          ? await responseQualityScore(ex.input.user, actual, ex.rubric)
          : await llmJudgeScore(ex.input.user, actual, ex.rubric);
        total += score;

      } else {
        total += jaccardScore(actual, ex.expectedOutput);
      }
    }
    return total / examples.length;
  };
}

// ── Trajectories ──────────────────────────────────────────────────────────────

const trajectories: TrajectoryEntry[] = [];

function logTrajectory(entry: TrajectoryEntry) {
  trajectories.push(entry);
}

function exportTrajectories(dir: string) {
  mkdirSync(dir, { recursive: true });
  const jsonlPath = join(dir, "trajectories.jsonl");
  writeFileSync(jsonlPath, trajectories.map(t => JSON.stringify(t)).join("\n") + "\n", "utf-8");

  const readablePath = join(dir, "trajectories-readable.txt");
  const readable = trajectories.map(t => {
    const lines: string[] = [`─── ${t.timestamp} [${t.task}] ${t.optimizer} / ${t.step} ───`];
    if (t.score !== undefined) lines.push(`  score: ${t.score.toFixed(4)}`);
    if (t.tokenUsage) {
      lines.push(`  tokens: prompt=${t.tokenUsage.promptTokens} completion=${t.tokenUsage.completionTokens}`);
    }
    if (t.systemPrompt) lines.push(`  system: ${t.systemPrompt.slice(0, 250)}…`);
    if (t.userInput) lines.push(`  user: ${t.userInput.slice(0, 200)}`);
    if (t.output) lines.push(`  output: ${t.output.slice(0, 350)}`);
    if (t.notes) lines.push(`  notes: ${t.notes}`);
    return lines.join("\n");
  }).join("\n\n");
  writeFileSync(readablePath, readable + "\n", "utf-8");

  console.log(`\nTrajectories exported:`);
  console.log(`  JSONL:    ${jsonlPath}`);
  console.log(`  Readable: ${readablePath}`);
  return { jsonlPath, readablePath };
}

// ── GEPA Optimizer ────────────────────────────────────────────────────────────

const SYS_FEEDBACK = `Revise the SYSTEM PROMPT below based on observed failure analysis.

You will receive the current prompt and a short feedback note explaining what went wrong. Produce a revised prompt that addresses the feedback. Preserve the task contract (inputs, outputs, format) and every literal placeholder ({{agentName}}, {{providers}}, etc.) byte-identical. Output only the revised prompt body. No commentary, no fenced code blocks.`;

const SYS_COMPRESS = `Reduce the SYSTEM PROMPT below to its essentials.

Rewrite it shorter while preserving every contract guarantee. Drop redundant phrasing, collapse parallel rules, remove decorative bullets and meta-commentary. Keep every literal placeholder byte-identical. Output only the revised prompt body. No commentary, no fenced code blocks.`;

const SYS_CROSSOVER = `Merge two candidate SYSTEM PROMPTS into one.

You will receive PROMPT A and PROMPT B. Produce a single prompt that takes the strongest guidance from each. Preserve the task contract and every literal placeholder. Do not exceed 1.2x the longer parent's character count. Output only the merged prompt body. No commentary, no fenced code blocks.`;

const SYS_REFLECT = `Diagnose why a SYSTEM PROMPT is failing on these examples.

You will receive the prompt and examples showing: user input, actual output, expected output. Write a SHORT diagnostic (max 4 sentences) naming the concrete failure mode and one specific change to fix it. No filler. Output plain text only.`;

interface Candidate {
  prompt: string;
  score: number;
  tokens: number;
  feedback: string;
  origin: string;
}

function approxTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const puncts = (text.match(/[.,;:!?(){}[\]"'`]/g) ?? []).length;
  return words + Math.floor(puncts / 2);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function paretoFrontier(pool: Candidate[]): Candidate[] {
  const frontier: Candidate[] = [];
  for (const cur of pool) {
    let dominated = false;
    for (const other of pool) {
      if (other === cur) continue;
      if (
        (other.score > cur.score && other.tokens <= cur.tokens) ||
        (other.score >= cur.score && other.tokens < cur.tokens)
      ) {
        dominated = true;
        break;
      }
    }
    if (!dominated && !frontier.some(c => c.prompt === cur.prompt)) frontier.push(cur);
  }
  return frontier;
}

async function runGepa(
  task: string,
  baselinePrompt: string,
  dataset: OptimizationExample[],
  scorer: (p: string, ex: OptimizationExample[]) => Promise<number>,
  generations: number,
  population: number,
): Promise<OptimizerResult> {
  const lineage: Array<{ round: number; variant: number; score: number; notes?: string }> = [];
  const ts = () => new Date().toISOString();

  async function scoreAndReflect(prompt: string, origin: string, round: number, variant: number): Promise<Candidate> {
    const score = await scorer(prompt, dataset);
    logTrajectory({ timestamp: ts(), task, optimizer: "gepa", step: `gen${round}-score`, score, notes: `origin=${origin} variant=${variant} tokens=${approxTokens(prompt)}` });

    // Reflect: sample diverse examples — first 2 + last 2 to catch edge cases at both ends
    const n = dataset.length;
    const reflectSet = n <= 4
      ? dataset
      : [...dataset.slice(0, 2), ...dataset.slice(n - 2)];
    const batch = reflectSet.slice(0, 4);
    const transcripts: string[] = [];
    for (let i = 0; i < batch.length; i++) {
      const ex = batch[i]!;
      const { text: actual, usage } = await callCerebras(prompt, ex.input.user, 0, 1024);
      const tokenReport = countPromptTokens(prompt, ex.input.user);
      logTrajectory({
        timestamp: ts(), task, optimizer: "gepa", step: `gen${round}-example-${i}`,
        systemPrompt: prompt.slice(0, 400), userInput: ex.input.user.slice(0, 200), output: actual.slice(0, 350),
        tokenUsage: usage,
        notes: `template_tokens=${tokenReport.templateTokens} user_tokens=${tokenReport.userTokens} total_input=${tokenReport.totalInputTokens}`,
      });
      transcripts.push(
        `Example ${i + 1}:\nUser: ${truncate(ex.input.user, 300)}\nActual: ${truncate(actual, 300)}\nExpected: ${truncate(ex.expectedOutput, 300)}`
      );
    }
    const { text: feedback } = await callCerebras(
      SYS_REFLECT,
      `Prompt:\n${prompt}\n\n${transcripts.join("\n\n")}`,
      0.4, 512,
    );

    const note = origin === "baseline" ? "baseline"
      : origin.includes("compress") ? `${origin} | tokens=${approxTokens(prompt)}`
      : `${origin} | ${truncate(feedback, 80)}`;
    lineage.push({ round, variant, score, notes: note });
    return { prompt, score, tokens: approxTokens(prompt), feedback, origin };
  }

  async function mutate(prompt: string, feedback: string, mode: "feedback" | "compress"): Promise<string> {
    if (mode === "compress") {
      const { text } = await callCerebras(SYS_COMPRESS, prompt, 0.8, 1024);
      return text.trim() || prompt;
    }
    const { text } = await callCerebras(
      SYS_FEEDBACK,
      `Current prompt:\n${prompt}\n\nFailure analysis:\n${feedback || "(none — explore a rephrasing)"}`,
      0.8, 1024,
    );
    return text.trim() || prompt;
  }

  console.log(`\n  [GEPA] scoring baseline...`);
  const baseline = await scoreAndReflect(baselinePrompt, "baseline", 0, 0);
  let pool: Candidate[] = [baseline];

  // Seed population with diverse mutations
  for (let i = 1; i < population; i++) {
    const modes: Array<"feedback" | "compress"> = ["feedback", "compress", "feedback", "compress"];
    const mode = modes[(i - 1) % modes.length] ?? "feedback";
    const seed = await mutate(baselinePrompt, baseline.feedback, mode);
    pool.push(await scoreAndReflect(seed, `seed-${mode}-${i}`, 0, i));
  }

  for (let gen = 1; gen <= generations; gen++) {
    const best = Math.max(...pool.map(c => c.score));
    console.log(`  [GEPA] gen ${gen}/${generations} pool=${pool.length} best=${best.toFixed(4)}`);
    const frontier = paretoFrontier(pool);
    const next: Candidate[] = [...frontier];
    let vi = next.length;

    // Feedback mutations from frontier
    for (const parent of frontier) {
      if (next.length >= population) break;
      const child = await mutate(parent.prompt, parent.feedback, "feedback");
      next.push(await scoreAndReflect(child, "feedback-mut", gen, vi++));
    }

    // Compression mutations
    for (const parent of frontier) {
      if (next.length >= population) break;
      const comp = await mutate(parent.prompt, "", "compress");
      next.push(await scoreAndReflect(comp, "compress-mut", gen, vi++));
    }

    // Crossover from top 2
    if (next.length < population && frontier.length >= 2) {
      const sorted = [...frontier].sort((a, b) => b.score - a.score);
      const [a, b] = sorted;
      if (a && b && a.prompt !== b.prompt) {
        const { text: merged } = await callCerebras(
          SYS_CROSSOVER,
          `PROMPT A:\n${a.prompt}\n\nPROMPT B:\n${b.prompt}`,
          0.8, 1024,
        );
        next.push(await scoreAndReflect(merged.trim() || a.prompt, "crossover", gen, vi++));
      }
    }

    pool = next;
  }

  const finalFrontier = paretoFrontier(pool);
  const best = finalFrontier.reduce<Candidate>((acc, cur) => {
    if (cur.score > acc.score) return cur;
    if (cur.score === acc.score && cur.tokens < acc.tokens) return cur;
    return acc;
  }, finalFrontier[0] ?? pool[0]!);

  return { optimizedPrompt: best.prompt, score: best.score, baseline: baseline.score, lineage };
}

// ── Baseline prompts ──────────────────────────────────────────────────────────

const BASELINE_PROMPTS: Record<string, string> = {
  should_respond: `Decide whether to respond to this message.

Output YES if you should respond, or NO if you should not.

Consider:
- Is the message directed at you or relevant to you?
- Is the message a question or request that needs a response?
- Is the message in a group chat where your response adds value?

Output format: Just "YES" or "NO" on a single line.`,

  action_planner: `Select the next action to take based on the conversation context.

Available actions and when to use them:
- REPLY: Send a text response (greetings, factual answers, conversational responses)
- SEARCH: Look up information on the internet (current events, product info, unknown facts)
- SCHEDULE: Create a calendar event (meetings, appointments, time blocks)
- REMIND: Set a reminder (future tasks, time-based alerts, medication reminders)
- NOTES: Save a note or piece of information (ideas, lists, things to remember)
- NONE: No action needed — use when message is: emoji-only (👍, 🎉), single punctuation (. or ...), ambient acknowledgment with no request, or pure reaction content that needs no response

NONE examples: "👍", "...", ".", "👌", "ok cool" (with no follow-up ask), reactions to prior messages

Return ONLY a JSON object in this exact format:
{"toolCalls": [{"name": "ACTION_NAME", "args": {}}]}

No explanation. JSON only.`,

  // Intentionally verbose baseline — demonstrates GEPA can recover from bad prompting
  response: `When responding to user messages, always be warm and comprehensive. Begin every response by acknowledging the question, such as "Sure! I'd be happy to help with that!" or "Great question!". Then provide a thorough, multi-paragraph explanation with full background context and relevant considerations. Include appropriate caveats and qualifications where applicable. Conclude by inviting follow-up questions, e.g. "I hope this helps! Let me know if you have any other questions!"`,

  media_description: `Describe the media file (image, audio, or video).

Include:
- What is shown/heard
- Key visual elements, people, objects, or sounds
- Any text or labels visible
- The overall context or setting

Be objective and factual. Do not make assumptions beyond what is clearly present.`,

  // Real runtime prompt from elizaOS — shouldRespondTemplate (simplified for eval)
  should_respond_runtime: `task: Decide whether the agent should respond, ignore, or stop.

rules:
- direct mention of agent name -> RESPOND
- talking to someone else -> IGNORE unless agent is also directly addressed
- prior participation alone is not enough; newest message must clearly expect agent
- request to stop or be quiet directed at agent -> STOP
- in groups, if latest message is addressed to someone else, IGNORE
- when unsure, default IGNORE

Output ONLY one of: YES (respond) or NO (ignore/stop)`,

  // FACT_EXTRACTION_TEMPLATE baseline (real elizaOS template, Handlebars vars inlined as context in user turn)
  fact_extraction: `# Task: Classify and extract facts from this message

You maintain two fact stores. Decide what to insert, strengthen, decay, or contradict. Return JSON ops only.

Stores:
- durable: stable identity-level claims that matter in a year.
  Categories: identity, health, relationship, life_event, business_role, preference, goal.
- current: time-bound state about now or near term.
  Categories: feeling, physical_state, working_on, going_through, schedule_context.

Rules:
- If a claim feels stale or surprising to retrieve in a year, use current.
- Empty output is right for small talk or claim-free questions.
- Before add_durable/add_current, scan known facts. If meaning exists, emit strengthen with that factId.
- Paraphrases count as duplicates. Match meaning, not surface form.

Ops:
- add_durable: claim, category, structured_fields, keywords
- add_current: claim, category, structured_fields, keywords
- strengthen: factId, optional reason
- decay: factId, optional reason
- contradict: factId, reason, optional proposedText

For add_durable/add_current, include keywords: 3-8 lowercase retrieval terms.

Return {"ops":[]} when nothing to extract.
JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // INITIAL_SUMMARIZATION_TEMPLATE baseline
  conversation_summary: `# Task: Summarize Conversation

Create a concise summary capturing key points, topics, and details.

# Instructions
Generate a summary that:
1. Captures main topics
2. Highlights key information
3. Notes decisions and questions
4. Maintains context for future reference
5. Is concise but comprehensive

Also extract:
- topics: main topics (array)
- keyPoints: important facts or decisions (array)

JSON:
text: Your comprehensive summary here
topics: [topic1, topic2]
keyPoints: [First key point, Second key point]

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // AUTONOMY_CONTINUOUS_CONTINUE_TEMPLATE baseline
  autonomy_decision: `Your job: reflect on context, decide what you want to do next, and act if appropriate.
- Use available actions/tools when they can advance the goal.
- Do NOT speak out loud. This loop is internal-only.
- Output structure: a JSON object with a thought field plus an optional actions list.
- If you don't need to make a change this round, take no action and output only the thought field with an empty actions value.
- If you cannot act, explain what is missing inside thought and take no action.
- Keep the response concise, focused on the next action.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // EXTRACT_ACTION_PARAMS_TEMPLATE baseline
  extract_action_params: `Extract missing parameter values for an action from the conversation context.

The action name and description are provided. Fill in ONLY the missing required fields from context.
If a value is genuinely indeterminable from the conversation, return null for that field.

Return a JSON object containing values for the missing fields only.
JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // REPLY_TEMPLATE baseline — generates agent dialog
  reply: `Generate the next message in the conversation.

Write a natural, helpful reply to the user's message. Be direct and conversational.

JSON:
thought: Your brief reasoning
text: Your message to the user

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // OBSERVATION_EXTRACTION_TEMPLATE baseline
  observation_extraction: `Extract durable observations about the user from recent conversation exchanges.

Categories to look for:
- Preferences (tools, languages, workflows, communication style)
- Facts (role, location, projects they work on, tech stack)
- Standing instructions (things they always/never want)
- Patterns (recurring topics, how they like to work)

Return a JSON array of short observation strings (max 150 chars each).
If nothing meaningful is found, return an empty array [].
Do NOT include observations about the conversation itself, only about the user.

JSON only. Return one JSON array. No prose, fences, thinking, or markdown.`,

  // MEMORY_CONTEXT_QA_TEMPLATE baseline
  memory_qa: `Answer the query using only the provided context. If context is insufficient, say so explicitly.
Keep the answer under 120 words.

JSON only. Return one JSON object with an "answer" field. No prose, fences, thinking, or markdown.`,

  // CHOOSE_OPTION_TEMPLATE baseline
  choose_option: `Select the most appropriate option from the available choices based on context.

Provide reasoning and the selected option ID.

JSON:
thought: Your reasoning for the selection
selected_id: The ID of the selected option

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // REFLECTION_TEMPLATE baseline
  reflection: `Analyze recent agent behavior and interactions.

Consider:
1. Communication clarity and helpfulness
2. Context appropriateness
3. Mistakes made
4. Improvements possible

JSON:
thought: Your detailed analysis
quality_score: Score 0-100
strengths: What went well
improvements: What could be improved
learnings: Key takeaways

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // UPDATE_SUMMARIZATION_TEMPLATE baseline
  update_summarization: `Update and condense the existing conversation summary with new messages.

Merge existing summary + new message insights. Remove redundant details. Keep important context.
Keep the updated summary under 2500 tokens.

JSON:
text: Your updated summary
topics: [topic1, topic2]
keyPoints: [key point 1, key point 2]

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // LONG_TERM_EXTRACTION_TEMPLATE baseline
  long_term_extraction: `Extract long-term memory items from this conversation.

Only extract critical, persistent user info using these categories:
- EPISODIC: specific events with temporal context (who did what, when/where)
- SEMANTIC: stable facts about the user (role, expertise, identity)
- PROCEDURAL: skills and workflows demonstrated 3+ times or explicitly stated

STRICT criteria: default to NOT extracting. Require overwhelming evidence.
Single mentions, casual conversation, temporary state → do NOT extract.

Return memories array or empty array if nothing qualifies.

JSON:
memories[0]:
  category: semantic|episodic|procedural
  content: The fact
  confidence: 0.85-1.0

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // IMAGE_GENERATION_TEMPLATE baseline
  image_generation: `Generate an image prompt based on the conversation context.

Create a specific, detailed image-generation prompt that captures the visual concept discussed.

JSON:
thought: Your reasoning for the image prompt
prompt: Detailed image generation prompt

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // POST_CREATION_TEMPLATE baseline
  post_creation: `Create a social media post about the given topic.

Requirements:
- 1-3 sentences (random length)
- No questions. Brief, concise statements only.
- Total character count under 280
- No emojis
- Write in first-person perspective

JSON:
thought: What you're thinking about
post: The post text

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // CUSTOM_ACTION_GENERATE_TEMPLATE baseline
  custom_action_generate: `Generate a custom action definition from the user's description.

Return a JSON object with:
- name: UPPER_SNAKE_CASE action name
- description: what the action does
- handlerType: "http" | "shell" | "code"
- handler: object with type-specific fields
- parameters: array of {name, description, required}

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // SHOULD_FOLLOW_ROOM_TEMPLATE baseline
  should_follow_room: `Decide whether the agent should follow this room.

Return true only when the user clearly asks the agent to follow this room.
Return false when the request is ambiguous or unrelated.
Default to false when uncertain.

JSON:
decision: true|false

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // SHOULD_MUTE_ROOM_TEMPLATE baseline
  should_mute_room: `Decide whether the agent should mute this room.

Return true only when the user clearly asks the agent to mute this room.
Return false when the request is ambiguous or unrelated.
Default to false when uncertain.

JSON:
decision: true|false

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // SHOULD_UNFOLLOW_ROOM_TEMPLATE baseline
  should_unfollow_room: `Decide whether the agent should unfollow this room.

Return true only when the user clearly asks the agent to unfollow or leave this room.
Return false when the request is ambiguous or unrelated.
Default to false when uncertain.

JSON:
decision: true|false

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // SHOULD_UNMUTE_ROOM_TEMPLATE baseline
  should_unmute_room: `Decide whether the agent should unmute this room.

Return true only when the user clearly asks the agent to unmute this room.
Return false when the request is ambiguous or unrelated.
Default to false when uncertain.

JSON:
decision: true|false

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // ADD_CONTACT_TEMPLATE baseline
  add_contact: `Extract contact information to add to relationships from the user's message.

Identify the contact name, categories, notes, timezone, and language when clearly present.
Include a short reason for saving this contact.

JSON:
contactName: Name of the contact
entityId: null or UUID if known
categories: comma-separated (vip, colleague, friend, etc.)
notes: relevant notes if present
reason: why to save this contact

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // SEARCH_CONTACTS_TEMPLATE baseline
  search_contacts: `Extract contact search criteria from the user's message.

Identify the search intent and any filters mentioned.

JSON:
categories: comma-separated filter list (if any)
tags: comma-separated tag filter (if any)
searchTerm: name or free-text lookup (if any)
intent: count|list

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // SCHEDULE_FOLLOW_UP_TEMPLATE baseline
  schedule_follow_up: `Extract follow-up scheduling information from the user's request.

Identify who to follow up with, when, why, and at what priority.

JSON:
contactName: Who to follow up with
scheduledAt: ISO datetime (or null if unclear)
reason: Why following up
priority: high|medium|low
message: Specific message to include (if requested)

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // EXTRACT_SECRET_OPERATION_TEMPLATE baseline
  extract_secret_operation: `Determine the secret management operation from the user's message.

Operations:
- get: Retrieve a secret value
- set: Store a new secret
- delete: Remove a secret
- list: Show all secrets
- check: Check if a secret exists

JSON:
operation: get|set|delete|list|check
key: SECRET_KEY_NAME (if applicable)
value: secret_value (for set only)

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // EXTRACT_SECRETS_TEMPLATE baseline
  extract_secrets: `Extract secret/configuration values from the user's message.

Identify the secret key name (UPPERCASE_WITH_UNDERSCORES) and value.
Infer key name from context if not explicitly stated.

JSON:
secrets[0]:
  key: SECRET_KEY_NAME
  value: the_value
  type: api_key|secret|credential|url|config

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // OPTION_EXTRACTION_TEMPLATE baseline
  option_extraction: `Extract the selected task and option from the user's message.

Match against available tasks and options. Return task ID and option name exactly as listed.
Return null for both if no clear selection.

JSON:
taskId: string_or_null
selectedOption: OPTION_NAME_or_null

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,

  // UPDATE_ROLE_TEMPLATE baseline
  update_role: `Extract the role change request from the user's message.

Normalize new_role to: OWNER, ADMIN, MEMBER, GUEST, or NONE.
Only identify single entity whose role changes.

JSON:
thought: Brief description of the change
entity_id: UUID or null
new_role: OWNER|ADMIN|MEMBER|GUEST|NONE

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.`,
};

// ── Synthetic training examples ───────────────────────────────────────────────

const SYNTHETIC_DATASETS: Record<string, OptimizationExample[]> = {
  should_respond: [
    { id: "sr-1", input: { user: "@assistant can you help me schedule a meeting for tomorrow at 3pm?" }, expectedOutput: "YES", reward: 1 },
    { id: "sr-2", input: { user: "Hey John, can you grab lunch today?" }, expectedOutput: "NO", reward: 0 },
    { id: "sr-3", input: { user: "What time is it in Tokyo right now?" }, expectedOutput: "YES", reward: 1 },
    { id: "sr-4", input: { user: "lol that's hilarious" }, expectedOutput: "NO", reward: 0 },
    { id: "sr-5", input: { user: "I was talking to the assistant yesterday and it helped me" }, expectedOutput: "NO", reward: 0 },
    { id: "sr-6", input: { user: "Anyone else going to the party tonight?" }, expectedOutput: "NO", reward: 0 },
    { id: "sr-7", input: { user: "Hey assistant, can you summarize this article for me?" }, expectedOutput: "YES", reward: 1 },
    { id: "sr-8", input: { user: "The meeting got moved to 4pm" }, expectedOutput: "NO", reward: 0 },
    { id: "sr-9", input: { user: "Can someone look up the flight status for AA 1234?" }, expectedOutput: "YES", reward: 1 },
    { id: "sr-10", input: { user: "alice: did you get my email? bob: yeah got it" }, expectedOutput: "NO", reward: 0 },
    { id: "sr-11", input: { user: "Can you help me write an email to my boss?" }, expectedOutput: "YES", reward: 1 },
    { id: "sr-12", input: { user: "Does anyone know where the conference room is?" }, expectedOutput: "YES", reward: 1 },
    { id: "sr-13", input: { user: "ok ttyl everyone" }, expectedOutput: "NO", reward: 0 },
    { id: "sr-14", input: { user: "The report needs to be sent by Friday" }, expectedOutput: "NO", reward: 0 },
    { id: "sr-15", input: { user: "assistant what day of the week is it?" }, expectedOutput: "YES", reward: 1 },
    { id: "sr-16", input: { user: "🎉🎊🥳" }, expectedOutput: "NO", reward: 0 },
    // Additional harder examples
    { id: "sr-17", input: { user: "Can the AI look into this?" }, expectedOutput: "YES", reward: 1 },
    { id: "sr-18", input: { user: "Someone should check the server logs" }, expectedOutput: "NO", reward: 0 },
    { id: "sr-19", input: { user: "bot, what's 2+2?" }, expectedOutput: "YES", reward: 1 },
    { id: "sr-20", input: { user: "Thanks for your help earlier, chat!" }, expectedOutput: "NO", reward: 0 },
  ],

  action_planner: [
    { id: "ap-1", input: { user: "User wants to schedule a dentist appointment for next Tuesday at 2pm." }, expectedOutput: '{"toolCalls":[{"name":"SCHEDULE","args":{}}]}', reward: 1 },
    { id: "ap-2", input: { user: "User asked what the weather is like today in San Francisco." }, expectedOutput: '{"toolCalls":[{"name":"SEARCH","args":{}}]}', reward: 1 },
    { id: "ap-3", input: { user: "User said hello and asked how you're doing." }, expectedOutput: '{"toolCalls":[{"name":"REPLY","args":{}}]}', reward: 1 },
    { id: "ap-4", input: { user: "User wants to be reminded to call their doctor in 2 hours." }, expectedOutput: '{"toolCalls":[{"name":"REMIND","args":{}}]}', reward: 1 },
    { id: "ap-5", input: { user: "User wants to save a note about a new project idea: a mobile app for tracking workouts." }, expectedOutput: '{"toolCalls":[{"name":"NOTES","args":{}}]}', reward: 1 },
    { id: "ap-6", input: { user: "User said goodbye and that they'll talk later." }, expectedOutput: '{"toolCalls":[{"name":"REPLY","args":{}}]}', reward: 1 },
    { id: "ap-7", input: { user: "User wants to find restaurants near downtown Seattle." }, expectedOutput: '{"toolCalls":[{"name":"SEARCH","args":{}}]}', reward: 1 },
    { id: "ap-8", input: { user: "User wants a reminder to submit the quarterly report on Friday at 5pm." }, expectedOutput: '{"toolCalls":[{"name":"REMIND","args":{}}]}', reward: 1 },
    { id: "ap-9", input: { user: "User is asking who won the Super Bowl last year." }, expectedOutput: '{"toolCalls":[{"name":"SEARCH","args":{}}]}', reward: 1 },
    { id: "ap-10", input: { user: "User says 'block off 2-3pm Thursday for a team sync'." }, expectedOutput: '{"toolCalls":[{"name":"SCHEDULE","args":{}}]}', reward: 1 },
    { id: "ap-11", input: { user: "User wants to jot down that they need to pick up milk and eggs." }, expectedOutput: '{"toolCalls":[{"name":"NOTES","args":{}}]}', reward: 1 },
    { id: "ap-12", input: { user: "User just sent a thumbs up emoji." }, expectedOutput: '{"toolCalls":[{"name":"NONE","args":{}}]}', reward: 0 },
    // Extended coverage — edge cases and ambiguous scenarios
    { id: "ap-13", input: { user: "User typed '...' with no other text." }, expectedOutput: '{"toolCalls":[{"name":"NONE","args":{}}]}', reward: 0 },
    { id: "ap-14", input: { user: "User wants to look up today's top news headlines." }, expectedOutput: '{"toolCalls":[{"name":"SEARCH","args":{}}]}', reward: 1 },
    { id: "ap-15", input: { user: "User says 'note to self: buy birthday card for mom before Saturday'." }, expectedOutput: '{"toolCalls":[{"name":"NOTES","args":{}}]}', reward: 1 },
    { id: "ap-16", input: { user: "User asks 'what time is it?'" }, expectedOutput: '{"toolCalls":[{"name":"REPLY","args":{}}]}', reward: 1 },
    { id: "ap-17", input: { user: "User wants to put a 1-hour lunch break on their calendar for tomorrow at noon." }, expectedOutput: '{"toolCalls":[{"name":"SCHEDULE","args":{}}]}', reward: 1 },
    { id: "ap-18", input: { user: "User typed a single period '.' with nothing else." }, expectedOutput: '{"toolCalls":[{"name":"NONE","args":{}}]}', reward: 0 },
    { id: "ap-19", input: { user: "User wants to search for the best TypeScript ORM libraries in 2025." }, expectedOutput: '{"toolCalls":[{"name":"SEARCH","args":{}}]}', reward: 1 },
    { id: "ap-20", input: { user: "User wants a reminder in 30 minutes to take their medication." }, expectedOutput: '{"toolCalls":[{"name":"REMIND","args":{}}]}', reward: 1 },
  ],

  response: [
    { id: "resp-1", input: { user: "What's the best way to learn programming?" }, expectedOutput: "Start with Python — clear syntax, huge ecosystem. Build small projects immediately, practice daily. Codecademy, freeCodeCamp, or just pick a project you care about.", reward: 1, rubric: "Direct, concrete advice with resources. No preamble. No 'Great question!'" },
    { id: "resp-2", input: { user: "Can you explain what machine learning is in simple terms?" }, expectedOutput: "Machine learning is teaching computers to learn patterns from examples rather than programming explicit rules. Show it a million cat photos and it learns to recognize cats.", reward: 1, rubric: "One analogy, no jargon. No 'Sure, I'd be happy to explain!'" },
    { id: "resp-3", input: { user: "What are some healthy breakfast options?" }, expectedOutput: "Oatmeal with berries, eggs with vegetables, Greek yogurt with nuts, whole grain toast with avocado. All provide protein + fiber to keep you full.", reward: 1, rubric: "List 4-5 concrete options directly. No preamble." },
    { id: "resp-4", input: { user: "How do I improve my time management skills?" }, expectedOutput: "Time block your calendar — assign specific tasks to specific slots. Use Pomodoro (25-min work, 5-min break). Kill your phone notifications during focus time.", reward: 1, rubric: "Concrete named techniques. No hedging. No 'That's a great question!'" },
    { id: "resp-5", input: { user: "What's 15% of 240?" }, expectedOutput: "36.", reward: 1, rubric: "CRITICAL: Must be exactly 36. Single word answer acceptable. No math explanation unless 1 line. Do NOT say 'Sure! I'd be happy to calculate that!'" },
    { id: "resp-6", input: { user: "What is the capital of Australia?" }, expectedOutput: "Canberra.", reward: 1, rubric: "CRITICAL: Must say Canberra. Sydney is WRONG. One word answer is fine. No preamble." },
    { id: "resp-7", input: { user: "What's the difference between a CPU and a GPU?" }, expectedOutput: "CPU: few powerful cores, great for sequential tasks. GPU: thousands of small cores, great for parallel work like graphics and ML. Same silicon, different architecture.", reward: 1, rubric: "Direct comparison, no preamble. Should be 2-3 sentences max." },
    { id: "resp-8", input: { user: "How do you make a basic vinaigrette?" }, expectedOutput: "1 part vinegar + 3 parts olive oil + salt + pepper. Add a teaspoon of Dijon to emulsify. Whisk or shake to combine.", reward: 1, rubric: "Specific ratios. No 'I'd be happy to help with that recipe!'" },
    { id: "resp-9", input: { user: "Is 7 × 8 equal to 54 or 56?" }, expectedOutput: "56.", reward: 1, rubric: "CRITICAL: Must be 56. Direct answer, no preamble." },
    { id: "resp-10", input: { user: "What should I do if I can't sleep at night?" }, expectedOutput: "Consistent sleep schedule, no screens 1 hour before bed, room cool and dark (65-68°F), no caffeine after 2pm. Avoid lying in bed awake — get up and do something quiet.", reward: 1, rubric: "Specific, actionable tips. No unnecessary intro sentence." },
    { id: "resp-11", input: { user: "Convert 100 Fahrenheit to Celsius." }, expectedOutput: "37.8°C", reward: 1, rubric: "CRITICAL: Formula is (F-32)×5/9. Must be approximately 37.8. No 'Great question!'" },
    { id: "resp-12", input: { user: "Name the three primary colors." }, expectedOutput: "Red, yellow, and blue.", reward: 1, rubric: "Must name all three correctly. No preamble, no filler, no 'Of course!'" },
  ],

  media_description: [
    { id: "md-1", input: { user: "[Image: A golden retriever puppy playing in autumn leaves in a park]" }, expectedOutput: "A golden retriever puppy playing energetically in a pile of colorful autumn leaves in a park. The puppy appears joyful with leaves scattered around. Fall foliage visible in the background.", reward: 1, rubric: "Should describe subject, setting, mood, and visual details" },
    { id: "md-2", input: { user: "[Image: A downtown city skyline at sunset with buildings reflected in water]" }, expectedOutput: "A city skyline at sunset showing tall buildings. The golden and orange sky reflects in the water below, creating a mirror image. Multiple high-rise buildings visible.", reward: 1, rubric: "Should capture the key visual elements: skyline, sunset colors, reflection" },
    { id: "md-3", input: { user: "[Image: A kitchen with modern appliances, marble countertops, and pendant lighting]" }, expectedOutput: "A modern kitchen featuring marble countertops, high-end appliances, and pendant lights. Clean, contemporary design with organized layout.", reward: 1, rubric: "Should identify the style and key design elements" },
    { id: "md-4", input: { user: "[Image: A woman in athletic gear running on a trail through a forest]" }, expectedOutput: "A woman in athletic/running gear running on a trail through a forested area. She appears mid-stride. Trees line the trail on both sides.", reward: 1, rubric: "Should describe subject, action, setting clearly" },
    { id: "md-5", input: { user: "[Audio: Rain sounds with occasional thunder in the background]" }, expectedOutput: "Audio featuring steady rainfall sounds with intermittent thunder. The rain creates a consistent backdrop while thunder provides deeper rumbling sounds at irregular intervals.", reward: 1, rubric: "Should describe the sounds, their pattern, and the overall ambiance" },
    { id: "md-6", input: { user: "[Image: A charcuterie board with cheeses, meats, fruits, and crackers]" }, expectedOutput: "A charcuterie board with various cheeses, cured meats, fresh and dried fruits, and crackers. Items are artfully arranged on a wooden board for sharing.", reward: 1, rubric: "Should list the types of items and describe the presentation" },
    { id: "md-7", input: { user: "[Image: A white cat sleeping on a red couch near a sunny window]" }, expectedOutput: "A white cat sleeping peacefully on a red couch positioned near a window with natural sunlight streaming in. The scene has a warm, cozy atmosphere.", reward: 1, rubric: "Should describe the animal, position, furniture, and lighting" },
    { id: "md-8", input: { user: "[Video: A timelapse of clouds moving across a blue sky over a mountain range]" }, expectedOutput: "A timelapse video showing clouds rapidly moving across a blue sky above a mountain range. The accelerated footage shows cloud formations forming, shifting, and dissipating over the peaks.", reward: 1, rubric: "Should identify the timelapse format and describe the motion and scene" },
  ],

  should_respond_runtime: [
    { id: "srr-1", input: { user: "assistant: what time is it in London?" }, expectedOutput: "YES", reward: 1 },
    { id: "srr-2", input: { user: "alice: bob can you check the PR?" }, expectedOutput: "NO", reward: 0 },
    { id: "srr-3", input: { user: "Can anyone help me with this code error?" }, expectedOutput: "YES", reward: 1 },
    { id: "srr-4", input: { user: "meeting starts in 10 mins heads up everyone" }, expectedOutput: "NO", reward: 0 },
    { id: "srr-5", input: { user: "bot please translate this to French: hello world" }, expectedOutput: "YES", reward: 1 },
    { id: "srr-6", input: { user: "I just pushed the hotfix" }, expectedOutput: "NO", reward: 0 },
    { id: "srr-7", input: { user: "can the assistant look up the latest stock price for AAPL?" }, expectedOutput: "YES", reward: 1 },
    { id: "srr-8", input: { user: "lgtm from me @sarah" }, expectedOutput: "NO", reward: 0 },
    { id: "srr-9", input: { user: "What's the weather like tomorrow in NYC?" }, expectedOutput: "YES", reward: 1 },
    { id: "srr-10", input: { user: "Great work everyone on this sprint!" }, expectedOutput: "NO", reward: 0 },
    { id: "srr-11", input: { user: "Hey AI, summarize what we've discussed so far" }, expectedOutput: "YES", reward: 1 },
    { id: "srr-12", input: { user: "john: sure thing, I'll handle it" }, expectedOutput: "NO", reward: 0 },
  ],

  // FACT_EXTRACTION_TEMPLATE — tests durable/current classification, strengthen, contradict, empty
  fact_extraction: [
    {
      id: "fe-1",
      input: { user: "Message: \"I'm a senior TypeScript developer with 8 years of backend experience.\"\nKnown durable facts: []\nKnown current facts: []" },
      expectedOutput: '{"ops":[{"op":"add_durable","category":"identity","claim":"senior TypeScript developer with 8 years of backend experience","keywords":["typescript","developer","backend","senior","experience"]}]}',
      reward: 1,
      rubric: "Must emit add_durable with category=identity. Keywords must include typescript/developer. No add_current for stable career identity.",
    },
    {
      id: "fe-2",
      input: { user: "Message: \"I'm really anxious this morning — have a big presentation.\"\nKnown durable facts: []\nKnown current facts: []" },
      expectedOutput: '{"ops":[{"op":"add_current","category":"feeling","claim":"anxious this morning due to big presentation","keywords":["anxious","morning","presentation"]}]}',
      reward: 1,
      rubric: "Must emit add_current with category=feeling (anxious is transient, not durable). Do NOT emit add_durable.",
    },
    {
      id: "fe-3",
      input: { user: "Message: \"Berlin's been treating me well lately.\"\nKnown durable facts: [fact_abc] (durable.identity) lives in Berlin\nKnown current facts: []" },
      expectedOutput: '{"ops":[{"op":"strengthen","factId":"fact_abc"}]}',
      reward: 1,
      rubric: "Must emit strengthen pointing to fact_abc (city reaffirmed). Do NOT emit add_durable — fact already exists.",
    },
    {
      id: "fe-4",
      input: { user: "Message: \"Actually I moved to Tokyo last month.\"\nKnown durable facts: [fact_abc] (durable.identity) lives in Berlin\nKnown current facts: []" },
      expectedOutput: '{"ops":[{"op":"contradict","factId":"fact_abc","proposedText":"lives in Tokyo","reason":"user moved to Tokyo, contradicts Berlin"}]}',
      reward: 1,
      rubric: "Must emit contradict with factId=fact_abc and proposedText=Tokyo. Old location (Berlin) is wrong.",
    },
    {
      id: "fe-5",
      input: { user: "Message: \"How's the weather in Paris?\"\nKnown durable facts: []\nKnown current facts: []" },
      expectedOutput: '{"ops":[]}',
      reward: 1,
      rubric: "Must return empty ops. This is a question, not a claim about the user. No facts to extract.",
    },
    {
      id: "fe-6",
      input: { user: "Message: \"I love hiking on weekends, it's my main way to unwind.\"\nKnown durable facts: []\nKnown current facts: []" },
      expectedOutput: '{"ops":[{"op":"add_durable","category":"preference","claim":"loves hiking on weekends to unwind","keywords":["hiking","weekends","unwind","preference"]}]}',
      reward: 1,
      rubric: "Must emit add_durable with category=preference. Hiking preference is stable/durable, not transient.",
    },
    {
      id: "fe-7",
      input: { user: "Message: \"I'm currently working on the auth migration for the payments system.\"\nKnown durable facts: []\nKnown current facts: []" },
      expectedOutput: '{"ops":[{"op":"add_current","category":"working_on","claim":"working on auth migration for payments system","keywords":["auth","migration","payments","working"]}]}',
      reward: 1,
      rubric: "Must emit add_current with category=working_on. Current project is transient, not durable identity.",
    },
    {
      id: "fe-8",
      input: { user: "Message: \"lol yeah totally\"\nKnown durable facts: []\nKnown current facts: []" },
      expectedOutput: '{"ops":[]}',
      reward: 1,
      rubric: "Must return empty ops. This is casual acknowledgment with no facts to extract.",
    },
    {
      id: "fe-9",
      input: { user: "Message: \"I graduated from MIT with a CS degree in 2018.\"\nKnown durable facts: []\nKnown current facts: []" },
      expectedOutput: '{"ops":[{"op":"add_durable","category":"life_event","claim":"graduated from MIT with CS degree in 2018","keywords":["mit","cs","graduated","2018","degree"]}]}',
      reward: 1,
      rubric: "Must emit add_durable with category=life_event. Education credential is a stable durable fact.",
    },
    {
      id: "fe-10",
      input: { user: "Message: \"ok sounds good\"\nKnown durable facts: [fact_x] (durable.identity) software engineer at Acme Corp\nKnown current facts: []" },
      expectedOutput: '{"ops":[]}',
      reward: 1,
      rubric: "Must return empty ops. Acknowledgment only — no new facts. Do NOT strengthen existing facts from an unrelated message.",
    },
  ],

  // INITIAL_SUMMARIZATION_TEMPLATE — tests summarization quality
  conversation_summary: [
    {
      id: "cs-1",
      input: { user: "Recent conversation:\nUser: I need help planning a trip to Japan in March.\nAssistant: Great! Japan in March is beautiful — cherry blossom season. Do you prefer Tokyo or Kyoto?\nUser: Tokyo for the first 3 days, then Kyoto.\nAssistant: Perfect. For Tokyo I recommend Shibuya, Shinjuku, and Akihabara. For Kyoto: Fushimi Inari, Arashiyama, and Nishiki Market.\nUser: What about the JR Pass?\nAssistant: Yes, the JR Pass is worth it for Japan-wide travel. Buy it before you arrive — 14-day pass for your trip duration." },
      expectedOutput: '{"text":"User is planning a trip to Japan in March (cherry blossom season). Itinerary: Tokyo (3 days) then Kyoto. Tokyo highlights: Shibuya, Shinjuku, Akihabara. Kyoto highlights: Fushimi Inari, Arashiyama, Nishiki Market. Advice: Buy 14-day JR Pass before arriving.","topics":["Japan trip","Tokyo","Kyoto","JR Pass"],"keyPoints":["Trip planned for March (cherry blossom season)","3 days Tokyo then Kyoto","Purchase 14-day JR Pass before departure"]}',
      reward: 1,
      rubric: "Must capture: Japan/March, Tokyo 3 days then Kyoto, key attractions for each city, JR Pass advice. JSON with text+topics+keyPoints.",
    },
    {
      id: "cs-2",
      input: { user: "Recent conversation:\nUser: Can you help debug this Python error: TypeError: list object is not callable\nAssistant: This happens when you name a variable 'list' and then call it as a function. Check if you have: list = [1,2,3] then later list(something)\nUser: Oh yes! I had list = [] at the top. Fixed it by renaming to my_list.\nAssistant: Good fix. Avoid shadowing built-in names: list, dict, str, int, etc." },
      expectedOutput: '{"text":"User had a Python TypeError caused by shadowing the built-in \'list\' name. Fixed by renaming variable to \'my_list\'. Key lesson: avoid using built-in names as variable names.","topics":["Python debugging","TypeError","variable naming"],"keyPoints":["Bug: variable named \'list\' shadowed the built-in","Fix: rename to my_list","Lesson: avoid shadowing built-ins: list, dict, str, int"]}',
      reward: 1,
      rubric: "Must capture: Python TypeError, cause (shadowing built-in 'list'), fix (rename to my_list), general lesson. JSON format required.",
    },
    {
      id: "cs-3",
      input: { user: "Recent conversation:\nUser: What's the best way to lose weight?\nAssistant: The most evidence-based approach: caloric deficit (eat 300-500 calories less than maintenance), high protein diet (0.8-1g per pound bodyweight), strength training 3x/week, and prioritize sleep 7-9 hours.\nUser: How do I figure out my maintenance calories?\nAssistant: Use the Harris-Benedict equation: for men, BMR = 88.36 + (13.4 × kg) + (4.8 × cm) − (5.7 × age). Multiply by activity factor: sedentary=1.2, light=1.375, moderate=1.55.\nUser: Got it, I'll start tracking." },
      expectedOutput: '{"text":"Discussion about evidence-based weight loss. Key approach: 300-500 calorie deficit, high protein (0.8-1g/lb), strength training 3x/week, 7-9 hours sleep. Maintenance calories calculated via Harris-Benedict equation × activity factor.","topics":["weight loss","nutrition","caloric deficit","BMR calculation"],"keyPoints":["300-500 calorie deficit from maintenance","Protein: 0.8-1g per pound bodyweight","Strength training 3x/week","Sleep 7-9 hours","Harris-Benedict equation for BMR","Activity multipliers: sedentary=1.2, light=1.375, moderate=1.55"]}',
      reward: 1,
      rubric: "Must capture: caloric deficit numbers, protein targets, exercise frequency, sleep recommendation, Harris-Benedict equation, activity multipliers.",
    },
    {
      id: "cs-4",
      input: { user: "Recent conversation:\nUser: hi\nAssistant: Hello! How can I help you today?\nUser: nothing just saying hi\nAssistant: Happy to chat! Let me know if you need anything." },
      expectedOutput: '{"text":"Brief casual exchange with no substantive content. User greeted the assistant and had no specific request.","topics":["casual conversation"],"keyPoints":["No action items or decisions","User had no specific request"]}',
      reward: 1,
      rubric: "Must correctly handle trivial/short conversation. Summary should be short and accurate. No invented details.",
    },
    {
      id: "cs-5",
      input: { user: "Recent conversation:\nUser: We need to decide on the database for our new app — PostgreSQL or MongoDB?\nAssistant: For structured relational data with complex queries: PostgreSQL. For flexible schema, documents, high write throughput: MongoDB. What's your data model like?\nUser: We have users, orders, products — all relational.\nAssistant: PostgreSQL is the right choice. ACID compliance, great for joins, mature ecosystem.\nUser: Agreed. Let's go with PostgreSQL. Can we use Drizzle ORM?\nAssistant: Yes, Drizzle works great with PostgreSQL. Type-safe, lightweight, great DX." },
      expectedOutput: '{"text":"Team decided to use PostgreSQL over MongoDB for a new app. Reason: structured relational data model (users, orders, products) requires ACID compliance and complex joins. Selected Drizzle ORM for type-safe PostgreSQL integration.","topics":["database selection","PostgreSQL","MongoDB","Drizzle ORM"],"keyPoints":["Decision: PostgreSQL chosen over MongoDB","Reason: relational data model needs ACID/joins","ORM: Drizzle selected for PostgreSQL","Data model: users, orders, products"]}',
      reward: 1,
      rubric: "Must capture: decision (PostgreSQL), reason (relational data model), ORM choice (Drizzle), data model description.",
    },
    {
      id: "cs-6",
      input: { user: "Recent conversation:\nUser: Remind me to call Dr. Smith tomorrow at 9am.\nAssistant: I'll set a reminder for tomorrow at 9am to call Dr. Smith.\nUser: Also note that I take metformin 500mg twice daily.\nAssistant: Noted. I've saved your medication: metformin 500mg twice daily.\nUser: Thanks!" },
      expectedOutput: '{"text":"User set a reminder to call Dr. Smith tomorrow at 9am. User also shared medication information: metformin 500mg twice daily.","topics":["reminders","medication","health"],"keyPoints":["Reminder set: call Dr. Smith tomorrow at 9am","Medication noted: metformin 500mg twice daily"]}',
      reward: 1,
      rubric: "Must capture both actions: reminder for Dr. Smith at 9am, and medication note (metformin 500mg twice daily).",
    },
    {
      id: "cs-7",
      input: { user: "Recent conversation:\nUser: What does the 'yield' keyword do in Python?\nAssistant: 'yield' turns a function into a generator. Instead of returning all values at once, it yields one at a time, pausing execution between yields. This is memory-efficient for large sequences.\nUser: Can you show me an example?\nAssistant: def count_up(n):\\n    for i in range(n):\\n        yield i\\n\\nfor x in count_up(5):\\n    print(x)  # prints 0,1,2,3,4 one at a time" },
      expectedOutput: '{"text":"Explained Python \'yield\' keyword. It creates generators — functions that return values lazily one at a time rather than all at once. Memory-efficient for large sequences. Example: count_up() generator yielding 0-4.","topics":["Python","generators","yield keyword"],"keyPoints":["yield turns function into generator","Returns values lazily, one at a time","Memory-efficient vs returning full list","Example: count_up(n) yields 0 to n-1"]}',
      reward: 1,
      rubric: "Must capture: what yield does (generator), lazy evaluation, memory efficiency, the count_up example.",
    },
    {
      id: "cs-8",
      input: { user: "Recent conversation:\nUser: I'm considering switching from Vim to VSCode. Thoughts?\nAssistant: VSCode has better out-of-box experience, extensions ecosystem, and integrated debugging. Vim has lower overhead, powerful once mastered, faster for text operations. Most devs prefer VSCode for daily use, Vim for server/quick edits.\nUser: I do a lot of React work, would VSCode be better?\nAssistant: Definitely VSCode for React. Better JSX support, ES6/TS intellisense, React-specific extensions (React DevTools, Prettier, ESLint).\nUser: Alright, I'll make the switch." },
      expectedOutput: '{"text":"User decided to switch from Vim to VSCode for daily React development. VSCode advantages: better out-of-box experience, extensions, debugging, JSX support, and React-specific tooling (Prettier, ESLint, React DevTools).","topics":["VSCode","Vim","React development","editor choice"],"keyPoints":["Decision: switching from Vim to VSCode","Reason: better React/JSX support","VSCode advantages: extensions, debugging, intellisense","React extensions: React DevTools, Prettier, ESLint"]}',
      reward: 1,
      rubric: "Must capture: decision (switch to VSCode), reason (React work), key advantages, specific React extensions mentioned.",
    },
  ],

  // AUTONOMY_CONTINUOUS_CONTINUE_TEMPLATE — tests when to act vs wait; which action to take
  autonomy_decision: [
    {
      id: "ad-1",
      input: { user: "Context: User asked me to check the status of their GitHub PR #1234.\nLast thought: Need to call the GitHub API to get PR status.\nAvailable actions: GITHUB_GET_PR, REPLY" },
      expectedOutput: '{"thought":"Need to fetch PR status from GitHub before I can reply.","actions":[{"name":"GITHUB_GET_PR"}]}',
      reward: 1,
      rubric: "Must take action (GITHUB_GET_PR). Actions array must be non-empty. Have clear goal and available tool.",
    },
    {
      id: "ad-2",
      input: { user: "Context: Checked GitHub PR #1234. Status: merged 2 hours ago by @alice.\nLast thought: PR status retrieved. Need to report back to user.\nAvailable actions: GITHUB_GET_PR, REPLY" },
      expectedOutput: '{"thought":"PR #1234 is merged. Ready to inform the user.","actions":[{"name":"REPLY"}]}',
      reward: 1,
      rubric: "Must select REPLY since data is ready. The loop should transition to reporting back to user.",
    },
    {
      id: "ad-3",
      input: { user: "Context: Waiting for user to confirm whether to proceed with the database migration.\nLast thought: Asked user for confirmation; no response yet.\nAvailable actions: RUN_MIGRATION, REPLY, SEARCH" },
      expectedOutput: '{"thought":"Still waiting for user confirmation. Cannot proceed with migration without explicit approval.","actions":[]}',
      reward: 1,
      rubric: "Must take NO action (empty actions). Waiting for user input — should not proceed autonomously.",
    },
    {
      id: "ad-4",
      input: { user: "Context: User asked me to research and summarize the top 3 JavaScript frameworks in 2025.\nLast thought: Starting research task.\nAvailable actions: SEARCH, NOTES, REPLY" },
      expectedOutput: '{"thought":"Need to search for current JavaScript framework rankings before summarizing.","actions":[{"name":"SEARCH"}]}',
      reward: 1,
      rubric: "Must take SEARCH action. Research task needs data before summary.",
    },
    {
      id: "ad-5",
      input: { user: "Context: User asked what 2+2 equals.\nLast thought: Simple math question requiring direct reply.\nAvailable actions: SEARCH, REPLY, CALCULATE" },
      expectedOutput: '{"thought":"Simple math — can answer directly without tools.","actions":[{"name":"REPLY"}]}',
      reward: 1,
      rubric: "Must REPLY immediately. Simple fact doesn't require SEARCH or CALCULATE.",
    },
    {
      id: "ad-6",
      input: { user: "Context: Asked to deploy the app to production. No deployment credentials available.\nLast thought: Missing credentials to complete the deploy.\nAvailable actions: DEPLOY, REPLY" },
      expectedOutput: '{"thought":"Cannot deploy — missing production credentials. Need to inform user.","actions":[{"name":"REPLY"}]}',
      reward: 1,
      rubric: "Must REPLY to inform user of missing credentials. Cannot DEPLOY without them.",
    },
    {
      id: "ad-7",
      input: { user: "Context: User wants me to save a note about their meeting tomorrow at 3pm with the board.\nLast thought: Clear note-taking request.\nAvailable actions: NOTES, SCHEDULE, REPLY" },
      expectedOutput: '{"thought":"User wants to save a note about tomorrow\'s board meeting.","actions":[{"name":"NOTES"}]}',
      reward: 1,
      rubric: "Must select NOTES. User explicitly said 'save a note', not 'schedule'.",
    },
    {
      id: "ad-8",
      input: { user: "Context: Monitoring a long-running build. Build started 2 minutes ago, estimated 5 more minutes.\nLast thought: Build in progress. Nothing to do until it completes.\nAvailable actions: CHECK_BUILD_STATUS, REPLY, CANCEL_BUILD" },
      expectedOutput: '{"thought":"Build still in progress (~5 min remaining). No action needed this round — will check again next iteration.","actions":[]}',
      reward: 1,
      rubric: "Must take NO action. Build is running, nothing to act on. Not CHECK_BUILD_STATUS yet (5 min remaining).",
    },
  ],

  // EXTRACT_ACTION_PARAMS_TEMPLATE — tests parameter extraction from conversation context
  extract_action_params: [
    {
      id: "eap-1",
      input: { user: "Action: SEND_EMAIL\nDescription: Send an email to a contact\nMissing required fields: to, subject\nRecent conversation:\nUser: Can you email sarah@company.com about the Q3 budget review?\nAssistant: I'll draft that now.\nCurrent message: Please send it." },
      expectedOutput: '{"to":"sarah@company.com","subject":"Q3 budget review"}',
      reward: 1,
      rubric: "Must extract: to=sarah@company.com, subject=Q3 budget review. Both clearly stated in conversation.",
    },
    {
      id: "eap-2",
      input: { user: "Action: SCHEDULE_MEETING\nDescription: Create a calendar event\nMissing required fields: title, time, duration\nRecent conversation:\nUser: Schedule a standup with the team tomorrow at 9am for 30 minutes.\nCurrent message: Yeah that works." },
      expectedOutput: '{"title":"Team standup","time":"tomorrow 9am","duration":"30 minutes"}',
      reward: 1,
      rubric: "Must extract: title=Team standup, time=tomorrow 9am, duration=30 minutes. All present in conversation.",
    },
    {
      id: "eap-3",
      input: { user: "Action: SET_REMINDER\nDescription: Set a reminder for the user\nMissing required fields: message, delay\nRecent conversation:\nUser: Remind me to take my medicine\nCurrent message: in an hour" },
      expectedOutput: '{"message":"Take medicine","delay":"1h"}',
      reward: 1,
      rubric: "Must extract: message=Take medicine (or similar), delay=1h. Delay is in the current message.",
    },
    {
      id: "eap-4",
      input: { user: "Action: SEARCH\nDescription: Search the internet\nMissing required fields: query\nRecent conversation:\nUser: Can you look something up for me?\nCurrent message: I want to know the current price of Bitcoin" },
      expectedOutput: '{"query":"current Bitcoin price"}',
      reward: 1,
      rubric: "Must extract query from current message. Query should be about Bitcoin price.",
    },
    {
      id: "eap-5",
      input: { user: "Action: CREATE_NOTE\nDescription: Save a note\nMissing required fields: content, title\nRecent conversation:\nUser: Note this down: our team uses TypeScript, React, and PostgreSQL for the main stack.\nCurrent message: Title it 'Tech Stack'" },
      expectedOutput: '{"content":"Our team uses TypeScript, React, and PostgreSQL for the main stack.","title":"Tech Stack"}',
      reward: 1,
      rubric: "Must extract content from prior message and title from current message.",
    },
    {
      id: "eap-6",
      input: { user: "Action: SEND_SLACK_MESSAGE\nDescription: Post a message in a Slack channel\nMissing required fields: channel, message\nRecent conversation:\nUser: Can you post in #general that the server maintenance is complete?\nCurrent message: Yeah go ahead." },
      expectedOutput: '{"channel":"general","message":"Server maintenance is complete."}',
      reward: 1,
      rubric: "Must extract: channel=general (strip the #), message about server maintenance being complete.",
    },
    {
      id: "eap-7",
      input: { user: "Action: CREATE_TICKET\nDescription: Create a Jira/GitHub issue\nMissing required fields: title, description, priority\nRecent conversation:\nUser: Log a bug: the login button breaks on mobile Safari.\nCurrent message: Make it high priority." },
      expectedOutput: '{"title":"Login button broken on mobile Safari","description":"Login button breaks on mobile Safari","priority":"high"}',
      reward: 1,
      rubric: "Must extract: title/description about the mobile Safari login bug, priority=high from current message.",
    },
    {
      id: "eap-8",
      input: { user: "Action: BOOK_FLIGHT\nDescription: Book a flight\nMissing required fields: from, to, date\nRecent conversation:\nUser: I need to fly somewhere next week.\nCurrent message: Actually I haven't decided where yet." },
      expectedOutput: '{"from":null,"to":null,"date":null}',
      reward: 1,
      rubric: "Must return null for all fields. User explicitly said they haven't decided. Do NOT invent values.",
    },
  ],

  // REPLY_TEMPLATE — dialog generation quality
  reply: [
    { id: "rl-1", input: { user: "User: Hey! How are you doing today?\nContext: First message of the day" }, expectedOutput: '{"thought":"Friendly greeting, respond warmly","text":"Doing great, thanks for asking! What can I help you with today?"}', reward: 1, rubric: "Should be warm, brief, and natural. Must include thought + text fields. No verbose padding." },
    { id: "rl-2", input: { user: "User: Can you explain recursion in 2 sentences?\nContext: Technical chat" }, expectedOutput: '{"thought":"Need a concise 2-sentence recursion explanation","text":"Recursion is when a function calls itself to solve a smaller version of the same problem. The key is a base case that stops the recursion — without it, you get infinite loops."}', reward: 1, rubric: "Must explain recursion in exactly 2 sentences. Clear and accurate. JSON format." },
    { id: "rl-3", input: { user: "User: I'm frustrated with my code, it keeps throwing TypeErrors.\nContext: Debugging session" }, expectedOutput: '{"thought":"User is frustrated; be empathetic and helpful","text":"TypeErrors in JS/TS are usually about type mismatches or null/undefined values. Can you share the error message and the line causing it?"}', reward: 1, rubric: "Should be empathetic, then ask for the specific error. Not generic advice. JSON format." },
    { id: "rl-4", input: { user: "User: What's 12 × 13?\nContext: Quick math question" }, expectedOutput: '{"thought":"Simple multiplication","text":"156."}', reward: 1, rubric: "Must give the correct answer 156. One word/number acceptable. JSON format required." },
    { id: "rl-5", input: { user: "User: Thanks, that worked perfectly!\nContext: User confirming a solution worked" }, expectedOutput: '{"thought":"User is happy with the solution","text":"Great, glad it worked! Let me know if anything else comes up."}', reward: 1, rubric: "Should acknowledge success briefly and offer continued help. Short, natural." },
    { id: "rl-6", input: { user: "User: Schedule a meeting for tomorrow at 3pm with the team.\nContext: Task request that needs a tool — agent is in planning mode" }, expectedOutput: '{"thought":"This needs a calendar tool, not a direct text reply","text":"On it — scheduling the team meeting for tomorrow at 3pm."}', reward: 1, rubric: "Should acknowledge the task briefly ('On it', 'Scheduling now'). Should NOT try to actually schedule in text. Should be an ack, not a final answer." },
    { id: "rl-7", input: { user: "User: Who was the first person to walk on the moon?\nContext: Factual question" }, expectedOutput: '{"thought":"Simple factual question","text":"Neil Armstrong, on July 20, 1969 during the Apollo 11 mission."}', reward: 1, rubric: "Must answer correctly: Neil Armstrong, 1969. Concise. JSON format." },
    { id: "rl-8", input: { user: "User: goodbye!\nContext: User ending conversation" }, expectedOutput: '{"thought":"User is leaving","text":"Goodbye! Come back anytime."}', reward: 1, rubric: "Brief farewell. No padding. JSON format." },
  ],

  // OBSERVATION_EXTRACTION_TEMPLATE — extract durable user observations
  observation_extraction: [
    {
      id: "oe-1",
      input: { user: "Recent exchanges:\nUser: I always use vim bindings everywhere I can\nAssistant: Got it, you prefer vim motions." },
      expectedOutput: '["User prefers vim key bindings"]',
      reward: 1,
      rubric: "Must extract: preference for vim bindings. JSON array format. Short observation.",
    },
    {
      id: "oe-2",
      input: { user: "Recent exchanges:\nUser: how's the weather today?\nAssistant: I don't have access to live weather data.\nUser: oh ok, never mind" },
      expectedOutput: '[]',
      reward: 1,
      rubric: "Must return empty array. No durable observations — just a casual question with no personal info.",
    },
    {
      id: "oe-3",
      input: { user: "Recent exchanges:\nUser: I'm a senior backend engineer at Stripe, mostly TypeScript and Go\nAssistant: Great background. What are you working on today?" },
      expectedOutput: '["User is a senior backend engineer at Stripe","User primarily uses TypeScript and Go"]',
      reward: 1,
      rubric: "Must extract role (senior backend at Stripe) and tech stack (TypeScript, Go). JSON array.",
    },
    {
      id: "oe-4",
      input: { user: "Recent exchanges:\nUser: please always respond in bullet points, I hate paragraphs\nAssistant: Understood, bullet points it is." },
      expectedOutput: '["User prefers responses in bullet point format, not paragraphs"]',
      reward: 1,
      rubric: "Must extract the standing instruction: respond in bullet points. This is a preference worth remembering.",
    },
    {
      id: "oe-5",
      input: { user: "Recent exchanges:\nUser: ok thanks\nAssistant: You're welcome!" },
      expectedOutput: '[]',
      reward: 1,
      rubric: "Must return empty array. Single-word acknowledgment contains no observations.",
    },
    {
      id: "oe-6",
      input: { user: "Recent exchanges:\nUser: I always write tests before my implementation, TDD all the way\nAssistant: TDD is great for catching regressions early.\nUser: yeah I can't work without it at this point" },
      expectedOutput: '["User follows TDD workflow — writes tests before implementation"]',
      reward: 1,
      rubric: "Must extract: TDD workflow preference. Confirmed by multiple statements. Not a single mention.",
    },
  ],

  // MEMORY_CONTEXT_QA_TEMPLATE — answer from memory context
  memory_qa: [
    {
      id: "mq-1",
      input: { user: "Query: What is the user's favorite programming language?\n\nSaved memory notes:\n- User prefers TypeScript for all new projects\n- User has 8 years of Python experience but avoids it for new work\n\nKnowledge snippets: []" },
      expectedOutput: '{"answer":"TypeScript — the user prefers it for all new projects, though they have extensive Python experience."}',
      reward: 1,
      rubric: "Must answer TypeScript from memory notes. Should reference both notes for completeness.",
    },
    {
      id: "mq-2",
      input: { user: "Query: What is the capital of France?\n\nSaved memory notes: []\n\nKnowledge snippets: []" },
      expectedOutput: '{"answer":"Context is insufficient to answer this — no relevant notes or knowledge snippets available."}',
      reward: 1,
      rubric: "Must say context is insufficient. Should NOT hallucinate the answer (Paris) from general knowledge.",
    },
    {
      id: "mq-3",
      input: { user: "Query: When is the user's team standup?\n\nSaved memory notes:\n- Daily standup at 9am EST with the backend team\n- User sometimes skips Fridays\n\nKnowledge snippets: []" },
      expectedOutput: '{"answer":"Daily standup is at 9am EST with the backend team. The user sometimes skips on Fridays."}',
      reward: 1,
      rubric: "Must answer with time (9am EST) and note about Fridays. All from notes.",
    },
    {
      id: "mq-4",
      input: { user: "Query: What medications does the user take?\n\nSaved memory notes:\n- User takes metformin 500mg twice daily for diabetes management\n- Allergic to penicillin\n\nKnowledge snippets: []" },
      expectedOutput: '{"answer":"Metformin 500mg twice daily. The user is also allergic to penicillin."}',
      reward: 1,
      rubric: "Must state metformin 500mg twice daily AND penicillin allergy. Both are in notes.",
    },
    {
      id: "mq-5",
      input: { user: "Query: What database does the user's company use?\n\nSaved memory notes:\n- User works on the frontend team at Acme Corp\n\nKnowledge snippets: []" },
      expectedOutput: '{"answer":"Context is insufficient — the notes mention Acme Corp but don\'t specify which database they use."}',
      reward: 1,
      rubric: "Must say insufficient context — database not in notes, only company name and team.",
    },
    {
      id: "mq-6",
      input: { user: "Query: Does the user have any dietary restrictions?\n\nSaved memory notes:\n- User is vegetarian and avoids all meat\n- User also avoids gluten (celiac disease)\n\nKnowledge snippets: []" },
      expectedOutput: '{"answer":"Yes — the user is vegetarian and has celiac disease, so they avoid all meat and gluten."}',
      reward: 1,
      rubric: "Must state both: vegetarian AND celiac/gluten-free. Both critical health notes.",
    },
  ],

  // CHOOSE_OPTION_TEMPLATE — option selection
  choose_option: [
    {
      id: "co-1",
      input: { user: "Context: User asked for help with a TypeScript error\n\nAvailable options:\n- id: OPT_DEBUG | Debug the error step by step\n- id: OPT_FIX | Apply an immediate code fix\n- id: OPT_EXPLAIN | Explain what the error means\n\nUser said: 'just fix it for me'" },
      expectedOutput: '{"thought":"User wants immediate fix, not explanation or step-by-step","selected_id":"OPT_FIX"}',
      reward: 1,
      rubric: "Must select OPT_FIX. User said 'just fix it' — not debug or explain.",
    },
    {
      id: "co-2",
      input: { user: "Context: User is learning about machine learning\n\nAvailable options:\n- id: BEGINNER | Start with basics (what is ML, types of ML)\n- id: INTERMEDIATE | Jump to algorithms and training\n- id: ADVANCED | Dive into neural network architectures\n\nUser said: 'I have a CS degree but never touched ML'" },
      expectedOutput: '{"thought":"CS background but ML novice — intermediate is right, not too basic or too advanced","selected_id":"INTERMEDIATE"}',
      reward: 1,
      rubric: "Must select INTERMEDIATE. CS degree = not beginner; no ML experience = not advanced.",
    },
    {
      id: "co-3",
      input: { user: "Context: User wants to export their data\n\nAvailable options:\n- id: CSV | Export as CSV spreadsheet\n- id: JSON | Export as JSON file\n- id: PDF | Export as PDF report\n\nUser said: 'I want to open it in Excel'" },
      expectedOutput: '{"thought":"User wants Excel compatibility — CSV is the right format for Excel","selected_id":"CSV"}',
      reward: 1,
      rubric: "Must select CSV. Excel natively opens CSV files, not JSON or PDF.",
    },
    {
      id: "co-4",
      input: { user: "Context: User is deploying an app\n\nAvailable options:\n- id: STAGING | Deploy to staging environment\n- id: PRODUCTION | Deploy to production\n- id: DEV | Deploy to development server\n\nUser said: 'Let's test this before going live'" },
      expectedOutput: '{"thought":"User wants to test before going live = staging","selected_id":"STAGING"}',
      reward: 1,
      rubric: "Must select STAGING. 'Test before going live' is the canonical staging use case.",
    },
    {
      id: "co-5",
      input: { user: "Context: User is configuring notifications\n\nAvailable options:\n- id: ALL | Receive all notifications\n- id: IMPORTANT | Only important notifications\n- id: NONE | No notifications\n\nUser said: 'I don't want to be bothered unless it's urgent'" },
      expectedOutput: '{"thought":"User wants minimal, urgent-only notifications = IMPORTANT","selected_id":"IMPORTANT"}',
      reward: 1,
      rubric: "Must select IMPORTANT. 'Unless it's urgent' = important only, not all or none.",
    },
    {
      id: "co-6",
      input: { user: "Context: User is asking about response format\n\nAvailable options:\n- id: SHORT | Brief 1-2 sentence answers\n- id: DETAILED | Comprehensive explanations with examples\n- id: BULLETS | Structured bullet points\n\nUser said: 'Give me a full deep dive with examples'" },
      expectedOutput: '{"thought":"User explicitly wants detailed explanation with examples","selected_id":"DETAILED"}',
      reward: 1,
      rubric: "Must select DETAILED. 'Full deep dive with examples' = comprehensive.",
    },
  ],

  // REFLECTION_TEMPLATE — agent self-reflection quality
  reflection: [
    {
      id: "rf-1",
      input: { user: "Recent interactions:\n1. User asked for Python help, agent gave a clear example → User: 'Perfect, thanks!'\n2. User asked a vague question, agent asked for clarification → User clarified and got a good answer\n3. Agent gave a long response to a simple yes/no question → User seemed annoyed" },
      expectedOutput: '{"thought":"Two good interactions, one clear mistake: over-verbose response to simple question","quality_score":72,"strengths":"Good clarification-seeking and accurate technical help","improvements":"Match response length to question complexity","learnings":"Yes/no questions get yes/no answers"}',
      reward: 1,
      rubric: "Must identify the verbose response as the weakness. Quality score should be 65-80. All JSON fields required.",
    },
    {
      id: "rf-2",
      input: { user: "Recent interactions:\n1. Agent helped debug a React hook issue correctly → User: 'That fixed it!'\n2. Agent scheduled a meeting correctly\n3. Agent answered all 5 questions accurately and concisely" },
      expectedOutput: '{"thought":"All interactions went well - accurate, helpful responses across different task types","quality_score":90,"strengths":"Technical accuracy, task execution, concise answers","improvements":"Could add more proactive suggestions","learnings":"Current approach working well across task types"}',
      reward: 1,
      rubric: "High quality score (80-95) appropriate since all interactions went well. Honest positive assessment.",
    },
    {
      id: "rf-3",
      input: { user: "Recent interactions:\n1. Agent misunderstood 'cancel' as cancel the meeting not cancel the action → User had to repeat themselves\n2. Agent gave wrong timezone conversion (said EST instead of PST)\n3. Agent interrupted user mid-thought with an early response" },
      expectedOutput: '{"thought":"Three distinct errors: ambiguity mishandling, factual error, premature response","quality_score":35,"strengths":"At least responded promptly","improvements":"Clarify ambiguous words before acting; double-check time conversions; wait for user to finish","learnings":"Ambiguity and factual accuracy are critical gaps"}',
      reward: 1,
      rubric: "Low quality score (25-45) appropriate. Must identify all 3 failures specifically. Honest assessment.",
    },
  ],

  // UPDATE_SUMMARIZATION_TEMPLATE — rolling summary updates
  update_summarization: [
    {
      id: "us-1",
      input: { user: "Existing summary: 'User is planning a trip to Japan in March. Interested in Tokyo (3 days) and Kyoto.'\nExisting topics: Japan trip, travel planning\nNew messages:\nUser: What about Osaka? Should I add a day there?\nAssistant: Osaka is worth a day — Dotonbori, Namba, day trip to Nara possible." },
      expectedOutput: '{"text":"User is planning a Japan trip in March: Tokyo (3 days), Kyoto, and considering adding Osaka (1 day for Dotonbori, Namba). Nara possible as a day trip from Osaka.","topics":["Japan trip","travel planning","Osaka","Kyoto","Tokyo"],"keyPoints":["March trip to Japan","Tokyo 3 days then Kyoto","Adding Osaka — Dotonbori, Namba","Nara possible day trip from Osaka"]}',
      reward: 1,
      rubric: "Must merge existing summary (Tokyo/Kyoto) with new Osaka discussion. Topics should include Osaka.",
    },
    {
      id: "us-2",
      input: { user: "Existing summary: 'Team chose PostgreSQL over MongoDB for relational data model.'\nExisting topics: database, PostgreSQL\nNew messages:\nUser: We also decided to use Prisma as the ORM instead of Drizzle.\nAssistant: Good choice — Prisma has great TypeScript integration and a mature migration system." },
      expectedOutput: '{"text":"Team chose PostgreSQL for relational data model. ORM decision updated: Prisma selected over Drizzle for its TypeScript integration and migration system.","topics":["database","PostgreSQL","Prisma","ORM"],"keyPoints":["PostgreSQL chosen for relational data","Prisma selected as ORM (changed from Drizzle)","Prisma: strong TypeScript integration and migrations"]}',
      reward: 1,
      rubric: "Must update summary to reflect ORM change from Drizzle to Prisma. Keep PostgreSQL decision.",
    },
    {
      id: "us-3",
      input: { user: "Existing summary: 'User is debugging a Python memory leak in a data processing pipeline.'\nExisting topics: Python, debugging, memory leak\nNew messages:\nUser: I found it — was an unclosed file handle in the CSV reader loop.\nAssistant: Classic. Wrap with 'with open()' to ensure proper cleanup.\nUser: Fixed! Memory usage is stable now." },
      expectedOutput: '{"text":"User was debugging a Python memory leak in a data processing pipeline. Root cause: unclosed file handle in CSV reader. Fixed using context manager (with open()). Memory usage now stable.","topics":["Python","debugging","memory leak","fixed"],"keyPoints":["Bug: unclosed file handle in CSV reader","Fix: use with open() context manager","Result: memory usage now stable"]}',
      reward: 1,
      rubric: "Must update summary to show RESOLVED status. Include root cause, fix, and confirmation it worked.",
    },
    {
      id: "us-4",
      input: { user: "Existing summary: 'Long discussion about React vs Vue for a new project.'\nExisting topics: React, Vue, framework choice\nNew messages:\nUser: ok we're going with React, final decision\nAssistant: Great. React's ecosystem and team familiarity make it the safe choice." },
      expectedOutput: '{"text":"Team finalized framework selection: React chosen over Vue. Reasons: ecosystem size and team familiarity.","topics":["React","framework decision","final"],"keyPoints":["Final decision: React","Reasons: ecosystem and team familiarity"]}',
      reward: 1,
      rubric: "Must condense the long discussion into just the decision (React) and reasons. Remove verbose discussion.",
    },
  ],

  // LONG_TERM_EXTRACTION_TEMPLATE — deep memory extraction
  long_term_extraction: [
    {
      id: "lt-1",
      input: { user: "Conversation:\nUser: I've been doing TDD for 6 years. I can't write code without tests first.\nAssistant: TDD is great for confidence.\nUser: Yeah, I literally always write the test before the function, even for tiny utils.\nAssistant: That's strong discipline.\nUser: It's just how I work at this point.\nExisting long-term memories: []" },
      expectedOutput: '{"memories":[{"category":"procedural","content":"User follows strict TDD: always writes tests before implementation, including small utilities","confidence":0.95}]}',
      reward: 1,
      rubric: "Must extract PROCEDURAL memory about TDD. High confidence (0.9+) justified by 3+ confirmations and 6 years experience.",
    },
    {
      id: "lt-2",
      input: { user: "Conversation:\nUser: I tried Rust once last year, couldn't figure out the borrow checker\nAssistant: It has a steep learning curve.\nExisting long-term memories: []" },
      expectedOutput: '{"memories":[]}',
      reward: 1,
      rubric: "Must return empty memories. Single frustrated mention of Rust does not qualify as long-term memory.",
    },
    {
      id: "lt-3",
      input: { user: "Conversation:\nUser: I'm a principal engineer at Google, been there 9 years\nAssistant: That's impressive tenure.\nUser: Yeah, I lead the infrastructure reliability team\nExisting long-term memories: []" },
      expectedOutput: '{"memories":[{"category":"semantic","content":"Principal engineer at Google (9 years), leads infrastructure reliability team","confidence":0.97}]}',
      reward: 1,
      rubric: "Must extract SEMANTIC memory about role at Google. Very high confidence - explicitly stated, specific.",
    },
    {
      id: "lt-4",
      input: { user: "Conversation:\nUser: what's 2+2?\nAssistant: 4.\nUser: and 5+5?\nAssistant: 10.\nExisting long-term memories: []" },
      expectedOutput: '{"memories":[]}',
      reward: 1,
      rubric: "Must return empty memories. Simple math questions contain zero user-specific facts.",
    },
    {
      id: "lt-5",
      input: { user: "Conversation:\nUser: I deployed a major auth system migration at work in Q4 2024. Moved from JWT to OAuth2 with Okta. Took 3 months.\nAssistant: That's a significant project.\nUser: Yeah it was, affected all 50k users.\nExisting long-term memories: []" },
      expectedOutput: '{"memories":[{"category":"episodic","content":"Led auth migration from JWT to OAuth2/Okta in Q4 2024, 3 months, affected 50k users","confidence":0.93}]}',
      reward: 1,
      rubric: "Must extract EPISODIC memory. Specific event (Q4 2024), magnitude (50k users), technology (Okta). High confidence.",
    },
    {
      id: "lt-6",
      input: { user: "Conversation:\nUser: I might try learning Rust someday\nAssistant: It's a great systems language.\nExisting long-term memories: []" },
      expectedOutput: '{"memories":[]}',
      reward: 1,
      rubric: "Must return empty. 'Might try someday' is speculative, not a fact. Do not extract vague intentions.",
    },
  ],

  // IMAGE_GENERATION_TEMPLATE — image prompt creation
  image_generation: [
    { id: "ig-1", input: { user: "Conversation context: User is writing a sci-fi novel set in a post-apocalyptic Tokyo in 2150.\nRecent messages: User: I want a book cover image for my novel." }, expectedOutput: '{"thought":"Book cover for post-apocalyptic Tokyo sci-fi novel","prompt":"Post-apocalyptic Tokyo skyline in 2150, crumbling skyscrapers with bioluminescent plants growing through ruins, perpetual smog, dramatic neon lights, cinematic wide shot, hyper-detailed digital art"}', reward: 1, rubric: "Must generate a specific, visual image prompt matching post-apocalyptic Tokyo sci-fi. Not generic." },
    { id: "ig-2", input: { user: "Conversation context: User runs a bakery and wants marketing photos.\nRecent messages: User: Create an image for my new sourdough bread." }, expectedOutput: '{"thought":"Marketing photo for artisan sourdough bread","prompt":"Artisan sourdough loaf on a rustic wooden cutting board, golden crust with scored pattern, soft morning light, steam rising, fresh herbs beside it, warm tones, professional food photography"}', reward: 1, rubric: "Should generate an appetizing food photography prompt. Specific details: crust, lighting, composition." },
    { id: "ig-3", input: { user: "Conversation context: User is designing a mobile app for meditation.\nRecent messages: User: I need a calming hero image for my app." }, expectedOutput: '{"thought":"Calming hero image for meditation app","prompt":"Serene mountain lake at dawn, mist rising from still water, soft pink and gold sky, reflection of snow-capped mountains, minimal composition, tranquil atmosphere, pastel palette, digital illustration"}', reward: 1, rubric: "Must be calming and serene. Match meditation theme. Specific visual elements." },
    { id: "ig-4", input: { user: "Conversation context: Tech startup.\nRecent messages: User: Generate a professional LinkedIn banner for our AI company." }, expectedOutput: '{"thought":"Professional LinkedIn banner for AI company","prompt":"Abstract digital neural network visualization, dark navy background, interconnected glowing nodes in blue and purple, geometric circuit patterns, clean minimalist design, corporate professional aesthetic, 1584x396 banner format"}', reward: 1, rubric: "Must be professional, tech-themed, mention dimensions or banner context, not a photo but a graphic." },
  ],

  // POST_CREATION_TEMPLATE — social media posts
  post_creation: [
    { id: "pc-1", input: { user: "Topic: the importance of code reviews in software development" }, expectedOutput: '{"thought":"Code reviews improve code quality and team knowledge","post":"Code reviews aren\'t just bug detection — they\'re knowledge transfer. Every review makes the whole team stronger."}', reward: 1, rubric: "Should be 1-3 sentences, under 280 chars, no emojis, insightful take on code reviews. JSON format." },
    { id: "pc-2", input: { user: "Topic: getting better at deep work and focus" }, expectedOutput: '{"thought":"Deep work requires intentional time blocking","post":"Your best work happens in uninterrupted blocks, not between notifications. Protect your calendar like it\'s your most valuable asset."}', reward: 1, rubric: "Should be concise and actionable. No emojis. Under 280 chars. On-topic about focus/deep work." },
    { id: "pc-3", input: { user: "Topic: lessons learned from shipping a failed product" }, expectedOutput: '{"thought":"Failure teaches what success hides","post":"Shipped a product nobody wanted. Learned more in 3 months of failure than 2 years of comfortable growth. Some lessons only come from shipping."}', reward: 1, rubric: "Should be personal, reflective, authentic. First-person perspective. No emojis. Under 280 chars." },
    { id: "pc-4", input: { user: "Topic: why walking meetings beat sitting meetings" }, expectedOutput: '{"thought":"Movement improves creativity and engagement","post":"Walking meetings end 40% sooner and generate better ideas. Staring at a whiteboard isn\'t the only way to think."}', reward: 1, rubric: "Should make a clear point with concrete detail. Under 280 chars. No emojis. Assertive tone." },
  ],

  // CUSTOM_ACTION_GENERATE_TEMPLATE — generate action definitions
  custom_action_generate: [
    {
      id: "cag-1",
      input: { user: "User request: Create an action that sends an HTTP GET request to a URL and returns the response body" },
      expectedOutput: '{"name":"HTTP_GET","description":"Send an HTTP GET request and return the response body","handlerType":"http","handler":{"type":"http","method":"GET","url":"{{url}}"},"parameters":[{"name":"url","description":"URL to fetch","required":true}]}',
      reward: 1,
      rubric: "Must have: name=HTTP_GET (UPPER_SNAKE_CASE), handlerType=http, handler with GET method, url parameter.",
    },
    {
      id: "cag-2",
      input: { user: "User request: Create an action that lists all files in a directory using the ls command" },
      expectedOutput: '{"name":"LIST_FILES","description":"List all files in a directory","handlerType":"shell","handler":{"type":"shell","command":"ls {{directory}}"},"parameters":[{"name":"directory","description":"Path to directory","required":true}]}',
      reward: 1,
      rubric: "Must have: handlerType=shell, command with ls, directory parameter.",
    },
    {
      id: "cag-3",
      input: { user: "User request: Create an action that adds two numbers together" },
      expectedOutput: '{"name":"ADD_NUMBERS","description":"Add two numbers together and return the sum","handlerType":"code","handler":{"type":"code","code":"return params.a + params.b;"},"parameters":[{"name":"a","description":"First number","required":true},{"name":"b","description":"Second number","required":true}]}',
      reward: 1,
      rubric: "Must have: handlerType=code, code does addition, two required parameters a and b.",
    },
    {
      id: "cag-4",
      input: { user: "User request: Create an action that posts a message to a Slack webhook URL" },
      expectedOutput: '{"name":"SLACK_WEBHOOK","description":"Post a message to a Slack webhook","handlerType":"http","handler":{"type":"http","method":"POST","url":"{{webhookUrl}}","bodyTemplate":"{\"text\":\"{{message}}\"}"},"parameters":[{"name":"webhookUrl","description":"Slack webhook URL","required":true},{"name":"message","description":"Message to post","required":true}]}',
      reward: 1,
      rubric: "Must have: POST method, webhook URL parameter, message body template, JSON content type.",
    },
  ],

  // SHOULD_FOLLOW_ROOM_TEMPLATE — room follow decision
  should_follow_room: [
    { id: "sfr-1", input: { user: "User message: Hey assistant, can you start following this channel? I want you active here." }, expectedOutput: '{"decision":true}', reward: 1, rubric: "Must return true. Clear explicit request to follow the room." },
    { id: "sfr-2", input: { user: "User message: What's the weather like today?" }, expectedOutput: '{"decision":false}', reward: 1, rubric: "Must return false. Weather question has nothing to do with following rooms." },
    { id: "sfr-3", input: { user: "User message: Please join and monitor this room from now on." }, expectedOutput: '{"decision":true}', reward: 1, rubric: "Must return true. 'Join and monitor' = follow this room." },
    { id: "sfr-4", input: { user: "User message: I was thinking you might be useful in this channel but I'm not sure." }, expectedOutput: '{"decision":false}', reward: 1, rubric: "Must return false. Ambiguous — 'might be useful' and 'not sure' = default to false." },
    { id: "sfr-5", input: { user: "User message: Follow this room please." }, expectedOutput: '{"decision":true}', reward: 1, rubric: "Must return true. Direct explicit request." },
    { id: "sfr-6", input: { user: "User message: Can you help me debug this error?" }, expectedOutput: '{"decision":false}', reward: 1, rubric: "Must return false. Debugging question, not a room follow request." },
  ],

  // SHOULD_MUTE_ROOM_TEMPLATE — room mute decision
  should_mute_room: [
    { id: "smr-1", input: { user: "User message: Can you mute this channel? Too much noise." }, expectedOutput: '{"decision":true}', reward: 1, rubric: "Must return true. Clear explicit mute request." },
    { id: "smr-2", input: { user: "User message: Let's go back to talking about the project." }, expectedOutput: '{"decision":false}', reward: 1, rubric: "Must return false. No mute request present." },
    { id: "smr-3", input: { user: "User message: Stop responding in here please, mute this room." }, expectedOutput: '{"decision":true}', reward: 1, rubric: "Must return true. 'Mute this room' is explicit." },
    { id: "smr-4", input: { user: "User message: This channel is getting busy." }, expectedOutput: '{"decision":false}', reward: 1, rubric: "Must return false. Observation about busyness ≠ request to mute." },
    { id: "smr-5", input: { user: "User message: Silence yourself in this channel." }, expectedOutput: '{"decision":true}', reward: 1, rubric: "Must return true. 'Silence yourself' = mute." },
    { id: "smr-6", input: { user: "User message: thanks" }, expectedOutput: '{"decision":false}', reward: 1, rubric: "Must return false. Single word acknowledgment." },
  ],

  // SHOULD_UNFOLLOW_ROOM_TEMPLATE — room unfollow decision
  should_unfollow_room: [
    { id: "sur-1", input: { user: "User message: Please leave this channel, we don't need you here anymore." }, expectedOutput: '{"decision":true}', reward: 1, rubric: "Must return true. Clear request to leave/unfollow." },
    { id: "sur-2", input: { user: "User message: What time is the meeting tomorrow?" }, expectedOutput: '{"decision":false}', reward: 1, rubric: "Must return false. Unrelated question." },
    { id: "sur-3", input: { user: "User message: Stop following this room." }, expectedOutput: '{"decision":true}', reward: 1, rubric: "Must return true. Direct unfollow request." },
    { id: "sur-4", input: { user: "User message: You can unfollow this channel now, we're done here." }, expectedOutput: '{"decision":true}', reward: 1, rubric: "Must return true. Explicit unfollow with context." },
    { id: "sur-5", input: { user: "User message: I don't know if this channel is useful to you." }, expectedOutput: '{"decision":false}', reward: 1, rubric: "Must return false. Ambiguous musing, not a clear unfollow request." },
    { id: "sur-6", input: { user: "User message: ok bye" }, expectedOutput: '{"decision":false}', reward: 1, rubric: "Must return false. 'Bye' to the user, not an instruction to unfollow." },
  ],

  // SHOULD_UNMUTE_ROOM_TEMPLATE — room unmute decision
  should_unmute_room: [
    { id: "surt-1", input: { user: "User message: You can unmute this channel now, please start responding again." }, expectedOutput: '{"decision":true}', reward: 1, rubric: "Must return true. Clear unmute request." },
    { id: "surt-2", input: { user: "User message: Hey can you help me?" }, expectedOutput: '{"decision":false}', reward: 1, rubric: "Must return false. Asking for help is not an unmute request." },
    { id: "surt-3", input: { user: "User message: Unmute yourself here." }, expectedOutput: '{"decision":true}', reward: 1, rubric: "Must return true. Direct unmute instruction." },
    { id: "surt-4", input: { user: "User message: Come back to this channel." }, expectedOutput: '{"decision":true}', reward: 1, rubric: "Must return true. 'Come back' = re-engage = unmute." },
    { id: "surt-5", input: { user: "User message: Is the channel working now?" }, expectedOutput: '{"decision":false}', reward: 1, rubric: "Must return false. Question about channel status ≠ unmute request." },
    { id: "surt-6", input: { user: "User message: start paying attention to this chat again please" }, expectedOutput: '{"decision":true}', reward: 1, rubric: "Must return true. 'Pay attention again' = unmute/re-engage." },
  ],

  // ADD_CONTACT_TEMPLATE — contact extraction
  add_contact: [
    { id: "ac-1", input: { user: "User: Please add Sarah Chen to my contacts. She's my project manager at Acme and works in the New York office. Very important person to track." }, expectedOutput: '{"contactName":"Sarah Chen","entityId":null,"categories":"colleague","notes":"Project manager at Acme, works in New York office","reason":"Important project contact to track"}', reward: 1, rubric: "Must extract: name=Sarah Chen, role/notes, reason. No entityId since not specified." },
    { id: "ac-2", input: { user: "User: Add John Smith as a VIP contact. He's a major investor." }, expectedOutput: '{"contactName":"John Smith","entityId":null,"categories":"vip","reason":"Major investor"}', reward: 1, rubric: "Must extract: name=John Smith, categories=vip, reason=major investor." },
    { id: "ac-3", input: { user: "User: Save Dr. Martinez — family doctor. Spanish speaker." }, expectedOutput: '{"contactName":"Dr. Martinez","entityId":null,"categories":"personal","notes":"Family doctor","language":"Spanish","reason":"Family medical contact"}', reward: 1, rubric: "Must extract name, notes=family doctor, language=Spanish." },
    { id: "ac-4", input: { user: "User: Remember to add Alice from marketing. She prefers email over calls. She's in London, so timezone is Europe/London." }, expectedOutput: '{"contactName":"Alice","entityId":null,"categories":"colleague","notes":"Prefers email over calls","timezone":"Europe/London","reason":"Marketing contact with communication preferences"}', reward: 1, rubric: "Must extract: name, preference (email), timezone (Europe/London)." },
  ],

  // SEARCH_CONTACTS_TEMPLATE — contact search criteria
  search_contacts: [
    { id: "sc-1", input: { user: "User: Show me all my VIP contacts" }, expectedOutput: '{"categories":"vip","intent":"list"}', reward: 1, rubric: "Must extract: categories=vip, intent=list. No searchTerm." },
    { id: "sc-2", input: { user: "User: How many contacts do I have?" }, expectedOutput: '{"intent":"count"}', reward: 1, rubric: "Must extract: intent=count. No categories or searchTerm." },
    { id: "sc-3", input: { user: "User: Find Sarah in my contacts" }, expectedOutput: '{"searchTerm":"Sarah","intent":"list"}', reward: 1, rubric: "Must extract: searchTerm=Sarah, intent=list." },
    { id: "sc-4", input: { user: "User: Show me my colleagues tagged with AI" }, expectedOutput: '{"categories":"colleague","tags":"ai","intent":"list"}', reward: 1, rubric: "Must extract: categories=colleague, tags=ai, intent=list." },
    { id: "sc-5", input: { user: "User: Count how many investors I have" }, expectedOutput: '{"categories":"investor","intent":"count"}', reward: 1, rubric: "Must extract: categories=investor, intent=count." },
  ],

  // SCHEDULE_FOLLOW_UP_TEMPLATE — follow-up scheduling
  schedule_follow_up: [
    { id: "sfu-1", input: { user: "User: Remind me to follow up with David next Monday about the contract proposal.", "context": "current_datetime: 2026-05-20T10:00:00Z" }, expectedOutput: '{"contactName":"David","scheduledAt":"2026-05-25T09:00:00.000Z","reason":"Follow up on contract proposal","priority":"medium"}', reward: 1, rubric: "Must extract: David, next Monday date (~May 25), reason=contract proposal." },
    { id: "sfu-2", input: { user: "User: High priority — call Alice tomorrow at 3pm to discuss the funding round." }, expectedOutput: '{"contactName":"Alice","scheduledAt":"2026-05-21T15:00:00.000Z","reason":"Discuss funding round","priority":"high"}', reward: 1, rubric: "Must extract: Alice, tomorrow 3pm, priority=high, reason=funding round." },
    { id: "sfu-3", input: { user: "User: Low priority — maybe reach out to Bob sometime next week." }, expectedOutput: '{"contactName":"Bob","scheduledAt":null,"reason":null,"priority":"low"}', reward: 1, rubric: "Must extract: Bob, priority=low. scheduledAt null (vague 'sometime'). No specific reason." },
    { id: "sfu-4", input: { user: "User: Follow up with the dentist in 6 months for my next checkup. Tell them I need a cleaning." }, expectedOutput: '{"contactName":"dentist","scheduledAt":null,"reason":"Next checkup","priority":"medium","message":"Need a cleaning"}', reward: 1, rubric: "Must extract: dentist, message about cleaning, priority=medium. 6 months = relative date." },
  ],

  // EXTRACT_SECRET_OPERATION_TEMPLATE — secret management ops
  extract_secret_operation: [
    { id: "eso-1", input: { user: "User: What's my OpenAI API key?" }, expectedOutput: '{"operation":"get","key":"OPENAI_API_KEY"}', reward: 1, rubric: "Must extract: operation=get, key=OPENAI_API_KEY." },
    { id: "eso-2", input: { user: "User: Set my Discord bot token to Bot-abc123xyz" }, expectedOutput: '{"operation":"set","key":"DISCORD_BOT_TOKEN","value":"Bot-abc123xyz"}', reward: 1, rubric: "Must extract: operation=set, key=DISCORD_BOT_TOKEN, value=Bot-abc123xyz." },
    { id: "eso-3", input: { user: "User: Show me all my saved secrets" }, expectedOutput: '{"operation":"list"}', reward: 1, rubric: "Must extract: operation=list. No key needed." },
    { id: "eso-4", input: { user: "User: Delete my old Stripe key" }, expectedOutput: '{"operation":"delete","key":"STRIPE_API_KEY"}', reward: 1, rubric: "Must extract: operation=delete, key=STRIPE_API_KEY (inferred from 'Stripe key')." },
    { id: "eso-5", input: { user: "User: Do I have a Telegram token configured?" }, expectedOutput: '{"operation":"check","key":"TELEGRAM_BOT_TOKEN"}', reward: 1, rubric: "Must extract: operation=check, key=TELEGRAM_BOT_TOKEN (inferred)." },
    { id: "eso-6", input: { user: "User: My Anthropic key is sk-ant-abc123" }, expectedOutput: '{"operation":"set","key":"ANTHROPIC_API_KEY","value":"sk-ant-abc123"}', reward: 1, rubric: "Must extract: operation=set (providing a key = setting it), key=ANTHROPIC_API_KEY, value=sk-ant-abc123." },
    { id: "eso-7", input: { user: "User: Remove TWITTER_API_KEY from my config" }, expectedOutput: '{"operation":"delete","key":"TWITTER_API_KEY"}', reward: 1, rubric: "Must extract: operation=delete, key=TWITTER_API_KEY (explicitly named)." },
    { id: "eso-8", input: { user: "User: Is GITHUB_TOKEN set?" }, expectedOutput: '{"operation":"check","key":"GITHUB_TOKEN"}', reward: 1, rubric: "Must extract: operation=check, key=GITHUB_TOKEN." },
  ],

  // EXTRACT_SECRETS_TEMPLATE — extract secret key+value pairs
  extract_secrets: [
    { id: "es-1", input: { user: "User: Set my OpenAI key to sk-proj-abc123" }, expectedOutput: '{"secrets":[{"key":"OPENAI_API_KEY","value":"sk-proj-abc123","type":"api_key"}]}', reward: 1, rubric: "Must extract: key=OPENAI_API_KEY, value=sk-proj-abc123, type=api_key." },
    { id: "es-2", input: { user: "User: My database URL is postgres://user:pass@localhost:5432/mydb" }, expectedOutput: '{"secrets":[{"key":"DATABASE_URL","value":"postgres://user:pass@localhost:5432/mydb","type":"url"}]}', reward: 1, rubric: "Must infer key=DATABASE_URL, value=the postgres URL, type=url." },
    { id: "es-3", input: { user: "User: ANTHROPIC_API_KEY=sk-ant-xyz789 and OPENAI_API_KEY=sk-abc456" }, expectedOutput: '{"secrets":[{"key":"ANTHROPIC_API_KEY","value":"sk-ant-xyz789","type":"api_key"},{"key":"OPENAI_API_KEY","value":"sk-abc456","type":"api_key"}]}', reward: 1, rubric: "Must extract BOTH secrets correctly. Multiple secrets in one message." },
    { id: "es-4", input: { user: "User: Discord bot token is: MTA0NzI4..." }, expectedOutput: '{"secrets":[{"key":"DISCORD_BOT_TOKEN","value":"MTA0NzI4...","type":"credential"}]}', reward: 1, rubric: "Must infer key=DISCORD_BOT_TOKEN, type=credential." },
    { id: "es-5", input: { user: "User: How's the weather?" }, expectedOutput: '{"secrets":[]}', reward: 1, rubric: "Must return empty secrets array. No secrets in this message." },
  ],

  // OPTION_EXTRACTION_TEMPLATE — extract selected option from user
  option_extraction: [
    {
      id: "opex-1",
      input: { user: "Available tasks:\n- task_abc (Database Migration): Options: START, ABORT, PAUSE\nRecent messages:\nUser: Let's start the database migration.\nCurrent message: Yeah, go for it." },
      expectedOutput: '{"taskId":"task_abc","selectedOption":"START"}',
      reward: 1,
      rubric: "Must extract: taskId=task_abc, selectedOption=START.",
    },
    {
      id: "opex-2",
      input: { user: "Available tasks:\n- task_xyz (Deploy to Production): Options: CONFIRM, CANCEL\nRecent messages:\nUser: Actually, let's not deploy today.\nCurrent message: Yeah cancel it." },
      expectedOutput: '{"taskId":"task_xyz","selectedOption":"CANCEL"}',
      reward: 1,
      rubric: "Must extract: taskId=task_xyz, selectedOption=CANCEL.",
    },
    {
      id: "opex-3",
      input: { user: "Available tasks:\n- task_123 (Send Newsletter): Options: SEND_NOW, SCHEDULE, ABORT\nRecent messages:\nUser: Can we schedule it for later?\nCurrent message: yeah schedule please." },
      expectedOutput: '{"taskId":"task_123","selectedOption":"SCHEDULE"}',
      reward: 1,
      rubric: "Must extract: taskId=task_123, selectedOption=SCHEDULE.",
    },
    {
      id: "opex-4",
      input: { user: "Available tasks:\n- task_789 (Data Export): Options: CSV, JSON, PDF\nRecent messages:\nUser: I haven't decided yet.\nCurrent message: hmm maybe later." },
      expectedOutput: '{"taskId":null,"selectedOption":null}',
      reward: 1,
      rubric: "Must return null for both. User hasn't made a clear selection.",
    },
  ],

  // UPDATE_ROLE_TEMPLATE — role change extraction
  update_role: [
    { id: "ur-1", input: { user: "User: Make Sarah an admin.\nContext: Users: Sarah (MEMBER, id: user-sarah-123)" }, expectedOutput: '{"thought":"Sarah\'s role should be elevated to admin","entity_id":"user-sarah-123","new_role":"ADMIN"}', reward: 1, rubric: "Must extract: entity_id=user-sarah-123, new_role=ADMIN." },
    { id: "ur-2", input: { user: "User: Remove Alice's admin access.\nContext: Users: Alice (ADMIN, id: user-alice-456)" }, expectedOutput: '{"thought":"Remove elevated access from Alice","entity_id":"user-alice-456","new_role":"MEMBER"}', reward: 1, rubric: "Must extract: entity_id=user-alice-456, new_role=MEMBER (downgrade from ADMIN)." },
    { id: "ur-3", input: { user: "User: Make Bob the owner.\nContext: Users: Bob (ADMIN, id: user-bob-789)" }, expectedOutput: '{"thought":"Promote Bob to owner role","entity_id":"user-bob-789","new_role":"OWNER"}', reward: 1, rubric: "Must extract: new_role=OWNER." },
    { id: "ur-4", input: { user: "User: Kick Charlie from the team entirely.\nContext: Users: Charlie (MEMBER, id: user-charlie-000)" }, expectedOutput: '{"thought":"Remove Charlie from team","entity_id":"user-charlie-000","new_role":"NONE"}', reward: 1, rubric: "Must extract: new_role=NONE (no role = removed)." },
    { id: "ur-5", input: { user: "User: Give the new hire guest access.\nContext: Users: NewUser (no role, id: user-new-111)" }, expectedOutput: '{"thought":"Assign guest role to new hire","entity_id":"user-new-111","new_role":"GUEST"}', reward: 1, rubric: "Must extract: new_role=GUEST." },
  ],
};

// ── Task configuration ─────────────────────────────────────────────────────────

// Tasks that benefit from LLM-as-judge (open-ended or structured JSON responses)
const JUDGE_TASKS = new Set([
  "response", "media_description", "conversation_summary",
  "reply", "memory_qa", "reflection", "update_summarization",
  "image_generation", "post_creation",
]);

// ── Main eval loop ────────────────────────────────────────────────────────────

interface TaskResult {
  task: string;
  baselineScore: number;
  optimizedScore: number;
  improvement: number;
  improvementPct: number;
  optimizedPromptLength: number;
  baselinePromptLength: number;
  tokenStats: { avgTemplateTokens: number; avgTotalInputTokens: number };
  optimizedPrompt: string;
}

async function evalTask(task: string): Promise<TaskResult> {
  console.log(`\n${"═".repeat(64)}`);
  console.log(`Task: ${task}`);
  console.log("═".repeat(64));

  const baselinePrompt = BASELINE_PROMPTS[task]!;
  const dataset = SYNTHETIC_DATASETS[task]!;
  const useJudge = JUDGE_TASKS.has(task);
  const adapter = { complete: async (i: { system?: string; user: string; temperature?: number; maxTokens?: number }) => (await callCerebras(i.system, i.user, i.temperature ?? 0, i.maxTokens ?? 1024)).text };
  const scorer = buildScorer(task, adapter, useJudge);

  // Count template tokens across dataset
  let totalTemplateTokens = 0;
  let totalInputTokens = 0;
  for (const ex of dataset) {
    const r = countPromptTokens(baselinePrompt, ex.input.user);
    totalTemplateTokens += r.templateTokens;
    totalInputTokens += r.totalInputTokens;
  }
  const avgTemplateTokens = Math.round(totalTemplateTokens / dataset.length);
  const avgTotalInputTokens = Math.round(totalInputTokens / dataset.length);

  console.log(`  Baseline: ${baselinePrompt.length} chars (~${countTokensApprox(baselinePrompt)} tokens)`);
  console.log(`  Dataset: ${dataset.length} examples | scorer: ${useJudge ? "llm-judge" : "exact"}`);
  console.log(`  Avg template tokens: ${avgTemplateTokens} | avg total input: ${avgTotalInputTokens}`);
  console.log(`  GEPA: ${GEPA_GENERATIONS} generations × population ${GEPA_POPULATION}`);

  const result = await runGepa(task, baselinePrompt, dataset, scorer, GEPA_GENERATIONS, GEPA_POPULATION);

  const improvement = result.score - result.baseline;
  const improvementPct = result.baseline === 0 ? 0 : (improvement / result.baseline) * 100;

  console.log(`\n  ── Results ──`);
  console.log(`  Baseline:   ${result.baseline.toFixed(4)}`);
  console.log(`  Optimized:  ${result.score.toFixed(4)}`);
  console.log(`  Delta:      ${improvement >= 0 ? "+" : ""}${improvement.toFixed(4)} (${improvementPct >= 0 ? "+" : ""}${improvementPct.toFixed(1)}%)`);
  console.log(`  Lineage:    ${result.lineage.length} steps`);

  // Save prompts
  mkdirSync(EXPORT_DIR, { recursive: true });
  writeFileSync(join(EXPORT_DIR, `${task}-optimized.txt`), result.optimizedPrompt, "utf-8");
  writeFileSync(join(EXPORT_DIR, `${task}-baseline.txt`), baselinePrompt, "utf-8");

  logTrajectory({
    timestamp: new Date().toISOString(), task, optimizer: OPTIMIZER, step: "final-result",
    score: result.score,
    notes: `baseline=${result.baseline.toFixed(4)} optimized=${result.score.toFixed(4)} delta=${improvement.toFixed(4)} pct=${improvementPct.toFixed(1)}%`,
  });

  return {
    task, baselineScore: result.baseline, optimizedScore: result.score,
    improvement, improvementPct,
    optimizedPromptLength: result.optimizedPrompt.length,
    baselinePromptLength: baselinePrompt.length,
    tokenStats: { avgTemplateTokens, avgTotalInputTokens },
    optimizedPrompt: result.optimizedPrompt,
  };
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║     Eliza Prompt Optimization Eval v2 — GEPA 5-experiment    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`\nOptimizer:   ${OPTIMIZER}`);
  console.log(`Model:       ${CEREBRAS_MODEL}`);
  console.log(`Generations: ${GEPA_GENERATIONS}  Population: ${GEPA_POPULATION}`);
  console.log(`Export dir:  ${EXPORT_DIR}`);

  const allTasks = Object.keys(BASELINE_PROMPTS);
  const tasks = EVAL_TASKS ? allTasks.filter(t => EVAL_TASKS.includes(t)) : allTasks;
  console.log(`\nRunning tasks: ${tasks.join(", ")}`);

  const results: TaskResult[] = [];

  for (const task of tasks) {
    try {
      results.push(await evalTask(task));
    } catch (err) {
      console.error(`\n  Task ${task} failed:`, err);
      logTrajectory({ timestamp: new Date().toISOString(), task, optimizer: OPTIMIZER, step: "error", notes: String(err) });
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(74)}`);
  console.log("SUMMARY");
  console.log("═".repeat(74));
  console.log(`${"Task".padEnd(22)} ${"Baseline".padStart(9)} ${"Optimized".padStart(10)} ${"Delta".padStart(14)} ${"TmplTok".padStart(8)} ${"TotalTok".padStart(9)}`);
  console.log("─".repeat(74));

  let totalImprovement = 0;
  let improvedCount = 0;

  for (const r of results) {
    const delta = (r.improvement >= 0 ? "+" : "") + r.improvement.toFixed(4);
    const pct = (r.improvementPct >= 0 ? "+" : "") + r.improvementPct.toFixed(1) + "%";
    console.log(
      `${r.task.padEnd(22)} ${r.baselineScore.toFixed(4).padStart(9)} ${r.optimizedScore.toFixed(4).padStart(10)} ${(delta + " " + pct).padStart(14)} ${r.tokenStats.avgTemplateTokens.toString().padStart(8)} ${r.tokenStats.avgTotalInputTokens.toString().padStart(9)}`
    );
    if (r.improvement > 0) improvedCount++;
    totalImprovement += r.improvement;
  }

  const avgImprovement = results.length > 0 ? totalImprovement / results.length : 0;
  console.log("─".repeat(74));
  console.log(`Tasks improved: ${improvedCount}/${results.length}`);
  console.log(`Avg score delta: ${avgImprovement >= 0 ? "+" : ""}${avgImprovement.toFixed(4)}`);
  console.log(`\nTotal API calls:        ${totalApiCalls}`);
  console.log(`Total prompt tokens:    ${totalPromptTokens.toLocaleString()}`);
  console.log(`Total completion tokens:${totalCompletionTokens.toLocaleString()}`);
  console.log(`Total tokens:           ${(totalPromptTokens + totalCompletionTokens).toLocaleString()}`);

  // Show best optimized prompts
  console.log(`\n${"═".repeat(64)}`);
  console.log("OPTIMIZED PROMPTS (best per task)");
  console.log("═".repeat(64));
  for (const r of results) {
    console.log(`\n── ${r.task} (score: ${r.baselineScore.toFixed(4)} → ${r.optimizedScore.toFixed(4)}) ──`);
    console.log(r.optimizedPrompt.slice(0, 600));
    if (r.optimizedPrompt.length > 600) console.log("  … (truncated, see file)");
  }

  // Export
  mkdirSync(EXPORT_DIR, { recursive: true });
  const { jsonlPath, readablePath } = exportTrajectories(EXPORT_DIR);

  const summaryPath = join(EXPORT_DIR, "eval-summary.json");
  writeFileSync(summaryPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    optimizer: OPTIMIZER,
    model: CEREBRAS_MODEL,
    gepaGenerations: GEPA_GENERATIONS,
    gepaPopulation: GEPA_POPULATION,
    results,
    totals: { improvedCount, totalTasks: results.length, avgImprovement, totalApiCalls, totalPromptTokens, totalCompletionTokens },
  }, null, 2), "utf-8");

  console.log(`\nExported:`);
  console.log(`  Summary:  ${summaryPath}`);
  console.log(`  JSONL:    ${jsonlPath}`);
  console.log(`  Readable: ${readablePath}`);
  console.log(`  Prompts:  ${EXPORT_DIR}/<task>-{baseline,optimized}.txt`);

  if (improvedCount === 0 && results.length > 0) {
    console.log(`\n⚠  No tasks improved. Check trajectory log for details.`);
    process.exit(1);
  }

  console.log(`\n✓ Eval complete. ${improvedCount}/${results.length} tasks improved.`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
