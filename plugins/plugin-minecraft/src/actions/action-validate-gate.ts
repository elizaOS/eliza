import type { IAgentRuntime, Memory, State } from "@elizaos/core";

export type PlannerLegacyValidate = (runtime: IAgentRuntime, message: Memory) => Promise<boolean>;

export async function matchPlannerValidateGate(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  config: {
    keywords: string[];
    regex: RegExp;
    expectedSource?: string;
    legacyValidate: PlannerLegacyValidate;
  }
): Promise<boolean> {
  const textRaw = typeof message.content?.text === "string" ? message.content.text : "";
  const textLower = textRaw.toLowerCase();
  const keywordOk =
    config.keywords.length > 0 &&
    config.keywords.some((kw) => kw.length > 0 && textLower.includes(kw));
  const regexOk = config.regex.test(textLower);
  const source = String(message.content?.source ?? "");
  const expected = config.expectedSource ?? "";
  const sourceOk = expected
    ? source === expected
    : Boolean(source || state || runtime.agentId || runtime.getService);
  const inputOk =
    textRaw.trim().length > 0 || Boolean(message.content && typeof message.content === "object");

  if (!(keywordOk && regexOk && sourceOk && inputOk)) {
    return false;
  }

  try {
    return await config.legacyValidate(runtime, message);
  } catch {
    return false;
  }
}
