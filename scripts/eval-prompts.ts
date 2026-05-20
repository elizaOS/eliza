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
      } else if (task === "fact_extraction" || task === "extract_action_params") {
        // Struct-aware judge for JSON output with specific structure
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
};

// ── Task configuration ─────────────────────────────────────────────────────────

// Tasks that benefit from LLM-as-judge (open-ended or structured JSON responses)
const JUDGE_TASKS = new Set(["response", "media_description", "conversation_summary"]);

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
