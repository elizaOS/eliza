/** Local measurement only (not committed): size of each registered Stage 1 field (description + schema). */
import { writeFileSync } from "node:fs";
import { it } from "vitest";

const OUT = process.env.CTX_BIG_OUT;

it.skipIf(!OUT)("sizes Stage 1 fields", async () => {
  const { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } = await import(
    "../runtime/builtin-field-evaluators.ts"
  );
  const { calendarReadBindingField } = await import(
    "../../../plugin-calendar/src/read-binding.ts"
  );
  const { notesRequestEffectField } = await import(
    "../../../plugin-notes/src/request-effect.ts"
  );
  const { viewNavigationField } = await import(
    "../../../../packages/agent/src/runtime/view-navigation.ts"
  );
  const { HANDLE_RESPONSE_TOOL, createHandleResponseTool } = await import("@elizaos/core");
  const fields = [
    ...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
    calendarReadBindingField,
    notesRequestEffectField,
    viewNavigationField,
  ].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const rows = fields.map((field) => ({
    name: field.name,
    priority: field.priority,
    description: field.description.length,
    schema: JSON.stringify(field.schema).length,
    schemaDescription: typeof (field.schema as { description?: string }).description === "string" ? (field.schema as { description: string }).description.length : 0,
    text: field.description,
    schemaJson: field.schema,
  }));
  writeFileSync(`${OUT}/stage1-fields.json`, JSON.stringify({
    rows,
    directDescription: createHandleResponseTool({ directMessage: true }).description,
    staticTool: JSON.stringify(HANDLE_RESPONSE_TOOL).length,
  }, null, 1));
});
