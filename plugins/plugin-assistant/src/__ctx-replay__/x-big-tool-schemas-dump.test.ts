/** Local measurement only (not committed): dump the planner tool definitions of the large non-device tools. */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  type Action,
  buildPlannerToolsFromTieredActions,
  promotedSubactionParent,
} from "@elizaos/core";
import { it } from "vitest";
import { personalAssistantPlugin } from "../../../plugin-personal-assistant/src/plugin.ts";
import { promoteMessageActions } from "../features/advanced-capabilities/actions/message.ts";

const OUT = process.env.CTX_BIG_OUT;

it.skipIf(!OUT)("dumps registered big actions", () => {
  const actions = [
    ...(personalAssistantPlugin.actions ?? []),
    ...promoteMessageActions(),
  ] as Action[];
  const rows: Record<string, unknown>[] = [];
  for (const action of actions) {
    const [tool] = buildPlannerToolsFromTieredActions([action], {
      expandSubActions: false,
    });
    const text = JSON.stringify(tool);
    rows.push({
      name: action.name,
      parent: promotedSubactionParent(action) ?? null,
      chars: text.length,
      hash: createHash("sha256").update(text).digest("hex").slice(0, 12),
      description: (tool.description ?? "").length,
      parameters: JSON.stringify(tool.parameters ?? {}).length,
      subActions: (action.subActions ?? []).length,
      contexts: action.contexts,
    });
  }
  rows.sort((a, b) => Number(b.chars) - Number(a.chars));
  writeFileSync(`${OUT}/registered-rows.json`, JSON.stringify(rows, null, 1));
  console.log(rows.slice(0, 60).map((r) => `${String(r.chars).padStart(6)} ${r.name} parent=${r.parent} desc=${r.description} params=${r.parameters} ctx=${JSON.stringify(r.contexts)}`).join("\n"));
});
