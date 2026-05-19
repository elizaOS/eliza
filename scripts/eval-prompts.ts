/**
 * End-to-end prompt optimization eval harness.
 *
 * Runs GEPA (and bootstrap-fewshot) optimization over the 5 core training
 * tasks, counts prompt tokens (template + total input), exports a trajectory
 * log, and reports score improvement over baseline.
 *
 * Usage:
 *   CEREBRAS_API_KEY=csk-... bun run scripts/eval-prompts.ts
 *
 * Env:
 *   CEREBRAS_API_KEY   — required
 *   CEREBRAS_MODEL     — default gpt-oss-120b
 *   EVAL_OPTIMIZER     — gepa | bootstrap-fewshot | dspy-mipro (default gepa)
 *   GEPA_GENERATIONS   — default 4 (reduced for faster eval)
 *   GEPA_POPULATION    — default 6
 *   EXPORT_DIR         — default /tmp/eliza-eval-<timestamp>
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
const GEPA_GENERATIONS = parseInt(process.env.GEPA_GENERATIONS ?? "4", 10);
const GEPA_POPULATION = parseInt(process.env.GEPA_POPULATION ?? "6", 10);
const EXPORT_DIR = process.env.EXPORT_DIR ?? `/tmp/eliza-eval-${Date.now()}`;

if (!CEREBRAS_API_KEY) {
  console.error("CEREBRAS_API_KEY is required");
  process.exit(1);
}

// ── Token counting ────────────────────────────────────────────────────────────

/** Approximate token count using GPT-2/4 word-piece heuristic (~4 chars/token). */
function countTokensApprox(text: string): number {
  if (!text) return 0;
  // Split on whitespace and punctuation boundaries, ~4 chars per token average
  const words = text.split(/\s+/).filter(Boolean);
  let count = 0;
  for (const word of words) {
    // Long words split into multiple tokens; short words are 1 token
    count += Math.ceil(word.length / 4);
  }
  return count;
}

interface TemplateTokenReport {
  templateTokens: number;   // tokens in the system prompt template itself
  userTokens: number;       // tokens in the user input
  totalInputTokens: number; // template + user (what the model sees as input)
}

function countPromptTokens(system: string | undefined, user: string): TemplateTokenReport {
  const templateTokens = countTokensApprox(system ?? "");
  const userTokens = countTokensApprox(user);
  return {
    templateTokens,
    userTokens,
    totalInputTokens: templateTokens + userTokens,
  };
}

// ── Cerebras API client ───────────────────────────────────────────────────────

interface CerebrasResponse {
  text: string;
  usage: TokenUsage;
}

let totalApiCalls = 0;
let totalPromptTokens = 0;
let totalCompletionTokens = 0;

