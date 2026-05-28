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
// Provider model is forced onto the chat-completions endpoint via
// `provider.chat(model)` because OpenAI-compatible backends such as Cerebras do
// not implement the newer `/responses` endpoint that `@ai-sdk/openai` defaults
// to for bare model ids.

import { OpenAIAgent } from "smithers-orchestrator";
import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema } from "ai";

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
  const bare = String(model || "").split("/").pop();
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
      description: typeof fn.description === "string" ? fn.description : undefined,
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

function buildMessages(payload) {
  const ctx = payload.context && typeof payload.context === "object" ? payload.context : {};
  const messages = [];
  const sysPrompt =
    typeof payload.system_prompt === "string" && payload.system_prompt.trim()
      ? payload.system_prompt
      : typeof ctx.system_prompt === "string"
        ? ctx.system_prompt
        : null;
  const raw = Array.isArray(ctx.messages) ? ctx.messages : null;
  let hadRaw = false;
  if (raw) {
    for (const m of raw) {
      if (!m || typeof m !== "object") continue;
      const role = m.role;
      if (!["system", "user", "assistant", "tool"].includes(role)) continue;
      const content = m.content == null ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      messages.push({ role, content });
      hadRaw = true;
    }
  }
  if (sysPrompt && !messages.some((m) => m.role === "system" && m.content === sysPrompt)) {
    messages.unshift({ role: "system", content: sysPrompt });
  }
  if (!hadRaw) {
    messages.push({ role: "user", content: String(payload.text ?? "") });
  } else if (payload.text) {
    messages.push({ role: "user", content: String(payload.text) });
  }
  return messages;
}

async function main() {
  const rawIn = await readStdin();
  if (!rawIn) {
    emit({ text: "", thought: null, actions: [], params: { error: "no stdin" } });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(rawIn);
  } catch (e) {
    emit({ text: "", thought: null, actions: [], params: { error: `bad stdin json: ${e}` } });
    return;
  }

  const provider = String(payload.provider || "cerebras").toLowerCase();
  const modelName = String(payload.model || "gpt-oss-120b");
  const baseURL =
    (typeof payload.base_url === "string" && payload.base_url) ||
    DEFAULT_BASE_URLS[provider] ||
    DEFAULT_BASE_URLS.cerebras;
  const apiKey = typeof payload.api_key === "string" ? payload.api_key : process.env.CEREBRAS_API_KEY || "";

  const ctx = payload.context && typeof payload.context === "object" ? payload.context : {};
  const tools = toToolSet(payload.tools ?? ctx.tools);
  const messages = buildMessages(payload);

  const toolChoiceRaw = payload.tool_choice ?? ctx.tool_choice;
  const toolChoice =
    tools && ["auto", "required", "none"].includes(toolChoiceRaw) ? toolChoiceRaw : undefined;

  const temperature =
    typeof payload.temperature === "number"
      ? payload.temperature
      : typeof ctx.temperature === "number"
        ? ctx.temperature
        : undefined;
  const maxTokens = typeof payload.max_tokens === "number" && payload.max_tokens > 0 ? payload.max_tokens : undefined;

  let reasoningEffort = payload.reasoning_effort ?? ctx.reasoning_effort;
  if (!reasoningEffort && isGptOss(modelName)) reasoningEffort = "low";

  const sdkProvider = createOpenAI({ baseURL, apiKey });

  const agentOpts = {
    model: sdkProvider.chat(modelName),
    // ToolLoopAgent passthrough:
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
  };
  if (reasoningEffort) {
    agentOpts.providerOptions = { openai: { reasoningEffort: String(reasoningEffort) } };
  }

  const agent = new OpenAIAgent(agentOpts);

  let res;
  try {
    res = await agent.generate({ messages });
  } catch (e) {
    emit({
      text: "",
      thought: null,
      actions: [],
      params: { error: `${e?.name || "Error"}: ${e?.message || e}` },
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
    cached_tokens: u.cachedInputTokens ?? u.inputTokenDetails?.cacheReadTokens ?? 0,
    reasoning_tokens: u.reasoningTokens ?? u.outputTokenDetails?.reasoningTokens ?? null,
  };

  const reasoning = typeof res.reasoningText === "string" && res.reasoningText.trim() ? res.reasoningText : null;
  let text = typeof res.text === "string" ? res.text : "";
  if (!text.trim() && reasoning) text = reasoning;

  emit({
    text,
    thought: reasoning,
    actions: toolCalls.map((t) => t.name),
    params: { tool_calls: toolCalls, usage, finish_reason: res.finishReason ?? null },
  });
}

main().catch((e) => {
  emit({ text: "", thought: null, actions: [], params: { error: `fatal: ${e?.message || e}` } });
});
