// One-shot Smithers turn harness.
//
// Reads a JSON payload on stdin and emits a single JSON line on stdout in the
// shape the Python SmithersClient expects:
//   {"text", "thought", "actions", "params": {"tool_calls", "usage"}}
//
// The turn runs through Smithers' own OpenAIAgent (a ToolLoopAgent built on the
// Vercel `ai` SDK) so the harness exercises real Smithers machinery rather than
// a bare chat.completions call. Tools are declared WITHOUT an `execute` handler,
// so the agent returns the emitted tool calls for the caller to score instead
// of looping and executing them — exactly what single-turn benchmarks (BFCL,
// action-calling, ...) need.
//
// Smithers' OpenAIAgent accepts the OpenAI-compatible `baseURL`/`apiKey` pair
// directly with a string model and resolves the SDK provider internally. That
// keeps this adapter aligned with the Smithers package's own AI SDK version.

import { jsonSchema } from "ai";
import { OpenAIAgent } from "smithers-orchestrator";
import {
  loadOptimizationArtifact,
  resolveOptimizedSystemPrompt,
} from "./optimization.mjs";

const DEFAULT_BASE_URLS = {
  cerebras: "https://api.cerebras.ai/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
};

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      buf += c;
    });
    process.stdin.on("end", () => resolve(buf));
  });
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.stdout.write("\n");
}

function isGptOss(model) {
  const bare = String(model || "")
    .split("/")
    .pop();
  return bare.startsWith("gpt-oss");
}

// Convert an OpenAI-format tools array into an `ai` SDK ToolSet. Tools are
// intentionally execute-less: the agent halts after emitting calls.
function toToolSet(rawTools) {
  if (!Array.isArray(rawTools) || rawTools.length === 0) return undefined;
  const set = {};
  for (const item of rawTools) {
    if (!item || item.type !== "function" || !item.function) continue;
    const fn = item.function;
    if (typeof fn.name !== "string" || !fn.name) continue;
    set[fn.name] = {
      description:
        typeof fn.description === "string" ? fn.description : undefined,
      inputSchema: jsonSchema(
        fn.parameters && typeof fn.parameters === "object"
          ? fn.parameters
          : { type: "object", properties: {} },
      ),
      // no execute => the tool loop stops and returns the emitted call
    };
  }
  return Object.keys(set).length ? set : undefined;
}

function asText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return { _raw: raw };
    }
  }
  return {};
}

// Convert OpenAI-shape assistant tool_calls into ai-SDK ToolCallPart[].
function toToolCallParts(toolCalls) {
  const parts = [];
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") continue;
    const fn =
      tc.function && typeof tc.function === "object" ? tc.function : tc;
    const name = fn.name ?? tc.name;
    if (typeof name !== "string" || !name) continue;
    parts.push({
      type: "tool-call",
      toolCallId: String(tc.id ?? tc.tool_call_id ?? `call_${parts.length}`),
      toolName: name,
      input: parseArgs(fn.arguments ?? fn.input ?? tc.arguments),
    });
  }
  return parts;
}

