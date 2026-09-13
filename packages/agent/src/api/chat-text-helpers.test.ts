/**
 * Exercises the agent HTTP boundary's assistant-text cleanup without replacing
 * or clipping complete long responses.
 */
import { describe, expect, it } from "vitest";
import { stripAssistantStageDirections } from "./chat-text-helpers.ts";

describe("stripAssistantStageDirections", () => {
  it("preserves complete text beyond the former 100k boundary", () => {
    const text = `${"complete line\n".repeat(9_000)}final line`;
    expect(text.length).toBeGreaterThan(100_000);
    expect(stripAssistantStageDirections(text)).toBe(text);
  });

  it("preserves leading indentation inside fenced code blocks", () => {
    const pythonCode =
      "```python\ndef f(x):\n    if x > 1:\n        return x * 2\n    return x\n```";
    expect(stripAssistantStageDirections(pythonCode)).toBe(pythonCode);
  });

  it("preserves leading indentation inside list-nested code blocks", () => {
    const listNested = "- item\n    ```py\n    x = 1\n    ```\n*smiles*";
    expect(stripAssistantStageDirections(listNested)).toBe(
      "- item\n    ```py\n    x = 1\n    ```\n",
    );
  });

  it("preserves outer code fences containing shorter inner code fences", () => {
    const nested =
      "````markdown\n```ts\nconst x = 1;\n```\n    indented tail\n````\n*smiles* done";
    expect(stripAssistantStageDirections(nested)).toBe(
      "````markdown\n```ts\nconst x = 1;\n```\n    indented tail\n````\ndone",
    );
  });
});
