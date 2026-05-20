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

async function llmJudgeScore(userQuery: string, response: string, rubric?: string): Promise<number> {
  const judgeUser = `Question: ${userQuery}\n\nResponse: ${response}${rubric ? `\n\nAdditional rubric: ${rubric}` : ""}`;
  const { text } = await callCerebras(JUDGE_SYSTEM, judgeUser, 0, 512);
  const num = parseFloat(text.trim());
  if (isNaN(num) || num < 0 || num > 1) return 0.5;
  return num;
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
      } else if (task === "should_respond") {
        const aYes = actual.toLowerCase().includes("yes") || actual.toLowerCase().includes("respond") || actual.toLowerCase().includes('"action":"respond"') || actual.toLowerCase().includes("respond");
        const eYes = ex.expectedOutput.toLowerCase().includes("yes") || ex.expectedOutput.toLowerCase().includes("respond");
        const aNo = !aYes || actual.toLowerCase().includes("no") || actual.toLowerCase().includes("ignore");
        const eNo = !eYes;
        // Both "YES/NO" and "RESPOND/IGNORE" formats
        const aVerdict = aYes && !actual.toLowerCase().includes("ignore") ? "yes" : "no";
        const eVerdict = eYes ? "yes" : "no";
        total += aVerdict === eVerdict ? 1 : 0;
      } else if (useJudge) {
        // LLM-as-judge for open-ended tasks
        const score = await llmJudgeScore(ex.input.user, actual, ex.rubric);
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

    // Reflect: sample a few failures
    const batch = dataset.slice(0, Math.min(4, dataset.length));
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

Available actions:
- REPLY: Send a text response to the user
- SEARCH: Look up information on the internet
- SCHEDULE: Create a calendar event
- REMIND: Set a reminder for the user
- NOTES: Save a note or piece of information
- NONE: No action needed

Return ONLY a JSON object in this exact format:
{"toolCalls": [{"name": "ACTION_NAME", "args": {}}]}

No explanation. JSON only.`,

  response: `Respond to the user's message. Be concise and direct.

Guidelines:
- Use a friendly, conversational tone
- Answer the question or fulfill the request directly
- If you don't know something, say so honestly
- Keep responses focused and not overly long`,

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
    { id: "ap-1", input: { user: "User wants to schedule a dentist appointment for next Tuesday at 2pm." }, expectedOutput: '{"toolCalls":[{"name":"SCHEDULE","args":{"title":"Dentist appointment","time":"next Tuesday 2pm"}}]}', reward: 1 },
    { id: "ap-2", input: { user: "User asked what the weather is like today in San Francisco." }, expectedOutput: '{"toolCalls":[{"name":"SEARCH","args":{"query":"weather San Francisco today"}}]}', reward: 1 },
    { id: "ap-3", input: { user: "User said hello and asked how you're doing." }, expectedOutput: '{"toolCalls":[{"name":"REPLY","args":{"message":"I\'m doing well, thanks for asking!"}}]}', reward: 1 },
    { id: "ap-4", input: { user: "User wants to be reminded to call their doctor in 2 hours." }, expectedOutput: '{"toolCalls":[{"name":"REMIND","args":{"message":"Call doctor","delay":"2 hours"}}]}', reward: 1 },
    { id: "ap-5", input: { user: "User wants to save a note about a new project idea: a mobile app for tracking workouts." }, expectedOutput: '{"toolCalls":[{"name":"NOTES","args":{"content":"Project idea: mobile app for tracking workouts"}}]}', reward: 1 },
    { id: "ap-6", input: { user: "User said goodbye and that they'll talk later." }, expectedOutput: '{"toolCalls":[{"name":"REPLY","args":{"message":"Goodbye! Talk later!"}}]}', reward: 1 },
    { id: "ap-7", input: { user: "User wants to find restaurants near downtown Seattle." }, expectedOutput: '{"toolCalls":[{"name":"SEARCH","args":{"query":"restaurants near downtown Seattle"}}]}', reward: 1 },
    { id: "ap-8", input: { user: "User wants a reminder to submit the quarterly report on Friday at 5pm." }, expectedOutput: '{"toolCalls":[{"name":"REMIND","args":{"message":"Submit quarterly report","time":"Friday 5pm"}}]}', reward: 1 },
    // Harder examples
    { id: "ap-9", input: { user: "User is asking who won the Super Bowl last year." }, expectedOutput: '{"toolCalls":[{"name":"SEARCH","args":{"query":"Super Bowl winner last year"}}]}', reward: 1 },
    { id: "ap-10", input: { user: "User says 'block off 2-3pm Thursday for a team sync'." }, expectedOutput: '{"toolCalls":[{"name":"SCHEDULE","args":{"title":"Team sync","time":"Thursday 2-3pm"}}]}', reward: 1 },
    { id: "ap-11", input: { user: "User wants to jot down that they need to pick up milk and eggs." }, expectedOutput: '{"toolCalls":[{"name":"NOTES","args":{"content":"Pick up milk and eggs"}}]}', reward: 1 },
    { id: "ap-12", input: { user: "User just sent a thumbs up emoji." }, expectedOutput: '{"toolCalls":[{"name":"NONE","args":{}}]}', reward: 0 },
  ],

  response: [
    { id: "resp-1", input: { user: "What's the best way to learn programming?" }, expectedOutput: "Start with Python - it has clear syntax and lots of learning resources. Focus on building small projects, practice daily, and use platforms like Codecademy or freeCodeCamp.", reward: 1, rubric: "Should give concrete, actionable advice with specific resources" },
    { id: "resp-2", input: { user: "Can you explain what machine learning is in simple terms?" }, expectedOutput: "Machine learning is teaching computers to learn from examples rather than explicit rules. Like how a child learns to recognize cats by seeing many cat photos, ML models learn patterns from data to make predictions.", reward: 1, rubric: "Should use an analogy to explain clearly, without jargon" },
    { id: "resp-3", input: { user: "What are some healthy breakfast options?" }, expectedOutput: "Great options include oatmeal with berries, Greek yogurt with nuts, eggs with vegetables, or whole grain toast with avocado. These provide protein, fiber, and nutrients to start your day.", reward: 1, rubric: "Should list concrete specific options with brief reasons" },
    { id: "resp-4", input: { user: "How do I improve my time management skills?" }, expectedOutput: "Try time blocking - schedule specific tasks in your calendar. Use Pomodoro technique (25-min focus, 5-min break), prioritize by urgency and importance, and eliminate distractions during focus time.", reward: 1, rubric: "Should give practical, actionable techniques, not vague advice" },
    { id: "resp-5", input: { user: "What should I do if I can't sleep at night?" }, expectedOutput: "Keep a consistent sleep schedule, avoid screens an hour before bed, keep your room cool and dark, and try deep breathing or meditation. Avoid caffeine after 2pm.", reward: 1, rubric: "Should give specific, evidence-based sleep hygiene tips" },
    { id: "resp-6", input: { user: "What's the difference between a CPU and a GPU?" }, expectedOutput: "A CPU handles general tasks with a few powerful cores, great for sequential operations. A GPU has thousands of smaller cores for parallel tasks, ideal for graphics and AI computations.", reward: 1, rubric: "Should explain the core architectural difference and use cases clearly" },
    { id: "resp-7", input: { user: "How do I stay motivated when working on long projects?" }, expectedOutput: "Break the project into small milestones and celebrate each one. Set daily goals, track progress visually, find an accountability partner, and remind yourself of the project's purpose.", reward: 1, rubric: "Should give practical strategies, not just say 'stay positive'" },
    { id: "resp-8", input: { user: "What's 15% of 240?" }, expectedOutput: "15% of 240 is 36.", reward: 1, rubric: "Should give the exact correct numerical answer immediately" },
    { id: "resp-9", input: { user: "How do you make a basic vinaigrette?" }, expectedOutput: "Whisk together 1 part vinegar (or lemon juice) with 3 parts olive oil, plus salt and pepper. Add Dijon mustard to help emulsify. Adjust to taste.", reward: 1, rubric: "Should give a specific recipe with ratios" },
    { id: "resp-10", input: { user: "What is the capital of Australia?" }, expectedOutput: "Canberra is the capital of Australia.", reward: 1, rubric: "Should give the correct factual answer directly (NOT Sydney)" },
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
};

// ── Task configuration ─────────────────────────────────────────────────────────

// Tasks that benefit from LLM-as-judge (open-ended responses)
const JUDGE_TASKS = new Set(["response", "media_description"]);

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
