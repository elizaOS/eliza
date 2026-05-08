import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { hasLinearAccountConfig } from "../accounts";

export interface LinearIntentValidationSpec {
  readonly keywords: readonly string[];
  /** Alternation body only, e.g. `clear|linear|activity` for `/\b(?:…)\b/i`. */
  readonly regexAlternation: string;
}

/**
 * Shared action validator: message intent heuristics plus configured Linear API key.
 * Matches the historical generated checks while using core `Validator` typing.
 */
export async function validateLinearActionIntent(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  spec: LinearIntentValidationSpec
): Promise<boolean> {
  try {
    const textRaw = typeof message.content?.text === "string" ? message.content.text : "";
    const text = textRaw.toLowerCase();
    const keywordOk =
      spec.keywords.length > 0 &&
      spec.keywords.some((word) => word.length > 0 && text.includes(word));
    const regex = new RegExp(`\\b(?:${spec.regexAlternation})\\b`, "i");
    const regexOk = regex.test(text);
    const source = String(message.content?.source ?? "");
    const sourceOk = Boolean(
      source || state || runtime.agentId || runtime.getService || runtime.getSetting
    );
    const inputOk =
      text.trim().length > 0 || Boolean(message.content && typeof message.content === "object");

    if (!(keywordOk && regexOk && sourceOk && inputOk)) {
      return false;
    }

    return hasLinearAccountConfig(runtime);
  } catch {
    return false;
  }
}
