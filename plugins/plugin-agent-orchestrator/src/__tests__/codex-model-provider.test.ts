import { ModelType, type IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { taskAgentPlugin } from "../index.js";
import {
  buildCodexExecArgs,
  buildCodexImageDescriptionPrompt,
  buildCodexModelPrompt,
  codexCliImageDescriptionModel,
  isCodexModelProviderEnabled,
  parseCodexImageDescriptionResult,
  promptFromGenerateTextParams,
  readCodexModelProviderPriority,
} from "../services/codex-model-provider.js";

function runtimeWithSettings(settings: Record<string, string>): IAgentRuntime {
  return {
    getSetting(key: string) {
      return settings[key];
    },
  } as IAgentRuntime;
}

describe("codex model provider", () => {
  const originalModels = taskAgentPlugin.models;
  const originalPriority = taskAgentPlugin.priority;

  afterEach(() => {
    taskAgentPlugin.models = originalModels;
    if (originalPriority === undefined) {
      delete taskAgentPlugin.priority;
    } else {
      taskAgentPlugin.priority = originalPriority;
    }
  });

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

  it("reads Codex provider enablement from runtime settings", () => {
    const runtime = runtimeWithSettings({
      PARALLAX_CODEX_MODEL_PROVIDER: "true",
      PARALLAX_CODEX_MODEL_PRIORITY: "77",
    });

    expect(isCodexModelProviderEnabled(runtime)).toBe(true);
    expect(readCodexModelProviderPriority(runtime)).toBe(77);
  });

  it("registers Codex models during plugin init", () => {
    taskAgentPlugin.models = undefined;
    delete taskAgentPlugin.priority;

    taskAgentPlugin.init?.(
      {},
      runtimeWithSettings({
        PARALLAX_CODEX_MODEL_PROVIDER: "true",
        PARALLAX_CODEX_MODEL_PRIORITY: "77",
      }),
    );

    expect(taskAgentPlugin.priority).toBe(77);
    expect(taskAgentPlugin.models?.[ModelType.IMAGE_DESCRIPTION]).toBe(
      codexCliImageDescriptionModel,
    );
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

  it("blocks private image URLs before invoking codex", async () => {
    await expect(
      codexCliImageDescriptionModel(runtimeWithSettings({}), {
        imageUrl: "http://127.0.0.1/image.png",
        prompt: "describe this",
      }),
    ).rejects.toThrow(/private|internal|Blocked/i);
  });
});
