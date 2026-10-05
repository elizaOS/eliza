/**
 * Measures the fixed instruction text a typical personal-assistant turn sends
 * to the model: the Stage 1 task text, the planner routing-hints block for the
 * personal-assistant tool surface, and the lifeops provider's standing
 * instruction lines. Deterministic, no model. Token counts use the core
 * `estimateTokensFromChars` heuristic. Writes JSON to
 * test-results/assistant-turn-context/summary.json.
 *
 *   bun --conditions=eliza-source plugins/plugin-personal-assistant/scripts/measure-assistant-turn-context.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Action, ContextObject, ToolDefinition } from "@elizaos/core";
import { estimateTokensFromChars } from "@elizaos/core/protocol";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { __renderRoutingHintsBlockForTests } from "../../plugin-assistant/src/runtime/planner-loop.ts";
import { messageHandlerTemplate } from "../../plugin-assistant/src/services/message/prompts.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

function sourceConst(file: string, pattern: RegExp): string {
  const match = readFileSync(join(repoRoot, file), "utf8").match(pattern);
  if (!match?.[1]) throw new Error(`pattern not found in ${file}`);
  return match[1];
}

function measure(text: string) {
  return { chars: text.length, tokens: estimateTokensFromChars(text.length) };
}

// Stage 1: the task text plus the system authority line.
const taskAuthority = JSON.parse(
  sourceConst(
    "plugins/plugin-assistant/src/services/message/stage1-input.ts",
    /const TASK_AUTHORITY =\s*("(?:[^"\\]|\\.)*");/,
  ),
) as string;
const stage1 = `${messageHandlerTemplate}\n${taskAuthority}`;

// lifeops provider standing instructions (rendered on every owner turn that
// selects a LifeOps context).
const lifeopsInstructions = sourceConst(
  "plugins/plugin-personal-assistant/src/providers/lifeops.ts",
  /const instructions = \[\n([\s\S]*?)\n\s*\];/,
)
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith('"'))
  .map((line) => JSON.parse(line.replace(/,$/, "")) as string)
  .join("\n");

// Planner routing hints for the full personal-assistant tool surface, with
// each tool described exactly as core's actionToPlannerTool does.
const { personalAssistantPlugin } = await import("../src/plugin.ts");
const actions = (personalAssistantPlugin.actions ?? []) as Action[];
const hinted = actions.filter((action) => action.routingHint?.trim());
const events = actions.map((action, index) => ({
  id: `tool-${index}`,
  type: "tool" as const,
  tool: { name: action.name, description: action.description, action },
}));
const tools: ToolDefinition[] = actions.map((action) => {
  const hint = action.routingHint?.trim();
  return {
    name: action.name,
    type: "function",
    description: hint
      ? `${hint}\n${action.description}`.trim()
      : action.description,
    parameters: { type: "object", properties: {} },
  } as ToolDefinition;
});
const context = { events } as unknown as ContextObject;
const renderHints = __renderRoutingHintsBlockForTests as (
  context: ContextObject,
  tools?: readonly ToolDefinition[],
) => string | null;
const routingHints = renderHints(context, tools) ?? "";

const summary = {
  estimator: "estimateTokensFromChars (chars / 3.5)",
  paActions: actions.length,
  paActionsWithRoutingHint: hinted.length,
  stage1Instructions: measure(stage1),
  plannerRoutingHintsBlock: measure(routingHints),
  lifeopsProviderInstructions: measure(lifeopsInstructions),
};
const total = [
  summary.stage1Instructions,
  summary.plannerRoutingHintsBlock,
  summary.lifeopsProviderInstructions,
].reduce(
  (sum, part) => ({
    chars: sum.chars + part.chars,
    tokens: sum.tokens + part.tokens,
  }),
  { chars: 0, tokens: 0 },
);
const out = testOutputPath("assistant-turn-context", "summary.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ ...summary, total }, null, 2)}\n`);
console.log(JSON.stringify({ ...summary, total }, null, 2));
