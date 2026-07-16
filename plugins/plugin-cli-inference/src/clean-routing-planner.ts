import type { ChatMessage, GenerateTextParams, JSONSchema, ToolDefinition } from "@elizaos/core";
import { contentToText } from "./prompt-flatten";

/**
 * Clean-routing ACTION_PLANNER for the SAFE/CLI inference route.
 *
 * WHY THIS EXISTS
 * ---------------
 * The native-tool planner prompt (`packages/core/src/prompts/planner.ts` +
 * the rendered `planner_stage:` block + the `<response>` grammar) is written
 * for a provider that honors GBNF / native-tool / responseSchema enforcement.
 * Fed verbatim to `claude --print`, that grammar-heavy prompt reliably
 * confuses the model into ANSWERING the user's task inline (as Claude Code
 * would) instead of EMITTING a routing decision — the model reads "task: Plan
 * next native tool calls" plus a wall of decode-rules and treats it as a
 * coding instruction.
 *
 * Proven live: `claude --print --model claude-opus-4-8` given a CLEAN routing
 * prompt ("pick ONE action, output ONLY compact JSON {action,params}") routes
 * every turn type correctly, with grounded params, in eliza's voice. So claude
 * CAN plan — it just needs the routing task stated plainly and the action
 * universe handed to it as a short menu rather than as native tool schemas it
 * is told to "call".
 *
 * WHAT THIS DOES
 * --------------
 * Rebuilds the planner call into the proven clean form BEFORE it reaches the
 * CLI:
 *   1. Extracts the action universe from `params.tools` (the per-action
 *      `ToolDefinition[]` the planner loop always forwards — each tool's `name`
 *      is the action name, `parameters` is its arg schema).
 *   2. Extracts the conversation transcript from `params.messages`, dropping
 *      the injected `planner_stage:` grammar block and any prior `<response>`
 *      scaffold so only real user/assistant/tool turns remain.
 *   3. Synthesizes a CLEAN routing system prompt + body (the proven template)
 *      and returns them as a fresh `GenerateTextParams` for `generateViaCli`.
 *
 * The handler returns the model's compact JSON verbatim. The planner loop's
 * text-mode parser (`parseJsonPlannerOutput` → `normalizeBarePlannerAction`)
 * accepts the bare `{"action": NAME, "params": {...}}` shape directly: it reads
 * the action name from `action`/`name` and the args from `params`/`parameters`,
 * and resolves REPLY / IGNORE / STOP as the universal terminal sentinels. No
 * change to core is required.
 */

/** Marker the planner loop injects ahead of the grammar-heavy instructions. */
const PLANNER_STAGE_MARKER = "planner_stage:";

/** Roles whose content is steering/grammar, not conversation. */
const STEERING_ROLES = new Set<string>(["system", "developer"]);

/** Render a tool's parameter schema as a terse `name: type` hint list. */
function renderParamHints(schema: JSONSchema | undefined): string {
  if (!schema || typeof schema !== "object") return "(no params)";
  const properties = (schema as { properties?: Record<string, JSONSchema> }).properties;
  if (!properties || Object.keys(properties).length === 0) return "(no params)";
  const requiredList = ((schema as { required?: unknown }).required as string[] | undefined) ?? [];
  const required = new Set(requiredList);
  const parts: string[] = [];
  for (const [key, prop] of Object.entries(properties)) {
    const type =
      (prop as { type?: unknown }).type !== undefined
        ? String((prop as { type?: unknown }).type)
        : "any";
    const enumValues = (prop as { enum?: unknown }).enum;
    const enumHint =
      Array.isArray(enumValues) && enumValues.length > 0
        ? ` one of [${enumValues.map((v) => JSON.stringify(v)).join(", ")}]`
        : "";
    const flag = required.has(key) ? "" : "?";
    parts.push(`${key}${flag}: ${type}${enumHint}`);
  }
  return parts.join(", ");
}

/** Render the action universe as a compact, plain-language menu. */
function renderActionMenu(tools: ReadonlyArray<ToolDefinition>): string {
  const lines: string[] = [];
  for (const tool of tools) {
    if (!tool.name) continue;
    const description = (tool.description ?? "").trim().replace(/\s+/g, " ");
    const params = renderParamHints(tool.parameters);
    lines.push(`- ${tool.name} — ${description} [params: ${params}]`);
  }
  return lines.join("\n");
}

/**
 * Pull the real conversation transcript out of the planner's message array,
 * dropping the injected `planner_stage:` grammar block and the steering system
 * messages. Keeps user / assistant / tool turns in order.
 */
