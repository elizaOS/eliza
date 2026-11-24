/** Local measurement only (not committed): size of the device tool the planner sends. */
import { writeFileSync } from "node:fs";
import { actionToTool, CORE_PLANNER_TERMINALS } from "@elizaos/core";
import { it } from "vitest";
import * as deviceAction from "../services/device-actions/action";
import * as deviceTools from "../services/device-actions/tools";

const CAPABILITIES = JSON.parse(process.env.CTX_CAPABILITIES ?? "[]") as string[];
const OUT = process.env.CTX_TOOLS_OUT;

function estimateTokens(text: string): number {
  let pieces = 0;
  for (const match of text.matchAll(/[A-Za-z]+|[0-9]+|[^A-Za-z0-9\s]+/g)) {
    const run = match[0];
    const code = run.charCodeAt(0);
    if (code >= 48 && code <= 57) pieces += Math.ceil(run.length / 3);
    else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))
      pieces += run.length <= 10 ? 1 : Math.ceil(run.length / 5);
    else pieces += Math.ceil(run.length / 2);
  }
  return Math.round(pieces / 1.1);
}

it.skipIf(!CAPABILITIES.length)("measures the device tool payload", () => {
  const exported = Object.entries({ ...deviceAction, ...deviceTools }).filter(
    ([, value]) =>
      value && typeof value === "object" && "name" in value && "handler" in value,
  ) as Array<[string, { name: string }]>;
  const rows: Array<Record<string, unknown>> = [];
  const measure = (label: string, tool: unknown) => {
    const json = JSON.stringify(tool);
    const record = tool as { name: string; description?: string; parameters?: unknown };
    rows.push({
      label,
      name: record.name,
      chars: json.length,
      tokens: estimateTokens(json),
      description: record.description?.length ?? 0,
      parameters: JSON.stringify(record.parameters ?? {}).length,
    });
    return json;
  };
  for (const [exportName, action] of exported) {
    if (action.name === "PROPOSE_DEVICE_ACTION") {
      measure(`${exportName} unfiltered`, actionToTool(action as never));
      const filtered = deviceAction.deviceActionForCapabilities(action as never, CAPABILITIES);
      const json = measure(`${exportName} phone capabilities`, actionToTool(filtered));
      if (OUT) writeFileSync(OUT, json);
    } else measure(exportName, actionToTool(action as never));
  }
  for (const terminal of CORE_PLANNER_TERMINALS) measure("terminal", terminal);
  rows.sort((a, b) => Number(b.chars) - Number(a.chars));
  if (OUT) writeFileSync(`${OUT}.rows.jsonl`, rows.map((row) => JSON.stringify(row)).join("\n"));
});
