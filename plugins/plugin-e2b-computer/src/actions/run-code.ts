import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { E2BComputerService } from "../services/e2b-sandbox.js";
import { readE2BConfig } from "../config.js";

function extractCode(text: string): string | null {
  const fenced = text.match(/```(?:python)?\n([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const runMatch = text.match(/(?:run|execute)\s+(?:python\s+)?code[:\s]+([\s\S]+)/i);
  return runMatch?.[1]?.trim() || null;
}

export const runE2BCodeAction: Action = {
  name: "E2B_RUN_CODE",
  similes: ["SANDBOX_RUN", "COMPUTER_RUN_PYTHON", "E2B_EXECUTE"],
  description: "Execute Python code in an E2B sandbox computer (dry-run without E2B_API_KEY).",
  validate: async (_runtime, message) => {
    const text = message.content?.text || "";
    return /e2b|sandbox|run\s+python|execute\s+code|computer/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const cfg = readE2BConfig((k) => runtime.getSetting(k) as string | undefined);
    const code =
      extractCode(message.content?.text || "") ||
      'print("hello from cheshire e2b computer")';

    // Prefer registered service if present; else ephemeral
    let svc = runtime.getService?.("e2b-computer") as E2BComputerService | null;
    if (!svc) {
      svc = new E2BComputerService((k) => runtime.getSetting(k) as string | undefined);
      await svc.start();
    }

    const result = await svc.runPython(code);
    const body = [
      `E2B computer (${result.dryRun ? "dry-run" : "live"})`,
      result.text ? `result: ${result.text}` : "",
      result.error ? `error: ${result.error}` : "",
      result.logs.stdout.length ? `stdout:\n${result.logs.stdout.join("\n")}` : "",
      !cfg.apiKey ? "hint: set E2B_API_KEY for live sandboxes" : "",
    ]
      .filter(Boolean)
      .join("\n");

    if (callback) {
      await callback({ text: body, actions: ["E2B_RUN_CODE"] });
    }
    return { success: !result.error, text: body, data: { result, mode: svc.getMode() } };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Run python code in e2b:\n```python\nprint(1+1)\n```" },
      },
      {
        name: "{{agent}}",
        content: { text: "Executing in E2B sandbox.", actions: ["E2B_RUN_CODE"] },
      },
    ],
  ],
};
