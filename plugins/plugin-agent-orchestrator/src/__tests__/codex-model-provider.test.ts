import { describe, expect, it } from "vitest";
import {
  buildCodexExecArgs,
  buildCodexImageDescriptionPrompt,
  buildCodexModelPrompt,
  parseCodexImageDescriptionResult,
  promptFromGenerateTextParams,
} from "../services/codex-model-provider.js";

describe("codex model provider", () => {
  it("uses codex exec in read-only non-interactive output-file mode", () => {
    const args = buildCodexExecArgs("/tmp/out.txt", {
      binary: "codex",
      workdir: "/workspace",
      model: "gpt-5.5",
      reasoningEffort: "low",
      timeoutMs: 1000,
    });

    expect(args).toEqual([
      "exec",
      "-s",
      "read-only",
      "-C",
      "/workspace",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--ephemeral",
      "--color",
      "never",
      "-c",
      "model_reasoning_effort=low",
      "--output-last-message",
      "/tmp/out.txt",
      "--model",
      "gpt-5.5",
      "-",
    ]);
  });

  it("extracts a plain prompt before falling back to messages", () => {
    expect(promptFromGenerateTextParams({ prompt: "hello" })).toBe("hello");
    expect(
      promptFromGenerateTextParams({
        prompt: "",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
      } as never),
    ).toContain("user: hi");
  });

  it("passes image files to codex exec before the stdin prompt marker", () => {
    const args = buildCodexExecArgs(
      "/tmp/out.txt",
      {
        binary: "codex",
        workdir: "/workspace",
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
        timeoutMs: 1000,
      },
      true,
      { imagePaths: ["/tmp/a.png", "/tmp/b.webp"] },
    );

    expect(args.slice(-5)).toEqual([
      "--image",
      "/tmp/a.png",
      "--image",
      "/tmp/b.webp",
      "-",
    ]);
  });

  it("wraps eliza model calls with strict provider instructions", () => {
    const prompt = buildCodexModelPrompt(
      { prompt: "return <response><text>ok</text></response>" },
      "ACTION_PLANNER",
    );

    expect(prompt).toContain("non-interactive elizaOS model provider");
    expect(prompt).toContain("Model type: ACTION_PLANNER");
    expect(prompt).toContain("<eliza_prompt>");
    expect(prompt).toContain("return <response><text>ok</text></response>");
  });

  it("builds bounded image-description prompts and parses JSON results", () => {
    const prompt = buildCodexImageDescriptionPrompt({
      imageUrl: "https://example.test/image.png",
      prompt: "describe briefly",
    });

    expect(prompt).toContain("IMAGE_DESCRIPTION");
    expect(prompt).toContain("describe briefly");
    expect(prompt).toContain("Return JSON only");

    expect(
      parseCodexImageDescriptionResult(
        '{"title":"Red square","description":"A red square with the word RED."}',
      ),
    ).toEqual({
      title: "Red square",
      description: "A red square with the word RED.",
    });
  });
});
