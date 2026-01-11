import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type IAgentRuntime, type Memory, ModelType } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { askAction } from "../plugin/actions/ask.js";
import { explainAction } from "../plugin/actions/explain.js";
import { fixAction } from "../plugin/actions/fix.js";
import { generateAction } from "../plugin/actions/generate.js";
import { planAction } from "../plugin/actions/plan.js";
import { refactorAction } from "../plugin/actions/refactor.js";
import { reviewAction } from "../plugin/actions/review.js";
import { testAction } from "../plugin/actions/test.js";
import { getCwd, setCwd } from "../plugin/providers/cwd.js";

type UseModelParams = {
  prompt: string;
  maxTokens?: number;
  temperature?: number;
};

function createMemory(text: string): Memory {
  return {
    content: { text },
  } as Memory;
}

async function withTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function createMockRuntime(
  responseText: string,
  options?: { hasReasoningModel?: boolean },
): {
  runtime: IAgentRuntime;
  calls: Array<{ model: string; prompt: string }>;
} {
  const calls: Array<{ model: string; prompt: string }> = [];
  const hasReasoningModel = options?.hasReasoningModel ?? false;

  const runtime: Partial<IAgentRuntime> = {
    useModel: async (model: string, params: UseModelParams) => {
      calls.push({ model, prompt: params.prompt });
      return ` ${responseText} `;
    },
    getModel: (modelType: string) => {
      // Return a handler only if reasoning model is configured
      if (modelType === ModelType.TEXT_REASONING_LARGE && hasReasoningModel) {
        return () => Promise.resolve("");
      }
      if (modelType === ModelType.TEXT_LARGE) {
        return () => Promise.resolve("");
      }
      return undefined;
    },
  };

  return { runtime: runtime as IAgentRuntime, calls };
}

describe("plugin actions: LLM-backed", () => {
  const originalCwd = getCwd();
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await withTempDir("eliza-code-llm-");
    await setCwd(tempDir);
    await fs.writeFile(
      path.join(tempDir, "sample.ts"),
      "export function add(a: number, b: number) { return a + b; }\n",
      "utf-8",
    );
  });

  afterEach(async () => {
    try {
      await setCwd(originalCwd);
    } catch {
      // ignore
    }
    try {
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("ASK calls TEXT_LARGE and returns trimmed output", async () => {
    const { runtime, calls } = createMockRuntime("answer");
    const result = await askAction.handler(
      runtime,
      createMemory("How do I write a for loop?"),
    );

    expect(result.success).toBe(true);
    expect(result.text).toBe("answer");
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(ModelType.TEXT_LARGE);
    expect(calls[0].prompt).toContain("How do I write a for loop?");
  });

  test("PLAN falls back to TEXT_LARGE when reasoning model unavailable", async () => {
    const { runtime, calls } = createMockRuntime("plan");
    const result = await planAction.handler(
      runtime,
      createMemory("plan how to add oauth"),
    );

    expect(result.success).toBe(true);
    expect(result.text).toBe("plan");
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(ModelType.TEXT_LARGE);
    expect(calls[0].prompt).toContain("## Plan");
  });

  test("PLAN uses TEXT_REASONING_LARGE when available", async () => {
    const { runtime, calls } = createMockRuntime("plan", {
      hasReasoningModel: true,
    });
    const result = await planAction.handler(
      runtime,
      createMemory("plan how to add oauth"),
    );

    expect(result.success).toBe(true);
    expect(result.text).toBe("plan");
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(ModelType.TEXT_REASONING_LARGE);
    expect(calls[0].prompt).toContain("## Plan");
  });

  test("GENERATE does not trigger for explicit file paths (validate=false)", async () => {
    const { runtime } = createMockRuntime("code");
    const valid = await generateAction.validate(
      runtime,
      createMemory("generate code in index.html"),
    );
    expect(valid).toBe(false);
  });

  test("GENERATE calls TEXT_LARGE and returns trimmed output", async () => {
    const { runtime, calls } = createMockRuntime("generated");
    const result = await generateAction.handler(
      runtime,
      createMemory("generate a quicksort function in typescript"),
    );

    expect(result.success).toBe(true);
    expect(result.text).toBe("generated");
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(ModelType.TEXT_LARGE);
    expect(calls[0].prompt).toContain("quicksort");
  });

  test("EXPLAIN/REVIEW/REFACTOR/FIX/TEST read a file and call TEXT_LARGE", async () => {
    const actions = [
      { action: explainAction, input: "explain sample.ts" },
      { action: reviewAction, input: "review sample.ts for security" },
      { action: refactorAction, input: "refactor sample.ts for readability" },
      { action: fixAction, input: "fix the bug in sample.ts error: crash" },
      { action: testAction, input: "generate tests for sample.ts using bun" },
    ] as const;

    for (const { action, input } of actions) {
      const { runtime, calls } = createMockRuntime("ok");
      const result = await action.handler(runtime, createMemory(input));

      expect(result.success).toBe(true);
      expect(result.text).toBe("ok");
      expect(calls).toHaveLength(1);
      expect(calls[0].model).toBe(ModelType.TEXT_LARGE);
      expect(calls[0].prompt).toContain("sample.ts");
      expect(calls[0].prompt).toContain("export function add");
    }
  });

  test("EXPLAIN fails with a helpful error for missing files", async () => {
    const { runtime } = createMockRuntime("unused");
    const result = await explainAction.handler(
      runtime,
      createMemory("explain does-not-exist.ts"),
    );

    expect(result.success).toBe(false);
    expect(result.text.toLowerCase()).toContain("file not found");
  });
});
