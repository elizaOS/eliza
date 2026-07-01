import type { ChatMessage, ChatMessageContentPart } from "@elizaos/core";

/**
 * Flatten `GenerateTextParams` (system + messages/prompt) into the two strings
 * the sanctioned CLIs consume:
 *
 *   - `system`  → claude `--system-prompt` (full replace) / codex top instructions block.
 *   - `body`    → claude `-p <body>` / codex `exec <body>` positional prompt.
 *
 * HARD REQ: both `params.system` AND `params.messages`/`params.prompt` must be
 * forwarded. Dropping `messages` would strip skills/memory/recent-conversation/
 * the `<response>` grammar that the runtime composes into the message array, so
 * the model would answer blind. System/developer-role messages are re-routed to
 * the system slot (joined with an explicit `params.system`); every other role is
 * flattened, in order, into the body. Nothing is dropped.
 */

export interface FlattenedPrompt {
  /** Goes to claude `--system-prompt` / codex instructions block. */
  system: string;
  /** Goes to claude `-p` / codex `exec` positional prompt. */
  body: string;
}

/** Pull readable text out of a tool-result part's `output` (shape varies by
 * provider: `{type:"text",value}`, a bare string, or an array of such parts). */
function toolOutputToText(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map(toolOutputToText).filter(Boolean).join("\n");
  if (typeof output === "object") {
    const o = output as { value?: unknown; text?: unknown; content?: unknown };
    if (typeof o.value === "string") return o.value;
    if (typeof o.text === "string") return o.text;
    if (o.content != null) return toolOutputToText(o.content);
    return JSON.stringify(output);
  }
  return String(output);
}

/**
 * Flatten a message's content into text, surfacing tool-call / tool-result parts
 * (not just plain text). Canonical implementation — the clean-routing planner
 * imports this so the two paths can't drift (a divergent copy that dropped tool
 * results once caused the planner to hallucinate live-info answers).
 */
export function contentToText(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: ChatMessageContentPart) => {
      // Plain text part.
      if (part.type === "text" && typeof part.text === "string") return part.text;
      // Tool call / result carried INSIDE the content array (not on
      // `message.toolCalls`). Eliza threads WEB_FETCH/etc. call+result this way;
      // dropping them (the old behavior) blinded the SDK synthesis to every tool
      // output, so the model fell back to its prior and hallucinated. Surface
      // both so the flattened transcript carries the actual fetched data.
      const p = part as {
        type?: string;
        toolName?: string;
        input?: unknown;
        output?: unknown;
      };
      if (p.type === "tool-call" || p.type === "tool_call") {
        const args = typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {});
        return `[tool_call ${p.toolName ?? "tool"} ${args}]`;
      }
      if (p.type === "tool-result" || p.type === "tool_result") {
        const out = toolOutputToText(p.output);
        return out ? `[tool_result ${p.toolName ?? "tool"}: ${out}]` : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Render one non-system message as a labeled transcript block. */
function renderMessage(message: ChatMessage): string {
  const text = contentToText(message.content);
  // Surface assistant tool calls so a multi-turn transcript keeps the call/
  // result pairing visible to the CLI model (it has no native tool-call slot
  // here — everything is flattened text).
  const toolCallLines =
    message.role === "assistant" && message.toolCalls?.length
      ? message.toolCalls.map((call) => {
          const args =
            typeof call.arguments === "string"
              ? call.arguments
              : JSON.stringify(call.arguments ?? {});
          return `[tool_call ${call.name} ${args}]`;
        })
      : [];

  const label =
    message.role === "assistant" ? "Assistant" : message.role === "tool" ? "Tool result" : "User";

  const lines = [text, ...toolCallLines].filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "";
  return `${label}: ${lines.join("\n")}`;
}

export function flattenPrompt(params: {
  system?: string;
  prompt?: string;
  messages?: ChatMessage[];
}): FlattenedPrompt {
  const systemParts: string[] = [];
  if (params.system && params.system.trim().length > 0) {
    systemParts.push(params.system);
  }

  const bodyParts: string[] = [];
  let lastBodyText = "";

  for (const message of params.messages ?? []) {
    if (message.role === "system" || message.role === "developer") {
      const text = contentToText(message.content);
      if (text.trim().length > 0) systemParts.push(text);
      continue;
    }
    const rendered = renderMessage(message);
    if (rendered.length > 0) {
      bodyParts.push(rendered);
      lastBodyText = contentToText(message.content);
    }
  }

  // The legacy `prompt` string is appended only when it isn't already the tail
  // of the message transcript (callers that pass `messages` usually leave it
  // empty, but some still set both — avoid duplicating it).
  if (params.prompt && params.prompt.trim().length > 0 && params.prompt !== lastBodyText) {
    bodyParts.push(params.prompt);
  }

  return {
    system: systemParts.join("\n\n"),
    body: bodyParts.join("\n\n"),
  };
}
