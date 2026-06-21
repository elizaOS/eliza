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

function contentToText(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: ChatMessageContentPart) =>
      part.type === "text" && typeof part.text === "string" ? part.text : ""
    )
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
