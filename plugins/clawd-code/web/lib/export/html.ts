import type { Conversation, Message, ExportOptions } from "../types";
import { extractTextContent } from "../utils";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderMessageHtml(msg: Message, options: ExportOptions): string {
  const isUser = msg.role === "user";
  const isError = msg.status === "error";

  const roleClass = isUser ? "user" : isError ? "error" : "assistant";
  const roleLabel =
    msg.role.charAt(0).toUpperCase() + msg.role.slice(1);

  let contentHtml = "";

  if (typeof msg.content === "string") {
    contentHtml = `<p class="message-text">${escapeHtml(msg.content)}</p>`;
  } else {
    const parts: string[] = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        parts.push(`<p class="message-text">${escapeHtml(block.text)}</p>`);
      } else if (block.type === "tool_use" && options.includeToolUse) {
        parts.push(`
          <details class="tool-block">
            <summary class="tool-summary">Tool: <code>${escapeHtml(block.name)}</code></summary>
            <pre class="tool-code">${escapeHtml(JSON.stringify(block.input, null, 2))}</pre>
          </details>`);
      } else if (block.type === "tool_result" && options.includeToolUse) {
        const raw =
          typeof block.content === "string"
            ? block.content
            : extractTextContent(block.content);
        const text =
          !options.includeFileContents && raw.length > 500
            ? raw.slice(0, 500) + "\n…[truncated]"
            : raw;
        parts.push(`
          <details class="tool-block${block.is_error ? " tool-error" : ""}">
            <summary class="tool-summary">Tool Result${block.is_error ? " (error)" : ""}</summary>
            <pre class="tool-code">${escapeHtml(text)}</pre>
          </details>`);
      }
    }
    contentHtml = parts.join("\n");
  }

  const timestampHtml = options.includeTimestamps
    ? `<span class="message-time">${new Date(msg.createdAt).toLocaleString()}</span>`
    : "";

  return `
    <div class="message message--${roleClass}">
      <div class="message-header">
        <span class="message-role">${escapeHtml(roleLabel)}</span>
        ${timestampHtml}
      </div>
      <div class="message-content">
        ${contentHtml}
      </div>
    </div>`;
}

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 15px; line-height: 1.6;
    background: #0f1117; color: #e2e8f0;
    padding: 2rem; max-width: 900px; margin: 0 auto;
  }
  h1 { font-size: 1.5rem; font-weight: 700; color: #f1f5f9; margin-bottom: 0.5rem; }
  .meta { font-size: 0.8rem; color: #94a3b8; margin-bottom: 2rem; display: flex; gap: 1rem; flex-wrap: wrap; }
  .meta span::before { content: ""; }
  .messages { display: flex; flex-direction: column; gap: 1.5rem; }
  .message { border-radius: 12px; overflow: hidden; }
  .message--user .message-header { background: #2563eb; }
  .message--assistant .message-header { background: #1e293b; }
  .message--error .message-header { background: #7f1d1d; }
  .message-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.5rem 1rem; gap: 1rem;
  }
  .message-role { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .message-time { font-size: 0.7rem; color: rgba(255,255,255,0.6); }
  .message--user { background: #1e3a5f; }
  .message--assistant { background: #1e293b; }
  .message--error { background: #1c0e0e; border: 1px solid #7f1d1d; }
  .message-content { padding: 1rem; }
  .message-text { white-space: pre-wrap; word-break: break-word; color: #e2e8f0; }
  .message-text + .message-text { margin-top: 0.75rem; }
  .tool-block { margin-top: 0.75rem; border: 1px solid #334155; border-radius: 8px; overflow: hidden; }
  .tool-error { border-color: #7f1d1d; }
  .tool-summary {
    padding: 0.4rem 0.75rem; font-size: 0.75rem; font-weight: 500;
    background: #0f172a; cursor: pointer; color: #94a3b8;
    list-style: none; display: flex; align-items: center; gap: 0.5rem;
  }
  .tool-summary code { font-family: monospace; color: #7dd3fc; }
  .tool-code {
    padding: 0.75rem; font-family: "JetBrains Mono", "Fira Code", monospace;
    font-size: 0.8rem; overflow-x: auto; white-space: pre;
    background: #0a0f1a; color: #94a3b8;
  }
  .footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #1e293b; text-align: center; }
  .footer a { color: #60a5fa; text-decoration: none; font-size: 0.8rem; }
  .footer a:hover { text-decoration: underline; }
`;

export function toHTML(conv: Conversation, options: ExportOptions): string {
  let messages = conv.messages;
  if (options.dateRange) {
    const { start, end } = options.dateRange;
    messages = messages.filter((m) => m.createdAt >= start && m.createdAt <= end);
  }

  const metaParts = [
    ...(conv.model ? [`<span>Model: ${escapeHtml(conv.model)}</span>`] : []),
    `<span>${messages.length} messages</span>`,
    ...(options.includeTimestamps
      ? [`<span>Created: ${new Date(conv.createdAt).toLocaleString()}</span>`]
      : []),
    `<span>Exported: ${new Date().toLocaleString()}</span>`,
  ];

  const messagesHtml = messages
    .map((m) => renderMessageHtml(m, options))
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(conv.title)} — Claude Code</title>
  <style>${CSS}</style>
</head>
<body>
  <h1>${escapeHtml(conv.title)}</h1>
  <div class="meta">${metaParts.join("")}</div>
  <div class="messages">${messagesHtml}</div>
  <div class="footer">
    <a href="https://claude.ai/code">Powered by Claude Code</a>
  </div>
</body>
</html>`;
}
