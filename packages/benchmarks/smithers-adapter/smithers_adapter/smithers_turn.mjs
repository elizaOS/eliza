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

function asText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

// Flatten an arbitrary benchmark message list into strictly-valid ai SDK
// ModelMessage[] (roles system/user/assistant with non-empty string content).
// `tool` results and assistant tool-call turns are rendered as text so the
// model still sees the conversation history without tripping the SDK's schema
// validation (which requires structured tool/tool-result parts + ids).
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
      let content = asText(m.content);
      if (role === "system") {
        if (!content.trim()) continue;
        messages.push({ role: "system", content });
      } else if (role === "user") {
        messages.push({ role: "user", content: content || "(empty)" });
      } else if (role === "assistant") {
        if (!content.trim() && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          content = "Tool calls: " + JSON.stringify(m.tool_calls);
        }
        messages.push({ role: "assistant", content: content || "(no content)" });
      } else if (role === "tool") {
        const name = typeof m.name === "string" ? m.name : "";
        messages.push({ role: "user", content: `Tool result${name ? ` (${name})` : ""}: ${content}` });
      } else {
        continue;
      }
      hadRaw = true;
    }
  }
  if (sysPrompt && !messages.some((m) => m.role === "system" && m.content === sysPrompt)) {
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
