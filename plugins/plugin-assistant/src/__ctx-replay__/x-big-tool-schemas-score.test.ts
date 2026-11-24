/** Local measurement only (not committed): scores live A/B results with the runtime's own argument validation
 * against the REGISTERED actions (so a slimmer model-facing schema is judged by what the runtime accepts). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Action } from "@elizaos/core";
import { validateToolArgs } from "@elizaos/core";
import { it } from "vitest";

const DIR = process.env.CTX_BIG_EVAL;

type Row = {
  id: string;
  variant: string;
  run: number;
  text?: string;
  calls?: { name: string; arguments: Record<string, unknown> }[];
  prompt_tokens?: number;
  cached_tokens?: number;
  completion_tokens?: number;
  error?: string;
};

it.skipIf(!DIR)("scores live results", async () => {
  const { personalAssistantPlugin } = await import("../../../plugin-personal-assistant/src/plugin.ts");
  const calendar = (await import("../../../plugin-calendar/src/plugin.ts")) as unknown as { calendarPlugin: { actions: Action[] } };
  const { parseNativeTaskCreatePlan } = await import("../../../plugin-personal-assistant/src/actions/lib/task-create-plan-parameter.ts");
  const { CALENDAR_DETAIL_ALIASES } = await import("../../../plugin-calendar/src/calendar-action-schema.ts");
  const aliasSpellings = new Set<string>(Object.values(CALENDAR_DETAIL_ALIASES).flat() as string[]);
  const actions = new Map<string, Action>();
  for (const action of [...calendar.calendarPlugin.actions, ...((personalAssistantPlugin.actions ?? []) as Action[])])
    if (!actions.has(action.name)) actions.set(action.name, action);
  const out: Record<string, unknown> = {};
  for (const file of ["calendar-results.jsonl", "reminder-results.jsonl"]) {
    const path = `${DIR}/${file}`;
    if (!existsSync(path)) continue;
    const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
    out[file] = rows.map((row) => {
      if (row.error) return { id: row.id, variant: row.variant, run: row.run, error: row.error.slice(0, 200) };
      const calls = (row.calls ?? []).map((call) => {
        const { eliza_turn_scope: scope, ...args } = call.arguments ?? {};
        const action = actions.get(call.name);
        const summary: Record<string, unknown> = { name: call.name, scope };
        if (call.name === "PROPOSE_DEVICE_ACTION") {
          const operation = typeof args.operation === "string" ? safe(args.operation) : args.operation;
          summary.operation = (operation as { type?: string } | undefined)?.type;
          return summary;
        }
        if (!action) return summary;
        let validation = { valid: false, args: undefined as unknown, errors: [] as string[] } as ReturnType<typeof validateToolArgs>;
        if (call.name.startsWith("CALENDAR") || call.name.startsWith("OWNER_REMINDERS")) {
          validation = validateToolArgs(action, args);
          summary.valid = validation.valid;
          if (!validation.valid) summary.errors = validation.errors.slice(0, 3);
        }
        if (call.name.startsWith("CALENDAR")) {
          const details = (args.details ?? {}) as Record<string, unknown>;
          summary.subaction = args.subaction ?? args.action;
          summary.topKeys = Object.keys(args).sort();
          summary.detailKeys = Object.keys(details).sort();
          summary.aliasKeys = Object.keys(details).filter((key) => aliasSpellings.has(key) && key !== "start" && key !== "end");
          summary.args = args;
        }
        if (call.name.startsWith("OWNER_REMINDERS")) {
          // The model writes the nested plan as a JSON string; the runtime's validated arguments carry the object.
          const coerced = (validation.args as Record<string, unknown> | undefined)?.createPlan ?? args.createPlan;
          const planValue = typeof coerced === "string" ? safe(coerced) : coerced;
          const plan = parseNativeTaskCreatePlan(planValue);
          summary.planType = typeof (validation.args as Record<string, unknown> | undefined)?.createPlan;
          summary.planAccepted = plan !== null;
          summary.acceptedPlan = plan;
          summary.plan = args.createPlan;
          summary.intent = args.intent;
          summary.other = Object.keys(args).filter((key) => key !== "createPlan").sort();
        }
        return summary;
      });
      return { id: row.id, variant: row.variant, run: row.run, text: row.text, prompt_tokens: row.prompt_tokens, cached_tokens: row.cached_tokens, completion_tokens: row.completion_tokens, calls };
    });
  }
  writeFileSync(`${DIR}/scored.json`, JSON.stringify(out, null, 1));
});

function safe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
