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

test("a reply within the limit is sent unchanged", () => {
  const reply = "Short answer with `inline` code.";
  expect(splitMessage(reply)).toEqual([reply]);
});