// Convert an arbitrary benchmark message list into valid ai-SDK ModelMessage[],
// preserving NATIVE structured tool calls / tool results (rather than
// flattening to text) so multi-turn function-calling benchmarks keep fidelity.
// Falls back to text only for shapes that can't be represented structurally.
function buildMessages(payload) {
  const ctx =
    payload.context && typeof payload.context === "object"
      ? payload.context
      : {};
  const messages = [];
  const sysPrompt =
    typeof payload.system_prompt === "string" && payload.system_prompt.trim()
      ? payload.system_prompt
      : typeof ctx.system_prompt === "string"
        ? ctx.system_prompt
        : null;
  const raw = Array.isArray(ctx.messages) ? ctx.messages : null;
  // Track tool names by call id so tool-result parts can carry the toolName.
  const toolNameById = {};
  let hadRaw = false;
  if (raw) {
    for (const m of raw) {
      if (!m || typeof m !== "object") continue;
      const role = m.role;
      const content = asText(m.content);
      if (role === "system") {
        if (!content.trim()) continue;
        messages.push({ role: "system", content });
      } else if (role === "user") {
        messages.push({ role: "user", content: content || "(empty)" });
      } else if (role === "assistant") {
        const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
        if (toolCalls.length) {
          const parts = toToolCallParts(toolCalls);
          for (const p of parts) toolNameById[p.toolCallId] = p.toolName;
          const arr = [];
          if (content.trim()) arr.push({ type: "text", text: content });
          arr.push(...parts);
          messages.push({ role: "assistant", content: arr });
        } else {
          messages.push({
            role: "assistant",
            content: content || "(no content)",
          });
        }
      } else if (role === "tool") {
        const callId = String(
          m.tool_call_id ?? m.id ?? `call_${messages.length}`,
        );
        const name =
          (typeof m.name === "string" && m.name) ||
          toolNameById[callId] ||
          "tool";
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: callId,
              toolName: name,
              output: { type: "json", value: parseArgs(m.content) },
            },
          ],
        });
      } else {
        continue;
      }
      hadRaw = true;
    }
  }
  if (
    sysPrompt &&
    !messages.some((m) => m.role === "system" && m.content === sysPrompt)
  ) {
    messages.unshift({ role: "system", content: sysPrompt });
  }
  const text = String(payload.text ?? "");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!hadRaw) {
    messages.push({ role: "user", content: text || "(empty)" });
  } else if (text && (!lastUser || lastUser.content !== text)) {
    messages.push({ role: "user", content: text });
  }
  return messages;
}

