import type { IAgentRuntime } from "@elizaos/core";
import type { Context, Telegraf } from "telegraf";
import { describe, expect, it } from "vitest";
import { MessageManager } from "../src/messageManager";
import {
  splitTelegramText,
  TELEGRAM_MESSAGE_MAX_LENGTH,
} from "../src/standalone/handler";
import { convertMarkdownToTelegram } from "../src/utils";

const LIMIT = TELEGRAM_MESSAGE_MAX_LENGTH;
const SKIN_TONE_THUMB = "\u{1F44D}\u{1F3FD}";
const KOREA_FLAG = "\u{1F1F0}\u{1F1F7}";

// The split path only reads its argument, so the bot and runtime are bare
// stand-ins that the constructor stores and never touches.
const manager = new MessageManager(
  {} as Telegraf<Context>,
  {} as IAgentRuntime,
);
const splitMessage = (text: string): string[] =>
  (
    manager as unknown as { splitMessage(value: string): string[] }
  ).splitMessage(text);

const splitters: Array<[string, (text: string) => string[]]> = [
  ["splitTelegramText", splitTelegramText],
  ["MessageManager.splitMessage", splitMessage],
];

describe.each(splitters)("%s grapheme-safe cut", (_name, split) => {
  it("keeps a skin-tone emoji whole at the boundary", () => {
    const text = `${"a".repeat(LIMIT - 2)}${SKIN_TONE_THUMB}b`;
    const parts = split(text);
    expect(parts).toEqual(["a".repeat(LIMIT - 2), `${SKIN_TONE_THUMB}b`]);
    expect(parts.join("")).toBe(text);
  });

  it("keeps a flag whole at the boundary", () => {
    const text = `${"a".repeat(LIMIT - 2)}${KOREA_FLAG}`;
    const parts = split(text);
    expect(parts).toEqual(["a".repeat(LIMIT - 2), KOREA_FLAG]);
    expect(parts.join("")).toBe(text);
  });

  it("cuts plain ASCII text at the limit unchanged", () => {
    const text = "x".repeat(LIMIT * 2 + 7);
    const parts = split(text);
    expect(parts.map((part) => part.length)).toEqual([LIMIT, LIMIT, 7]);
    expect(parts.join("")).toBe(text);
  });

  it("falls back to the surrogate-safe cut for one over-long cluster", () => {
    // One base letter followed by more combining marks than fit in a message.
    const text = `e${"́".repeat(LIMIT + 10)}`;
    let parts: string[] = [];
    expect(() => {
      parts = split(text);
    }).not.toThrow();
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(LIMIT);
    }
    expect(parts.join("")).toBe(text);
  });
});

describe("MessageManager.splitMessage code block across chunks", () => {
  it("reopens the code block in the next chunk", () => {
    const code = Array.from(
      { length: 12 },
      (_, i) => `# step ${i} **important**\necho ${i}`,
    ).join("\n");
    const text = `${"word ".repeat(790)}\n\`\`\`bash\n${code}\n\`\`\`\nAfter the code, see the docs.`;
    const parts = splitMessage(text);

    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(convertMarkdownToTelegram(part).length).toBeLessThanOrEqual(LIMIT);
    }
    // The second chunk starts inside the block, so it carries the opener.
    expect(parts[1].startsWith("```bash\n")).toBe(true);
    // Dropping the repeated opener gives back the original text.
    expect(`${parts[0]}${parts[1].slice("```bash".length)}`).toBe(text);
    const second = convertMarkdownToTelegram(parts[1]);
    // Code lines keep `#` and `**`; the prose after the block is not code.
    expect(second).toContain("# step 11 **important**");
    expect(second.endsWith("```\nAfter the code, see the docs\\.")).toBe(true);
  });

  it("reopens the block when the cut falls after a fence line inside it", () => {
    // A ```js line inside an open ```md block is content, not a closer
    // (CommonMark, as in discord's chunker). Counting every ``` occurrence
    // miscounted it as a closer, so the next chunk lost its reopened opener:
    // the rest of the block was sent as prose and the true closer opened a
    // new block over the prose after it.
    const rows = Array.from({ length: 12 }, (_, i) => `row ${i} of code`).join(
      "\n",
    );
    const tail = `\n\`\`\`md\n${rows}\n\`\`\`js\n`;
    const padLen = LIMIT - 6 - tail.length;
    const text = `${"p".repeat(padLen)}${tail}still code\n\`\`\`\nAfter the block.`;
    const parts = splitMessage(text);

    expect(parts).toHaveLength(2);
    expect(parts[1].startsWith("```md\n")).toBe(true);
    expect(`${parts[0]}${parts[1].slice("```md".length)}`).toBe(text);
    const second = convertMarkdownToTelegram(parts[1]);
    expect(second).toContain("```md\nstill code\n```");
    expect(second.endsWith("```\nAfter the block\\.")).toBe(true);
  });

  it("does not treat a backtick info line as a fence", () => {
    // A line like ```a`b``` is inline code, not a fence: a backtick fence's
    // info string may not contain a backtick.
    const rows = Array.from({ length: 12 }, (_, i) => `row ${i} of code`).join(
      "\n",
    );
    const tail = `\n\`\`\`md\n${rows}\n\`\`\`a\`b\`\`\`\n`;
    const padLen = LIMIT - 6 - tail.length;
    const text = `${"p".repeat(padLen)}${tail}still code\n\`\`\`\nAfter the block.`;
    const parts = splitMessage(text);

    expect(parts).toHaveLength(2);
    expect(parts[1].startsWith("```md\n")).toBe(true);
    expect(`${parts[0]}${parts[1].slice("```md".length)}`).toBe(text);
  });
});
