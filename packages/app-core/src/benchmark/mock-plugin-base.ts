import {
  type GenerateTextParams,
  type IAgentRuntime,
  ModelType,
  type Plugin,
} from "@elizaos/core";

const DEFAULT_CODE = "00000000-0000-0000-0000-000000000000";

function extractCode(prompt: string, label: string): string {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escapedLabel}:\\s*([0-9a-fA-F-]{36})`);
  const match = regex.exec(prompt);
  return match?.[1] ?? DEFAULT_CODE;
}

function createBenchmarkActionXml(prompt: string): string {
  const oneInitialCode = extractCode(prompt, "initial code");
  const oneMiddleCode = extractCode(prompt, "middle code");
  const oneEndCode = extractCode(prompt, "end code");

  return [
    "<response>",
    "<thought>Clicking the target element to progress the benchmark.</thought>",
    "<actions>BENCHMARK_ACTION</actions>",
    "<text>Executed CLICK(10,10)</text>",
    "<params>",
    "<BENCHMARK_ACTION>",
    "<operation>CLICK</operation>",
    "<element_id>10</element_id>",
    "<value></value>",
    "<command>CLICK(10,10)</command>",
    "<tool_name>ui.click</tool_name>",
    '<arguments>{"x":10,"y":10}</arguments>',
    "</BENCHMARK_ACTION>",
    "</params>",
    `<one_initial_code>${oneInitialCode}</one_initial_code>`,
    `<one_middle_code>${oneMiddleCode}</one_middle_code>`,
    `<one_end_code>${oneEndCode}</one_end_code>`,
    "</response>",
  ].join("\n");
}

/**
 * Tracked fallback mock benchmark plugin.
 *
 * A local-only override can still live at src/benchmark/mock-plugin.ts (gitignored),
 * but this base implementation keeps CI and unit tests deterministic.
 */
export const mockPlugin: Plugin = {
  name: "eliza-benchmark-mock",
  description:
    "Deterministic benchmark mock plugin used by tests and local benchmark smoke runs.",
  models: {
    [ModelType.TEXT_LARGE]: async (
      _runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string> => {
      const prompt =
        typeof params.prompt === "string"
          ? params.prompt
          : JSON.stringify(params.prompt ?? "");

      if (prompt.includes("RESPOND | IGNORE | STOP")) {
        return "<response><action>RESPOND</action></response>";
      }

      if (prompt.includes("<isFinish>true | false</isFinish>")) {
        return "<response><isFinish>true</isFinish></response>";
      }

      return createBenchmarkActionXml(prompt);
    },
  },
};
