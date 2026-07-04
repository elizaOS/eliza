/**
 * GenUI generation modes and their prompt rules: standalone emits full JSONL
 * patch streams, inline is constrained. Feeds the catalog prompt builder.
 */
import type { ElizaGenUiMode, ElizaGenUiModeConfig } from "./types";

export const STANDALONE_MODE_PROMPT_RULES = [
  "Output ONLY JSONL patches — no prose, no markdown, no explanations.",
  "Each line must be a valid JSON Patch (RFC 6902) operation:",
  '  {"op":"add","path":"...","value":...}',
  '  {"op":"replace","path":"...","value":...}',
  '  {"op":"remove","path":"..."}',
  "Start by setting the root component, then add elements.",
  "The entire response is a UI spec — there is no conversation.",
];

export const INLINE_MODE_PROMPT_RULES = [
  "Respond conversationally first, then output JSONL patches on their own lines when UI is needed.",
  "Each JSONL patch line must be a valid JSON Patch (RFC 6902) operation:",
  '  {"op":"add","path":"...","value":...}',
  '  {"op":"replace","path":"...","value":...}',
  '  {"op":"remove","path":"..."}',
  "Text-only replies are allowed when no UI is needed (greetings, clarifying questions).",
  "Only include JSONL patches when the response benefits from a rich UI.",
];

export function getModePromptRules(
  mode: ElizaGenUiMode,
  customRules?: readonly string[],
): string {
  const baseRules =
    mode === "standalone"
      ? STANDALONE_MODE_PROMPT_RULES
      : INLINE_MODE_PROMPT_RULES;
  const allRules = customRules ? [...baseRules, ...customRules] : baseRules;
  return allRules.map((rule, i) => `${i + 1}. ${rule}`).join("\n");
}

export function getModeSystemPrompt(config: ElizaGenUiModeConfig): string {
  const mode = config.mode ?? "standalone";
  const rules = getModePromptRules(mode, config.customRules);
  return [
    `## Generation Mode: ${mode === "standalone" ? "Standalone (UI-only)" : "Inline (conversation + UI)"}`,
    "",
    rules,
    "",
  ].join("\n");
}

export function buildCatalogPromptWithMode(
  catalogPrompt: string,
  modeConfig?: ElizaGenUiModeConfig,
): string {
  if (!modeConfig) {
    return catalogPrompt;
  }
  return [catalogPrompt, "", getModeSystemPrompt(modeConfig)].join("\n");
}
