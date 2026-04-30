#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const options = {
    chunkHours: 24,
    maxMessagesPerChunk: 80,
    inputPath: "",
    outputPath: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      options.inputPath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--output") {
      options.outputPath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--chunk-hours") {
      options.chunkHours = Number(argv[index + 1] ?? "24");
      index += 1;
      continue;
    }
    if (arg === "--max-messages-per-chunk") {
      options.maxMessagesPerChunk = Number(argv[index + 1] ?? "80");
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.inputPath || !options.outputPath) {
    throw new Error(
      "Usage: node scripts/discord-export-to-markdown-log.mjs --input <file.json> --output <file.md> [--chunk-hours 24] [--max-messages-per-chunk 80]",
    );
  }

  return options;
}

function sanitizeLine(text) {
  return text
    .replace(
      /\b(password|pass|pw|token|secret|api[_ -]?key)\s*:\s*([^\s]+)/giu,
      (_match, label) => `${label}: [REDACTED_SECRET]`,
    )
    .replace(
      /\b(u|username|user)\s*:\s*([^\s]+)/giu,
      (_match, label) => `${label}: [REDACTED_CREDENTIAL]`,
    );
}

function sanitizeContent(text) {
  if (!text) {
    return "";
  }

  return text
    .split("\n")
    .map((line) => sanitizeLine(line))
    .join("\n")
    .trim();
}

function toMessage(rawMessage) {
  const attachments = Array.isArray(rawMessage.attachments)
    ? rawMessage.attachments
    : [];

  return {
    timestamp: new Date(rawMessage.timestamp),
    author:
      rawMessage.author?.nickname ||
      rawMessage.author?.name ||
      rawMessage.author?.id ||
      "Unknown",
    content: sanitizeContent(rawMessage.content ?? ""),
    attachments: attachments.map(
      (attachment) => attachment.fileName || "attachment",
    ),
  };
}

function splitIntoChunks(messages, chunkHours, maxMessagesPerChunk) {
  const chunkMs = chunkHours * 60 * 60 * 1000;
  const chunks = [];
  let currentChunk = [];

  for (const message of messages) {
    const previous = currentChunk.at(-1);
    const shouldStartNewChunk =
      currentChunk.length === 0 ||
      currentChunk.length >= maxMessagesPerChunk ||
      (previous &&
        message.timestamp.getTime() - previous.timestamp.getTime() >= chunkMs);

    if (shouldStartNewChunk && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
    }

    currentChunk.push(message);
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function formatTimestamp(date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatMonth(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(date);
}

function escapePipes(text) {
  return text.replaceAll("|", "\\|");
}

function messageToMarkdown(message) {
  const content = message.content || "_[attachment only]_";
  const attachmentText =
    message.attachments.length > 0
      ? `\n  Attachments: ${message.attachments.map((name) => `\`${name}\``).join(", ")}`
      : "";
  return `- ${formatTimestamp(message.timestamp)} | **${escapePipes(message.author)}**: ${escapePipes(content)}${attachmentText}`;
}

function buildMarkdown(data, messages, chunks, options) {
  const participants = [...new Set(messages.map((message) => message.author))];
  const first = messages[0]?.timestamp;
  const last = messages.at(-1)?.timestamp;
  const attachmentCount = messages.reduce(
    (total, message) => total + message.attachments.length,
    0,
  );

  const lines = [
    `# ${data.channel?.name || "Discord Conversation"}`,
    "",
    "Derived from a Discord export JSON. Secrets like passwords, API keys, and inline credential values are redacted in this markdown output.",
    "",
    "## Summary",
    "",
    `- Channel: \`${data.channel?.id || "unknown"}\` (${data.channel?.type || "unknown"})`,
    `- Participants: ${participants.map((participant) => `**${participant}**`).join(", ")}`,
    `- Message count: ${messages.length}`,
    `- Attachment count: ${attachmentCount}`,
    `- Date range: ${first ? formatTimestamp(first) : "unknown"} to ${last ? formatTimestamp(last) : "unknown"}`,
    `- Chunking rule: new chunk after ${options.chunkHours}h inactivity or ${options.maxMessagesPerChunk} messages`,
    "",
    "## Chunks",
    "",
  ];

  let activeMonth = "";

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const start = chunk[0].timestamp;
    const end = chunk.at(-1).timestamp;
    const monthLabel = formatMonth(start);

    if (monthLabel !== activeMonth) {
      activeMonth = monthLabel;
      lines.push(`### ${monthLabel}`);
      lines.push("");
    }

    lines.push(
      `#### Chunk ${index + 1} — ${formatTimestamp(start)} to ${formatTimestamp(end)} (${chunk.length} messages)`,
    );
    lines.push("");
    for (const message of chunk) {
      lines.push(messageToMarkdown(message));
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(fs.readFileSync(options.inputPath, "utf8"));
  const messages = (raw.messages ?? [])
    .map((message) => toMessage(message))
    .sort(
      (left, right) => left.timestamp.getTime() - right.timestamp.getTime(),
    );
  const chunks = splitIntoChunks(
    messages,
    options.chunkHours,
    options.maxMessagesPerChunk,
  );
  const markdown = buildMarkdown(raw, messages, chunks, options);

  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, markdown, "utf8");
}

main();