async function main() {
  const rawIn = await readStdin();
  if (!rawIn) {
    emit({
      text: "",
      thought: null,
      actions: [],
      params: { error: "no stdin" },
    });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(rawIn);
  } catch (e) {
    emit({
      text: "",
      thought: null,
      actions: [],
      params: { error: `bad stdin json: ${e}` },
    });
    return;
  }

  const provider = String(payload.provider || "cerebras").toLowerCase();
  const modelName = String(payload.model || "gemma-4-31b");
  const baseURL =
    (typeof payload.base_url === "string" && payload.base_url) ||
    DEFAULT_BASE_URLS[provider] ||
    DEFAULT_BASE_URLS.cerebras;
  const apiKey =
    typeof payload.api_key === "string"
      ? payload.api_key
      : process.env.CEREBRAS_API_KEY || "";

  const ctx =
    payload.context && typeof payload.context === "object"
      ? payload.context
      : {};

  // GEPA: when an optimization artifact is configured (SMITHERS_OPTIMIZATION_ARTIFACT,
  // produced by `smithers optimize`), override the benchmark's default system
  // prompt with the optimized one before building messages. A missing/invalid
  // artifact resolves to null and leaves the default prompt untouched.
  const optimizationArtifact = loadOptimizationArtifact(
    process.env.SMITHERS_OPTIMIZATION_ARTIFACT,
  );
  if (optimizationArtifact) {
    const optimizedPrompt = resolveOptimizedSystemPrompt(
      optimizationArtifact,
      payload.benchmark ?? ctx.benchmark,
    );
    if (optimizedPrompt) payload.system_prompt = optimizedPrompt;
  }

  const tools = toToolSet(payload.tools ?? ctx.tools);
  const messages = buildMessages(payload);

  const toolChoiceRaw = payload.tool_choice ?? ctx.tool_choice;
  const toolChoice =
    tools && ["auto", "required", "none"].includes(toolChoiceRaw)
      ? toolChoiceRaw
      : undefined;

  const temperature =
    typeof payload.temperature === "number"
      ? payload.temperature
      : typeof ctx.temperature === "number"
        ? ctx.temperature
        : undefined;
  const maxTokens =
    typeof payload.max_tokens === "number" && payload.max_tokens > 0
      ? payload.max_tokens
      : undefined;

  let reasoningEffort = payload.reasoning_effort ?? ctx.reasoning_effort;
  if (!reasoningEffort && isGptOss(modelName)) reasoningEffort = "low";

  const agentOpts = {
    model: modelName,
    baseURL,
    apiKey,
    // ToolLoopAgent passthrough:
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
  };
  if (reasoningEffort) {
    agentOpts.providerOptions = {
      openai: { reasoningEffort: String(reasoningEffort) },
    };
  }

  const agent = new OpenAIAgent(agentOpts);

  // Rate-limit resilience: Cerebras enforces a per-minute token quota and
  // returns 429 ("Too Many Requests") under burst (multi-call benchmarks like
  // tau-bench fire agent+user+judge rapidly). The ai SDK's default 3 retries
  // are not enough, so we add an outer retry loop honoring Retry-After with a
  // 60s cap — mirroring the hermes/openclaw adapters' backoff.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function is429(e) {
    const sc = e?.statusCode ?? e?.status ?? e?.cause?.statusCode;
    const msg = String(e?.message || e || "").toLowerCase();
    return (
      sc === 429 ||
      msg.includes("too many requests") ||
      msg.includes("rate limit") ||
      msg.includes("quota")
    );
  }
  function retryAfterMs(e) {
    const h = e?.responseHeaders || e?.cause?.responseHeaders || {};
    const ra = h["retry-after"] || h["Retry-After"];
    const n = ra ? Number(ra) : NaN;
    if (Number.isFinite(n) && n > 0) return Math.min(n * 1000, 60000);
    return null;
  }
  const MAX_ATTEMPTS = 7;
  const BACKOFF = [2000, 5000, 10000, 20000, 40000, 60000];
  let res;
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      res = await agent.generate({ messages });
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
      if (!is429(e) || attempt === MAX_ATTEMPTS - 1) break;
      const delay =
        retryAfterMs(e) ?? BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
      process.stderr.write(
        `smithers-turn 429; retry ${attempt + 1}/${MAX_ATTEMPTS} after ${delay}ms\n`,
      );
      await sleep(delay);
    }
  }
  if (lastErr !== undefined || res === undefined) {
    emit({
      text: "",
      thought: null,
      actions: [],
      params: {
        error: `${lastErr?.name || "Error"}: ${lastErr?.message || lastErr}`,
      },
    });
    return;
  }

  const toolCalls = [];
  const collected = res.toolCalls ?? res.staticToolCalls ?? [];
  for (const tc of collected) {
    const name = tc.toolName ?? tc.name ?? "";
    if (!name) continue;
    const args = tc.input ?? tc.args ?? tc.arguments ?? {};
    toolCalls.push({
      id: tc.toolCallId ?? tc.id ?? `call_${toolCalls.length}`,
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    });
  }

  const u = res.usage ?? {};
  const usage = {
    prompt_tokens: u.inputTokens ?? u.promptTokens ?? null,
    completion_tokens: u.outputTokens ?? u.completionTokens ?? null,
    total_tokens: u.totalTokens ?? null,
    cached_tokens:
      u.cachedInputTokens ?? u.inputTokenDetails?.cacheReadTokens ?? 0,
    reasoning_tokens:
      u.reasoningTokens ?? u.outputTokenDetails?.reasoningTokens ?? null,
  };

  const reasoning =
    typeof res.reasoningText === "string" && res.reasoningText.trim()
      ? res.reasoningText
      : null;
  let text = typeof res.text === "string" ? res.text : "";
  if (!text.trim() && reasoning) text = reasoning;

  emit({
    text,
    thought: reasoning,
    actions: toolCalls.map((t) => t.name),
    params: {
      tool_calls: toolCalls,
      usage,
      finish_reason: res.finishReason ?? null,
    },
  });
}

main().catch((e) => {
  emit({
    text: "",
    thought: null,
    actions: [],
    params: { error: `fatal: ${e?.message || e}` },
  });
});
