import { expect, test } from "bun:test";
import { splitMessage } from "./discord-helpers";

const FENCE = /^\s*```/;

function fenceLines(chunk: string): number {
  return chunk.split("\n").filter((line) => FENCE.test(line)).length;
}

function withoutFenceLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !FENCE.test(line))
    .join("\n");
}

test("a code block cut between Discord messages is closed and reopened", () => {
  const code = Array.from({ length: 120 }, (_, i) => `const value${i} = ${i} * 2;`).join("\n");
  const reply = `Here is the script:\n\n\`\`\`ts\n${code}\n\`\`\`\n\nRun it with bun.`;
  expect(reply.length).toBeGreaterThan(2000);

  const chunks = splitMessage(reply);

  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    // Discord rejects a message over 2000 characters.
    expect(chunk.length).toBeLessThanOrEqual(2000);
    // Every message opens and closes its own code block, so it renders.
    expect(fenceLines(chunk) % 2).toBe(0);
  }
  // Only fence lines are added; no reply text is lost or changed.
  expect(withoutFenceLines(chunks.join("\n")).replace(/\n+/g, "\n")).toBe(
    withoutFenceLines(reply).replace(/\n+/g, "\n"),
  );
});

test("a code block cut between Discord messages keeps its indentation and blank lines", () => {
  const code = Array.from(
    { length: 40 },
    (_, i) =>
      `def total_${i}(items):\n    total = 0\n\n    for item in items:\n        total += item * ${i}\n    return total`,
  ).join("\n\n");
  const reply = `\`\`\`py\n${code}\n\`\`\``;
  expect(reply.length).toBeGreaterThan(4000);

  const chunks = splitMessage(reply);

  expect(chunks.length).toBeGreaterThan(2);
  for (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(2000);
    expect(fenceLines(chunk) % 2).toBe(0);
  }
  // Each cut lands at the start of a code line. That line keeps its leading
  // spaces, and a blank line at the cut is not removed.
  expect(withoutFenceLines(chunks.join("\n"))).toBe(code);
});

test("a reply within the limit is sent unchanged", () => {
  const reply = "Short answer with `inline` code.";
  expect(splitMessage(reply)).toEqual([reply]);
});