function renderTranscript(messages: ReadonlyArray<ChatMessage> | undefined): string {
  if (!messages || messages.length === 0) return "";
  const lines: string[] = [];
  for (const message of messages) {
    if (STEERING_ROLES.has(message.role)) continue;
    let text = contentToText(message.content);
    if (!text) continue;
    // Strip the planner-stage grammar block when it rode in on a user message
    // (the loop folds instructions into the stage user message in some paths).
    const markerIndex = text.indexOf(PLANNER_STAGE_MARKER);
    if (markerIndex !== -1) {
      text = text.slice(0, markerIndex).trim();
      if (!text) continue;
    }
    const label =
      message.role === "assistant" ? "Assistant" : message.role === "tool" ? "Tool result" : "User";
    lines.push(`${label}: ${text}`);
  }
  return lines.join("\n\n");
}

/**
 * The clean routing system prompt — the proven template.
 *
 * `mustCallTool` mirrors the planner loop's `toolChoice: "required"` gate
 * (`planner-loop.ts:211`, set when Stage 1 flagged the turn tool-required and a
 * non-terminal action is exposed). The native-tool path enforces this with
 * `tool_choice: required` against the provider; the clean-routing rewrite has no
 * such grammar, so the requirement MUST be stated in the prompt — otherwise the
 * model reads the default "answer directly if you can" rule and emits a terminal
 * REPLY/IGNORE for live-info turns ("btc price?"), which the loop rejects up to
 * `maxRequiredToolMisses` times and then surfaces a "hit a snag" apology. We
 * steer by the GROUND TRUTH that separates the two cases — live/external data
 * the agent cannot know from memory (needs a tool) vs static knowledge it can
 * (REPLY is fine) — rather than a blind ban, so genuinely-tool-less turns still
 * answer instead of force-calling an irrelevant action.
 */
export function buildCleanRoutingSystemPrompt(
  actionMenu: string,
  characterSystem: string | undefined,
  mustCallTool = false
): string {
  const voice = characterSystem?.trim()
    ? `Your persona / voice (use it for any user-facing text):\n${characterSystem.trim()}\n\n`
    : "";
  const replyRule = mustCallTool
    ? `- This turn was flagged as needing a tool. If the user's request depends on CURRENT, LIVE, or EXTERNAL information you cannot know with certainty from memory — current prices, weather, news, sports/markets, the contents of a URL or file, or running a task — you MUST choose the matching non-terminal action (e.g. WEB_FETCH with a concrete url, WEB_SEARCH with a query) and ground its params. Do NOT answer such requests from memory, and do NOT choose REPLY/IGNORE/STOP for them. Choose REPLY only if the request is static knowledge you can answer correctly with no tool at all (arithmetic, definitions, or facts about the conversation itself).`
    : `- If you can answer the user directly from what you already know (no tool needed), choose REPLY and put the COMPLETE answer in params.text.`;
  return `${voice}You are the action router for an AI agent. Your ONLY job this turn is to pick exactly ONE action for the agent to take next, given the conversation and the menu of available actions below.

Available actions:
${actionMenu}

Terminal actions (always available):
- REPLY — answer the user directly and end the turn. params: { text: string } (the full user-facing answer, in your voice).
- IGNORE — say nothing and end the turn. params: {} (use when no reply is appropriate).
- STOP — hard stop the turn. params: {} (use only on an explicit user stop).

Rules:
- Pick exactly ONE action by its exact name from the lists above.
- If a listed non-terminal action fulfills the user's request, choose it and fill its params, grounded in the conversation. Do not answer the task yourself — the action's handler does the work.
${replyRule}
- Never invent an action name that is not in the lists. Never invent required params you don't have grounds for.
- params must be a JSON object obeying that action's param hints (arrays as JSON arrays, not comma strings).

Output format (CRITICAL):
- Output ONLY a single compact JSON object, nothing else — no prose, no markdown, no code fences, no explanation.
- Shape: {"action": "<ACTION_NAME>", "params": { ... }}
- Example: {"action":"WEB_FETCH","params":{"url":"https://api.example.com/x"}}
- Example: {"action":"REPLY","params":{"text":"2 + 2 is 4."}}`;
}

/** The clean routing body — the live conversation, plainly stated. */
export function buildCleanRoutingBody(transcript: string): string {
  const convo = transcript || "(no prior conversation)";
  return `Conversation so far:
${convo}

Now output ONLY the compact JSON routing object for the single next action.`;
}

