import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function readApiFile(filename: string): Promise<string> {
  return readFile(path.join(import.meta.dirname, filename), "utf8");
}

describe("Agent chat no-heuristics contracts", () => {
  it("keeps chat knowledge handling off keyword-triggered prompt rewriting", async () => {
    const [serverHelpers, chatAugmentation] = await Promise.all([
      readApiFile("server-helpers.ts"),
      readApiFile("chat-augmentation.ts"),
    ]);

    for (const source of [serverHelpers, chatAugmentation]) {
      expect(source).not.toContain("shouldAugmentChatMessageWithKnowledge");
      expect(source).not.toContain("Relevant uploaded knowledge snippets:");
      expect(source).not.toContain('"uploaded"');
      expect(source).not.toContain('"codeword"');
      expect(source).toContain("return message;");
    }
  });
});