async function callCerebras(
  system: string | undefined,
  user: string,
  temperature = 0,
  maxTokens = 1024,
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

function buildAdapter(): LlmAdapter {
  return {
    async complete(input) {
      const { text } = await callCerebras(
        input.system,
        input.user,
        input.temperature ?? 0,
        input.maxTokens ?? 1024,
      );
      return text;
    },
  };
}

// ── Scorer ────────────────────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0),
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

function buildScorer(task: string, adapter: LlmAdapter) {
  // gpt-oss-120b uses reasoning_effort=low which consumes internal tokens;
  // 1024 gives enough budget for both reasoning and a short classification output.
  const scorerMaxTokens = 1024;
  return async (prompt: string, examples: OptimizationExample[]): Promise<number> => {
    if (examples.length === 0) return 0;
    let total = 0;
    for (const ex of examples) {
      const resp = await callCerebras(prompt, ex.input.user, 0, scorerMaxTokens);
      const actual = resp.text;
      if (task === "action_planner") {
        const a = extractPlannerAction(actual);
        const e = extractPlannerAction(ex.expectedOutput);
        total += a && e && a === e ? 1 : 0;
      } else if (task === "should_respond") {
        const a = actual.toLowerCase().includes("yes") ? "yes" : "no";
        const e = ex.expectedOutput.toLowerCase().includes("yes") ? "yes" : "no";
        total += a === e ? 1 : 0;
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
  const lines = trajectories.map((t) => JSON.stringify(t)).join("\n");
  writeFileSync(jsonlPath, lines + "\n", "utf-8");

  const readablePath = join(dir, "trajectories-readable.txt");
  const readable = trajectories
    .map((t) => {
      const lines: string[] = [
        `─── ${t.timestamp} [${t.task}] ${t.optimizer} / ${t.step} ───`,
      ];
      if (t.score !== undefined) lines.push(`  score: ${t.score.toFixed(4)}`);
      if (t.tokenUsage) {
        lines.push(
          `  tokens: prompt=${t.tokenUsage.promptTokens} completion=${t.tokenUsage.completionTokens} total=${t.tokenUsage.totalTokens}`,
        );
      }
      if (t.systemPrompt) lines.push(`  system: ${t.systemPrompt.slice(0, 200)}…`);
      if (t.userInput) lines.push(`  user: ${t.userInput.slice(0, 200)}`);
      if (t.output) lines.push(`  output: ${t.output.slice(0, 300)}`);
      if (t.notes) lines.push(`  notes: ${t.notes}`);
      return lines.join("\n");
    })
    .join("\n\n");
  writeFileSync(readablePath, readable + "\n", "utf-8");

  console.log(`\nTrajectories exported:`);
  console.log(`  JSONL: ${jsonlPath}`);
  console.log(`  Readable: ${readablePath}`);
  return { jsonlPath, readablePath };
}

// ── GEPA Optimizer (inline, instrumented) ────────────────────────────────────

const SYS_FEEDBACK = `Revise the SYSTEM PROMPT below based on observed failure analysis.

You will receive the current prompt and a short feedback note explaining what went wrong. Produce a revised prompt that addresses the feedback. Preserve the task contract (inputs, outputs, format) and every literal placeholder ({{agentName}}, {{providers}}, etc.) byte-identical. Output only the revised prompt body. No commentary, no fenced code blocks.`;

const SYS_COMPRESS = `Reduce the SYSTEM PROMPT below to its essentials.

Rewrite it shorter while preserving every contract guarantee. Drop redundant phrasing, collapse parallel rules, remove decorative bullets and meta-commentary. Keep every literal placeholder byte-identical. Output only the revised prompt body. No commentary, no fenced code blocks.`;

const SYS_CROSSOVER = `Merge two candidate SYSTEM PROMPTS into one.

You will receive PROMPT A and PROMPT B. Produce a single prompt that takes the strongest guidance from each. Preserve the task contract and every literal placeholder. Do not exceed 1.2x the longer parent's character count. Output only the merged prompt body. No commentary, no fenced code blocks.`;

const SYS_REFLECT = `You are diagnosing why a SYSTEM PROMPT is failing.

You will receive the current prompt and a small batch of examples: each shows the user input, the model's actual output, and the expected output. Write a SHORT diagnostic (max 4 sentences) naming the concrete failure mode and a specific change to the prompt that would fix it. No filler. No restatement of the prompt. Output plain text only.`;

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
    if (!dominated && !frontier.some((c) => c.prompt === cur.prompt)) {
      frontier.push(cur);
    }
  }
  return frontier;
}

async function runGepaInstrumented(
  task: string,
  baselinePrompt: string,
  dataset: OptimizationExample[],
  scorer: (p: string, ex: OptimizationExample[]) => Promise<number>,
  generations: number,
  population: number,
): Promise<OptimizerResult> {
  const lineage: Array<{ round: number; variant: number; score: number; notes?: string }> = [];
  const timestamp = () => new Date().toISOString();

  async function scoreAndReflect(
    prompt: string,
    origin: string,
    round: number,
    variant: number,
  ): Promise<Candidate> {
    const score = await scorer(prompt, dataset);
    logTrajectory({
      timestamp: timestamp(),
      task,
      optimizer: "gepa",
      step: `gen${round}-${origin}`,
      score,
      notes: `variant=${variant} prompt_tokens_approx=${approxTokens(prompt)}`,
    });

    // Reflection: show the LLM what went wrong
    const batch = dataset.slice(0, 3);
    const transcripts: string[] = [];
    for (let i = 0; i < batch.length; i++) {
      const ex = batch[i]!;
      const { text: actual, usage } = await callCerebras(prompt, ex.input.user, 0, 1024);
      const tokenReport = countPromptTokens(prompt, ex.input.user);
      logTrajectory({
        timestamp: timestamp(),
        task,
        optimizer: "gepa",
        step: `gen${round}-reflect-${i}`,
        systemPrompt: prompt.slice(0, 400),
        userInput: ex.input.user.slice(0, 200),
        output: actual.slice(0, 300),
        tokenUsage: usage,
        notes: `template_tokens=${tokenReport.templateTokens} user_tokens=${tokenReport.userTokens} total_input=${tokenReport.totalInputTokens}`,
      });
      transcripts.push(
        `Example ${i + 1}:\nUser: ${truncate(ex.input.user, 300)}\nActual: ${truncate(actual, 300)}\nExpected: ${truncate(ex.expectedOutput, 300)}`,
      );
    }
    const reflectUser = `Prompt:\n${prompt}\n\n${transcripts.join("\n\n")}`;
    const { text: feedback } = await callCerebras(SYS_REFLECT, reflectUser, 0.4, 512);

    const note =
      origin === "baseline" ? "baseline" :
      origin.includes("compress") ? `${origin} | tokens=${approxTokens(prompt)}` :
      `${origin} | ${truncate(feedback, 80)}`;
    lineage.push({ round, variant, score, notes: note });
    return { prompt, score, tokens: approxTokens(prompt), feedback, origin };
  }

  async function mutate(prompt: string, feedback: string, mode: "feedback" | "compress"): Promise<string> {
    if (mode === "compress") {
      const { text } = await callCerebras(SYS_COMPRESS, prompt, 0.8, 1024);
      return text.trim() || prompt;
    }
    const user = `Current prompt:\n${prompt}\n\nFailure analysis:\n${feedback || "(none — explore a phrasing change)"}`;
    const { text } = await callCerebras(SYS_FEEDBACK, user, 0.8, 1024);
    return text.trim() || prompt;
  }

  console.log(`\n  [GEPA] scoring baseline...`);
  const baseline = await scoreAndReflect(baselinePrompt, "baseline", 0, 0);
  let pool: Candidate[] = [baseline];

  // Seed population
  for (let i = 1; i < population; i++) {
    const mode: "feedback" | "compress" = i % 2 === 0 ? "compress" : "feedback";
    const seed = await mutate(baselinePrompt, baseline.feedback, mode);
    pool.push(await scoreAndReflect(seed, `seed-${mode}`, 0, i));
  }

  for (let gen = 1; gen <= generations; gen++) {
    console.log(`  [GEPA] generation ${gen}/${generations}, pool=${pool.length}, best=${Math.max(...pool.map(c => c.score)).toFixed(4)}`);
    const frontier = paretoFrontier(pool);
    const next: Candidate[] = [...frontier];
    let vi = next.length;

    for (const parent of frontier) {
      if (next.length >= population) break;
      const child = await mutate(parent.prompt, parent.feedback, "feedback");
      next.push(await scoreAndReflect(child, "feedback-mut", gen, vi++));
      if (next.length >= population) break;
      const comp = await mutate(parent.prompt, "", "compress");
      next.push(await scoreAndReflect(comp, "compress-mut", gen, vi++));
    }

    if (next.length < population && frontier.length >= 2) {
      const [a, b] = [...frontier].sort((x, y) => y.score - x.score);
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

// ── Bootstrap-fewshot optimizer ───────────────────────────────────────────────

async function runBootstrapInstrumented(
  task: string,
  baselinePrompt: string,
  dataset: OptimizationExample[],
  scorer: (p: string, ex: OptimizationExample[]) => Promise<number>,
): Promise<OptimizerResult> {
  const timestamp = () => new Date().toISOString();
  const lineage: Array<{ round: number; variant: number; score: number; notes?: string }> = [];

  console.log(`  [bootstrap-fewshot] scoring baseline...`);
  const baselineScore = await scorer(baselinePrompt, dataset);
  lineage.push({ round: 0, variant: 0, score: baselineScore, notes: "baseline" });
  logTrajectory({ timestamp: timestamp(), task, optimizer: "bootstrap-fewshot", step: "baseline", score: baselineScore });

  // Pick top-5 examples with highest reward
  const ranked = [...dataset].sort((a, b) => (b.reward ?? 0) - (a.reward ?? 0));
  const fewShot = ranked.slice(0, 5);

  // Build demonstrations block
  const demoLines = ["Demonstrations:", ""];
  fewShot.forEach((ex, i) => {
    demoLines.push(`Example ${i + 1}:`);
    demoLines.push(`Input:\n${ex.input.user.slice(0, 600)}`);
    demoLines.push(`Expected:\n${ex.expectedOutput}`);
    demoLines.push("");
  });
  const demos = demoLines.join("\n").trimEnd();
  const optimizedPrompt = `${baselinePrompt.trimEnd()}\n\n${demos}\n`;

  const optimizedScore = await scorer(optimizedPrompt, dataset);
  lineage.push({ round: 1, variant: 1, score: optimizedScore, notes: `injected ${fewShot.length} demonstrations` });
  logTrajectory({ timestamp: timestamp(), task, optimizer: "bootstrap-fewshot", step: "optimized", score: optimizedScore });

  return { optimizedPrompt, score: optimizedScore, baseline: baselineScore, lineage, fewShotExamples: fewShot };
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
- SEARCH: Look up information
- SCHEDULE: Create a calendar event
- REMIND: Set a reminder
- NOTES: Save a note
- NONE: No action needed

Return a JSON object: {"toolCalls": [{"name": "ACTION_NAME", "args": {}}]}`,

  response: `Respond to the user's message. Be concise and direct.

Guidelines:
- Use a friendly, conversational tone
- Answer the question or fulfill the request
- If you don't know something, say so honestly`,

  media_description: `Describe the media file (image, audio, or video).

Include:
- What is shown/heard
- Key visual elements, people, objects, or sounds
- Any text or labels visible
- The overall context or setting

Be objective and factual. Do not make assumptions beyond what is clearly present.`,
};

// ── Synthetic training examples ───────────────────────────────────────────────

const SYNTHETIC_DATASETS: Record<string, OptimizationExample[]> = {
  // Harder should_respond: ambiguous third-party mentions, @-mentions in middle of text,
  // implicit references, system noise. Baseline prompt misses several of these.
  should_respond: [
    { id: "sr-1", input: { user: "@assistant can you help me schedule a meeting for tomorrow at 3pm?" }, expectedOutput: "YES", reward: 1 },
    { id: "sr-2", input: { user: "Hey John, can you grab lunch today?" }, expectedOutput: "NO", reward: 0 },
    { id: "sr-3", input: { user: "What time is it in Tokyo right now?" }, expectedOutput: "YES", reward: 1 },
    { id: "sr-4", input: { user: "lol that's hilarious" }, expectedOutput: "NO", reward: 0 },
    // Harder: the agent's name appears but mid-sentence with no question
    { id: "sr-5", input: { user: "I was talking to the assistant yesterday and it helped me" }, expectedOutput: "NO", reward: 0 },
    { id: "sr-6", input: { user: "Anyone else going to the party tonight?" }, expectedOutput: "NO", reward: 0 },
    { id: "sr-7", input: { user: "Hey assistant, can you summarize this article for me?" }, expectedOutput: "YES", reward: 1 },
    // Harder: statement of fact that seems like it might need a reply
    { id: "sr-8", input: { user: "The meeting got moved to 4pm" }, expectedOutput: "NO", reward: 0 },
    { id: "sr-9", input: { user: "Can someone look up the flight status for AA 1234?" }, expectedOutput: "YES", reward: 1 },
    // Harder: multi-party conversation fragment
    { id: "sr-10", input: { user: "alice: did you get my email? bob: yeah got it" }, expectedOutput: "NO", reward: 0 },
    { id: "sr-11", input: { user: "Can you help me write an email to my boss?" }, expectedOutput: "YES", reward: 1 },
    // Harder: question but not directed at assistant
    { id: "sr-12", input: { user: "Does anyone know where the conference room is?" }, expectedOutput: "YES", reward: 1 },
    { id: "sr-13", input: { user: "ok ttyl everyone" }, expectedOutput: "NO", reward: 0 },
    // Harder: passive construction that looks like a task for the agent
    { id: "sr-14", input: { user: "The report needs to be sent by Friday" }, expectedOutput: "NO", reward: 0 },
    { id: "sr-15", input: { user: "assistant what day of the week is it?" }, expectedOutput: "YES", reward: 1 },
    // Harder: gibberish / emoji
    { id: "sr-16", input: { user: "🎉🎊🥳" }, expectedOutput: "NO", reward: 0 },
  ],

  action_planner: [
    { id: "ap-1", input: { user: "User wants to schedule a dentist appointment for next Tuesday at 2pm. Current time: Monday 10am." }, expectedOutput: '{"toolCalls":[{"name":"SCHEDULE","args":{"title":"Dentist appointment","time":"next Tuesday 2pm"}}]}', reward: 1 },
    { id: "ap-2", input: { user: "User asked what the weather is like today in San Francisco." }, expectedOutput: '{"toolCalls":[{"name":"SEARCH","args":{"query":"weather San Francisco today"}}]}', reward: 1 },
    { id: "ap-3", input: { user: "User said hello and asked how you're doing." }, expectedOutput: '{"toolCalls":[{"name":"REPLY","args":{"message":"I\'m doing well, thanks for asking!"}}]}', reward: 1 },
    { id: "ap-4", input: { user: "User wants to be reminded to call their doctor in 2 hours." }, expectedOutput: '{"toolCalls":[{"name":"REMIND","args":{"message":"Call doctor","delay":"2 hours"}}]}', reward: 1 },
    { id: "ap-5", input: { user: "User wants to save a note about a new project idea: a mobile app for tracking workouts." }, expectedOutput: '{"toolCalls":[{"name":"NOTES","args":{"content":"Project idea: mobile app for tracking workouts"}}]}', reward: 1 },
    { id: "ap-6", input: { user: "User said goodbye and that they'll talk later." }, expectedOutput: '{"toolCalls":[{"name":"REPLY","args":{"message":"Goodbye! Talk later!"}}]}', reward: 1 },
    { id: "ap-7", input: { user: "User wants to find restaurants near downtown Seattle." }, expectedOutput: '{"toolCalls":[{"name":"SEARCH","args":{"query":"restaurants near downtown Seattle"}}]}', reward: 1 },
    { id: "ap-8", input: { user: "User wants a reminder to submit the quarterly report on Friday at 5pm." }, expectedOutput: '{"toolCalls":[{"name":"REMIND","args":{"message":"Submit quarterly report","time":"Friday 5pm"}}]}', reward: 1 },
  ],

  response: [
    { id: "resp-1", input: { user: "What's the best way to learn programming?" }, expectedOutput: "Start with Python - it has clear syntax and lots of learning resources. Focus on building small projects, practice daily, and use platforms like Codecademy or freeCodeCamp.", reward: 1 },
    { id: "resp-2", input: { user: "Can you explain what machine learning is in simple terms?" }, expectedOutput: "Machine learning is teaching computers to learn from examples rather than explicit rules. Like how a child learns to recognize cats by seeing many cat photos, ML models learn patterns from data to make predictions.", reward: 1 },
    { id: "resp-3", input: { user: "What are some healthy breakfast options?" }, expectedOutput: "Great breakfast options include oatmeal with berries, Greek yogurt with nuts, eggs with vegetables, or whole grain toast with avocado. These provide protein, fiber, and nutrients to start your day.", reward: 1 },
    { id: "resp-4", input: { user: "How do I improve my time management skills?" }, expectedOutput: "Start with time blocking - schedule specific tasks in your calendar. Use the Pomodoro technique (25-min focused work, 5-min break), prioritize tasks by urgency and importance, and eliminate distractions during focus time.", reward: 1 },
    { id: "resp-5", input: { user: "What should I do if I can't sleep at night?" }, expectedOutput: "Try keeping a consistent sleep schedule, avoid screens an hour before bed, keep your room cool and dark, and consider relaxation techniques like deep breathing or meditation. Avoid caffeine after 2pm.", reward: 1 },
    { id: "resp-6", input: { user: "Can you recommend some good books for personal development?" }, expectedOutput: "Great personal development books include 'Atomic Habits' by James Clear, 'Mindset' by Carol Dweck, 'Deep Work' by Cal Newport, and 'The Power of Now' by Eckhart Tolle.", reward: 1 },
    { id: "resp-7", input: { user: "How do I stay motivated when working on long projects?" }, expectedOutput: "Break the project into small milestones and celebrate each completion. Set daily goals, track your progress visually, find an accountability partner, and remind yourself of the project's purpose and impact.", reward: 1 },
    { id: "resp-8", input: { user: "What's the difference between a CPU and a GPU?" }, expectedOutput: "A CPU (Central Processing Unit) handles general tasks with a few powerful cores, great for sequential operations. A GPU (Graphics Processing Unit) has thousands of smaller cores for parallel tasks, ideal for graphics and AI computations.", reward: 1 },
  ],

  media_description: [
    { id: "md-1", input: { user: "[Image: A golden retriever puppy playing in autumn leaves in a park]" }, expectedOutput: "A golden retriever puppy playing energetically in a pile of colorful autumn leaves in a park setting. The puppy appears joyful with leaves scattered around it. Fall foliage visible in the background.", reward: 1 },
    { id: "md-2", input: { user: "[Image: A downtown city skyline at sunset with buildings reflected in water]" }, expectedOutput: "A city skyline photographed at sunset showing tall buildings and skyscrapers. The golden and orange sky reflects in the water below, creating a mirror image of the urban landscape. Multiple high-rise buildings visible.", reward: 1 },
    { id: "md-3", input: { user: "[Image: A kitchen with modern appliances, marble countertops, and pendant lighting]" }, expectedOutput: "A modern kitchen featuring marble or marble-like countertops, stainless steel or high-end appliances, and pendant lights hanging from the ceiling. Clean, contemporary design with organized layout.", reward: 1 },
    { id: "md-4", input: { user: "[Image: A woman in athletic gear running on a trail through a forest]" }, expectedOutput: "A woman wearing athletic/running gear running on a trail through a forested area. She appears to be mid-stride. Trees line the trail on both sides, suggesting a natural outdoor environment.", reward: 1 },
    { id: "md-5", input: { user: "[Audio: Rain sounds with occasional thunder in the background]" }, expectedOutput: "Audio recording featuring steady rainfall sounds with intermittent thunder in the background. The rain creates a consistent white noise backdrop while occasional thunder provides deeper, rumbling sounds at irregular intervals.", reward: 1 },
    { id: "md-6", input: { user: "[Image: A charcuterie board with cheeses, meats, fruits, and crackers]" }, expectedOutput: "A charcuterie/cheese board arranged with various cheeses, cured meats, fresh and dried fruits, crackers, and possibly nuts or olives. Items are artfully arranged on a wooden board for sharing.", reward: 1 },
  ],
};

// ── Main eval loop ────────────────────────────────────────────────────────────

interface TaskResult {
  task: string;
  baselineScore: number;
  optimizedScore: number;
  improvement: number;
  improvementPct: number;
  optimizedPromptLength: number;
  baselinePromptLength: number;
  tokenStats: {
    avgTemplateTokens: number;
    avgTotalInputTokens: number;
  };
}

async function evalTask(task: string): Promise<TaskResult> {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`Task: ${task}`);
  console.log("═".repeat(60));

  const baselinePrompt = BASELINE_PROMPTS[task]!;
  const dataset = SYNTHETIC_DATASETS[task]!;
  const adapter = buildAdapter();
  const scorer = buildScorer(task, adapter);

  // Count template tokens across dataset
  let totalTemplateTokens = 0;
  let totalInputTokens = 0;
  for (const ex of dataset) {
    const report = countPromptTokens(baselinePrompt, ex.input.user);
    totalTemplateTokens += report.templateTokens;
    totalInputTokens += report.totalInputTokens;
  }
  const avgTemplateTokens = Math.round(totalTemplateTokens / dataset.length);
  const avgTotalInputTokens = Math.round(totalInputTokens / dataset.length);
  console.log(`  Baseline prompt: ${baselinePrompt.length} chars, ~${countTokensApprox(baselinePrompt)} tokens`);
  console.log(`  Dataset: ${dataset.length} examples`);
  console.log(`  Avg template tokens: ${avgTemplateTokens}, avg total input tokens: ${avgTotalInputTokens}`);

  let result: OptimizerResult;

  if (OPTIMIZER === "bootstrap-fewshot") {
    result = await runBootstrapInstrumented(task, baselinePrompt, dataset, scorer);
  } else {
    // GEPA (default)
    result = await runGepaInstrumented(
      task,
      baselinePrompt,
      dataset,
      scorer,
      GEPA_GENERATIONS,
      GEPA_POPULATION,
    );
  }

  const improvement = result.score - result.baseline;
  const improvementPct = result.baseline === 0 ? 0 : (improvement / result.baseline) * 100;

  console.log(`\n  ── Results ──`);
  console.log(`  Baseline score:   ${result.baseline.toFixed(4)}`);
  console.log(`  Optimized score:  ${result.score.toFixed(4)}`);
  console.log(`  Improvement:      ${improvement >= 0 ? "+" : ""}${improvement.toFixed(4)} (${improvementPct >= 0 ? "+" : ""}${improvementPct.toFixed(1)}%)`);
  console.log(`  Lineage steps:    ${result.lineage.length}`);

  // Save optimized prompt to export dir
  mkdirSync(EXPORT_DIR, { recursive: true });
  const promptPath = join(EXPORT_DIR, `${task}-optimized.txt`);
  writeFileSync(promptPath, result.optimizedPrompt, "utf-8");
  const baselinePath = join(EXPORT_DIR, `${task}-baseline.txt`);
  writeFileSync(baselinePath, baselinePrompt, "utf-8");

  // Log final trajectory
  logTrajectory({
    timestamp: new Date().toISOString(),
    task,
    optimizer: OPTIMIZER,
    step: "final-result",
    score: result.score,
    notes: `baseline=${result.baseline.toFixed(4)} optimized=${result.score.toFixed(4)} delta=${improvement.toFixed(4)} pct=${improvementPct.toFixed(1)}%`,
  });

  return {
    task,
    baselineScore: result.baseline,
    optimizedScore: result.score,
    improvement,
    improvementPct,
    optimizedPromptLength: result.optimizedPrompt.length,
    baselinePromptLength: baselinePrompt.length,
    tokenStats: { avgTemplateTokens, avgTotalInputTokens },
  };
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║       Eliza Prompt Optimization Eval — GEPA + DSPy      ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`\nOptimizer:   ${OPTIMIZER}`);
  console.log(`Model:       ${CEREBRAS_MODEL}`);
  if (OPTIMIZER === "gepa") {
    console.log(`Generations: ${GEPA_GENERATIONS}`);
    console.log(`Population:  ${GEPA_POPULATION}`);
  }
  console.log(`Export dir:  ${EXPORT_DIR}`);
  console.log(`\nRunning eval on tasks: ${Object.keys(BASELINE_PROMPTS).join(", ")}`);

  const results: TaskResult[] = [];
  const tasks = Object.keys(BASELINE_PROMPTS);

  for (const task of tasks) {
    try {
      const result = await evalTask(task);
      results.push(result);
    } catch (err) {
      console.error(`\nTask ${task} failed:`, err);
      logTrajectory({
        timestamp: new Date().toISOString(),
        task,
        optimizer: OPTIMIZER,
        step: "error",
        notes: String(err),
      });
    }
  }

  // ── Summary table ──────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(70)}`);
  console.log("SUMMARY");
  console.log("═".repeat(70));
  console.log(`${"Task".padEnd(20)} ${"Baseline".padStart(9)} ${"Optimized".padStart(10)} ${"Delta".padStart(8)} ${"AvgTmplTok".padStart(11)} ${"AvgTotalTok".padStart(12)}`);
  console.log("─".repeat(70));

  let totalImprovement = 0;
  let improvedCount = 0;

  for (const r of results) {
    const delta = r.improvement >= 0 ? `+${r.improvement.toFixed(4)}` : r.improvement.toFixed(4);
    const pct = r.improvementPct >= 0 ? `+${r.improvementPct.toFixed(1)}%` : `${r.improvementPct.toFixed(1)}%`;
    console.log(
      `${r.task.padEnd(20)} ${r.baselineScore.toFixed(4).padStart(9)} ${r.optimizedScore.toFixed(4).padStart(10)} ${(delta + " " + pct).padStart(16)} ${r.tokenStats.avgTemplateTokens.toString().padStart(11)} ${r.tokenStats.avgTotalInputTokens.toString().padStart(12)}`,
    );
    if (r.improvement > 0) improvedCount++;
    totalImprovement += r.improvement;
  }

  console.log("─".repeat(70));
  const avgImprovement = results.length > 0 ? totalImprovement / results.length : 0;
  console.log(`Tasks improved: ${improvedCount}/${results.length}`);
  console.log(`Avg score delta: ${avgImprovement >= 0 ? "+" : ""}${avgImprovement.toFixed(4)}`);
  console.log(`\nTotal API calls: ${totalApiCalls}`);
  console.log(`Total prompt tokens consumed: ${totalPromptTokens.toLocaleString()}`);
  console.log(`Total completion tokens consumed: ${totalCompletionTokens.toLocaleString()}`);
  console.log(`Total tokens: ${(totalPromptTokens + totalCompletionTokens).toLocaleString()}`);

  // Export all trajectories
  mkdirSync(EXPORT_DIR, { recursive: true });
  const { jsonlPath, readablePath } = exportTrajectories(EXPORT_DIR);

  // Write summary JSON
  const summaryPath = join(EXPORT_DIR, "eval-summary.json");
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        optimizer: OPTIMIZER,
        model: CEREBRAS_MODEL,
        gepaGenerations: GEPA_GENERATIONS,
        gepaPopulation: GEPA_POPULATION,
        results,
        totals: {
          improvedCount,
          totalTasks: results.length,
          avgImprovement,
          totalApiCalls,
          totalPromptTokens,
          totalCompletionTokens,
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  console.log(`\nExported files:`);
  console.log(`  Summary:  ${summaryPath}`);
  console.log(`  JSONL:    ${jsonlPath}`);
  console.log(`  Readable: ${readablePath}`);
  console.log(`  Prompts:  ${EXPORT_DIR}/<task>-{baseline,optimized}.txt`);

  if (improvedCount === 0 && results.length > 0) {
    console.log(`\n⚠️  No tasks improved. Check trajectory log for details.`);
    process.exit(1);
  }

  console.log(`\n✓ Eval complete. ${improvedCount}/${results.length} tasks improved.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