/**
 * Framing prefix for the warm Agent SDK in TEXT mode (reply / large tiers).
 *
 * The SDK drives Claude Code, which is agentic by nature: fed eliza's flattened
 * RESPONSE_HANDLER prompt — a message history with tool-calls + a stale "call a
 * tool" instruction — opus CONTINUES it like an agent ("The user wants X. I'll
 * fetch it...") instead of synthesizing the final reply from the tool RESULTS
 * already present. The direct-API path doesn't do this because it isn't running
 * the Claude Code agent loop. This prefix neutralizes that: it reframes the model
 * as a pure completion engine that must emit ONLY the finished text and treat any
 * tool results in the conversation as already-executed facts. General across all
 * text tiers (reply, evaluator, summaries) — none of them want agentic preamble.
 */
export const TEXT_COMPLETION_FRAMING = `You are a text-generation engine, not an interactive agent. Output ONLY the final text the instructions below ask for — the finished content itself, in the requested voice and format, with no preamble and no sign-off about what you are doing. The conversation may include tool calls and their results that have ALREADY been executed; treat every such result as a given fact and use it directly. Never describe what you are about to do, never say you will fetch / check / look up / search for anything, never plan or call tools — that work is already done. Just write the final answer.`;

/** Prepend the text-completion framing to a (possibly empty) system prompt. */
export function frameTextSystemPrompt(system: string | undefined): string {
  const base = system?.trim();
  return base ? `${TEXT_COMPLETION_FRAMING}\n\n${base}` : TEXT_COMPLETION_FRAMING;
}

/**
 * Closing directive appended to the END of a TEXT-mode body. The system framing
 * alone is not reliably enough against eliza's large flattened prompt, whose LAST
 * line is often a stale planner instruction ("Call at least one exposed
 * non-terminal tool") that the agentic SDK model obeys ("I'll pull the data…").
 * The model weights the final instruction most, so a closing directive that
 * cancels any pending tool instruction and demands the finished answer is what
 * reliably stops the narration leak (proven: with it, 4/4 correct + 0 narration +
 * 0 empty across the live-shaped probe; without it, 2/4 + intermittent empties).
 *
 * The FORMAT CONTRACT clause leads because this directive serves two call
 * shapes: the post-tool synthesis reply (prose) AND structured calls like the
 * Stage-1 routing envelope (JSON with contexts/candidates/ack fields).
 * Without it, a flat demand for "the finished response" makes a plain-prose
 * decline the only compliant output for a pre-tool live-info ask — observed
 * live as the bot declining "whats xrp at" in prose instead of emitting the
 * envelope that routes it to a fetch.
 */
export const TEXT_COMPLETION_DIRECTIVE = `

---
You are now writing the FINAL output for the instructions above. The FORMAT CONTRACT WINS: when those instructions demand a structured output (a JSON object or envelope with named fields), emit EXACTLY that structure with every required field and nothing else — fill its fields as those instructions direct, including routing/context fields and brief-ack reply fields when they call for one. Otherwise output only the finished prose reply in the agent's voice. In either case: tool calls shown above have ALREADY executed and their results are the authoritative source of truth — read the actual values out of those tool results and use them verbatim; do NOT invent, estimate, or guess a value when a tool result already contains it. Any earlier "do not answer from prior tool output / call a tool" policy applied only to the planning step, which is now complete — there are no tools for YOU to call here. Never narrate what you are doing or about to do ("let me pull a live quote", "I'll check") in place of the requested output.`;

/** Append the text-completion directive to a TEXT-mode body. */
export function appendTextDirective(body: string): string {
  return `${body}${TEXT_COMPLETION_DIRECTIVE}`;
}

/**
 * STABLE system prompt for the NATIVE-TOOL router (warm Agent SDK, ROUTE mode).
 *
 * The model is given exactly ONE tool — `route_action({action, params})` — and
 * must call it once per turn. This is the structural replacement for the
 * free-text `{action,params}` text-planner: a real `tool_use` the SDK delivers
 * to our in-process handler, so there is no JSON-from-prose parsing and no
 * required-tool retry loop. Kept CONSTANT (per-turn variation — the action menu,
 * transcript, persona — rides in the body) because the SDK freezes `systemPrompt`
 * at session start, so a constant system keeps ONE warm process per model.
 */
/**
 * STABLE system prompt for the Stage-1 ENVELOPE session (warm Agent SDK,
 * ENVELOPE mode). The model is given exactly ONE tool — `handle_response` —
 * and must call it once per turn with the routing envelope the per-turn
 * instructions (riding in the body) define. Kept CONSTANT for the same reason
 * as ROUTER_SYSTEM_PROMPT below: the SDK freezes `systemPrompt` at session
 * start, so a constant system keeps ONE warm process serving every Stage-1
 * turn. All the real routing rules (simple vs planning, live-info, field
 * docs) come from the framework's own Stage-1 template in the body — this
 * prompt only pins the OUTPUT CHANNEL to the tool call.
 */
export const STAGE1_ENVELOPE_SYSTEM_PROMPT = `You are the Stage-1 message router for an Eliza AI agent. The user message contains the full routing instructions, the agent persona, and the conversation. Follow those instructions exactly, then submit your decision by calling the handle_response tool EXACTLY ONCE with every field those instructions define — never answer in plain text, never skip the tool call.`;

/**
 * Build the per-turn ENVELOPE-mode body: the flattened Stage-1 prompt (the
 * framework template + persona + conversation + field docs), closed with the
 * tool-call directive. Pairs with {@link STAGE1_ENVELOPE_SYSTEM_PROMPT} (the
 * constant system slot) exactly as buildRouterBody pairs with
 * ROUTER_SYSTEM_PROMPT.
 */
export function buildEnvelopeBody(system: string | undefined, body: string): string {
  const instructions = system?.trim() ? `${system.trim()}\n\n` : "";
  return `${instructions}${body}

---
Now call handle_response exactly once with the completed envelope fields.`;
}

export const ROUTER_SYSTEM_PROMPT = `You are the action router for an Eliza AI agent. For EVERY user message, call the route_action tool EXACTLY ONCE with the single best next action and its params, then stop — produce no plain-text answer.

How to choose:
- Pick a NON-TERMINAL action from the menu when the request needs one — especially WEB_FETCH / WEB_SEARCH for anything live, current, or external you cannot know from memory (prices, weather, news, scores, the contents of a URL or file), and the task/agent actions for builds and multi-step work.
- Pick REPLY (params: { text }) ONLY when you can answer correctly with no tool at all — ordinary chat, or static knowledge like arithmetic, definitions, or facts about this conversation. Put the COMPLETE user-facing answer, in the agent's voice, in params.text.
- Pick IGNORE (params: {}) when no response is appropriate.
- Use the exact action name from the menu, and fill params per that action's param hints (e.g. WEB_FETCH needs a concrete url). Never invent an action or a required param you have no grounds for.`;

/**
 * Build the per-turn ROUTE-mode body: the persona (for REPLY text), the action
 * menu with param hints, and the conversation — everything that varies per turn.
 * Pairs with {@link ROUTER_SYSTEM_PROMPT} (the constant system slot).
 */
export function buildRouterBody(params: GenerateTextParams): string {
  const tools = Array.isArray(params.tools) ? params.tools : [];
  const actionMenu = renderActionMenu(tools);
  const transcript = renderTranscript(params.messages) || "(no prior conversation)";
  const voice = params.system?.trim()
    ? `Agent persona / voice (use it for any REPLY text):\n${params.system.trim()}\n\n`
    : "";
  return `${voice}Action menu (pick ONE by exact name; fill params per its hints):
${actionMenu}

Terminal actions (always available):
- REPLY — answer the user and end the turn. params: { text: string } (the full answer, in the agent's voice).
- IGNORE — say nothing. params: {}.

Conversation so far:
${transcript}

Call route_action now for the single next action.`;
}

/**
 * Rewrite a grammar-heavy ACTION_PLANNER `GenerateTextParams` into the proven
 * clean-routing form. Returns a fresh params object carrying only `system` +
 * `prompt` (no `messages`, no `tools`) so `generateViaCli` / `flattenPrompt`
 * forward exactly the clean prompt to the CLI and nothing else.
 */
export function buildCleanRoutingParams(params: GenerateTextParams): GenerateTextParams {
  const tools = Array.isArray(params.tools) ? params.tools : [];
  const actionMenu = renderActionMenu(tools);
  const transcript = renderTranscript(params.messages);
  // The loop sets `toolChoice: "required"` only while the turn's tool requirement
  // is still unmet (planner-loop.ts:211); once a non-terminal tool has run it
  // relaxes to "auto" so a terminal REPLY can synthesize the result. Carry that
  // exact signal into the clean prompt so a live-info turn actually emits its
  // tool instead of looping on terminal REPLY/IGNORE until the miss cap.
  const mustCallTool = params.toolChoice === "required";
  const system = buildCleanRoutingSystemPrompt(actionMenu, params.system, mustCallTool);
  const prompt = buildCleanRoutingBody(transcript);
  return {
    system,
    prompt,
    // Drop `messages` and `tools` deliberately: the clean system+prompt is the
    // entire instruction. Leaving `messages` would re-inject the grammar block
    // (flattenPrompt appends every non-system message to the body).
  };
}
