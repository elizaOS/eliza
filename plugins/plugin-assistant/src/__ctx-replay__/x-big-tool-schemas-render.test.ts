/** Local measurement only (not committed): render the large non-device planner tools as the planner sends them and dump full JSON. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Action, ContextObject, ToolDefinition } from "@elizaos/core";
import { it, vi } from "vitest";

const OUT = process.env.CTX_BIG_OUT;
const PLATFORM = process.env.CTX_BIG_PLATFORM ?? "android";

const sha = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 12);

/** planner-loop.ts: identical parameter descriptions are stated on the first offered tool only. */
function shareDescriptions(tools: ToolDefinition[]): ToolDefinition[] {
  const described = new Map<string, { tool: string; parameter: string }>();
  return tools.map((tool) => {
    const properties = (tool.parameters as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties;
    if (!properties) return tool;
    let next: Record<string, Record<string, unknown>> | undefined;
    for (const [parameter, schema] of Object.entries(properties)) {
      if (parameter === "eliza_turn_scope") continue;
      const description = schema?.description;
      if (typeof description !== "string") continue;
      const first = described.get(description);
      if (!first) {
        described.set(description, { tool: tool.name, parameter });
        continue;
      }
      if (first.tool === tool.name) continue;
      const reference = `Use the identical full description of parameter ${JSON.stringify(first.parameter)} on tool ${first.tool}.`;
      if (reference.length >= description.length) continue;
      next ??= { ...properties };
      next[parameter] = { ...schema, description: reference };
    }
    return next
      ? ({ ...tool, parameters: { ...tool.parameters, properties: next } } as ToolDefinition)
      : tool;
  });
}

it.skipIf(!OUT)(
  "renders planner tool sets",
  async () => {
    if (PLATFORM !== "desktop") {
      vi.stubEnv("ELIZA_PLATFORM", PLATFORM);
      vi.stubEnv("ELIZA_ANDROID_APP_DATA_DIR", "/tmp/x-big-tools");
    }
    const { personalAssistantPlugin } = await import(
      "../../../plugin-personal-assistant/src/plugin.ts"
    );
    const { promoteMessageActions } = await import(
      "../features/advanced-capabilities/actions/message.ts"
    );
    const { collectPlannerTools } = await import(
      "../services/message/planned-tool.ts"
    );
    const { withTurnScopeToolArg } = await import("../runtime/planner-loop.ts");
    const { plannerBatchScopeDescription } = await import(
      "../prompts/planner.ts"
    );
    const calendarPlugin = (await import("../../../plugin-calendar/src/plugin.ts")) as Record<string, unknown>;
    const standalone = Object.values(calendarPlugin).find(
      (value) => value && typeof value === "object" && Array.isArray((value as { actions?: unknown }).actions) && (value as { name?: string }).name === "calendar",
    ) as { actions: Action[] } | undefined;
    const SOURCE = process.env.CTX_BIG_CALENDAR ?? "standalone";
    const registered = [
      ...(SOURCE === "standalone" ? (standalone?.actions ?? []) : []),
      ...(personalAssistantPlugin.actions ?? []),
      ...promoteMessageActions(),
    ] as Action[];
    writeFileSync(`${OUT}/${PLATFORM}.${SOURCE}.plugin-exports.json`, JSON.stringify({ exports: Object.keys(calendarPlugin), standalone: standalone?.actions.map((a) => a.name) ?? null }));
    const byName = new Map<string, Action>();
    for (const action of registered)
      if (!byName.has(action.name)) byName.set(action.name, action);

    const render = (names: string[], direct: string[] = []) => {
      const actions = names.map((name) => {
        const action = byName.get(name);
        if (!action) throw new Error(`no action ${name}`);
        return action;
      });
      const context = {
        events: actions.map((action) => ({
          id: `tool:${action.name}`,
          type: "tool",
          source: "message-service",
          tool: {
            name: action.name,
            description: action.description,
            parameters: {},
            action,
          },
        })),
      } as unknown as ContextObject;
      const collected = collectPlannerTools(context, undefined, {
        canonicalFamilies: true,
        directActionNames: new Set(direct),
      });
      const scoped = withTurnScopeToolArg(
        collected,
        plannerBatchScopeDescription,
      ) as ToolDefinition[];
      return shareDescriptions(scoped);
    };

    const family = (parent: string) =>
      registered
        .filter(
          (action) =>
            action.name === parent || action.name.startsWith(`${parent}_`),
        )
        .map((action) => action.name)
        .filter((name, index, all) => all.indexOf(name) === index);

    const sets: Record<string, { names: string[]; direct?: string[] }> = {
      calendar_family: { names: family("CALENDAR") },
      calendar_alone: { names: ["CALENDAR"] },
      calendar_update_alone: { names: ["CALENDAR_UPDATE_EVENT"], direct: ["CALENDAR_UPDATE_EVENT"] },
      calendar_delete_alone: { names: ["CALENDAR_DELETE_EVENT"], direct: ["CALENDAR_DELETE_EVENT"] },
      calendar_create_alone: { names: ["CALENDAR_CREATE_EVENT"], direct: ["CALENDAR_CREATE_EVENT"] },
      calendar_create_update: { names: ["CALENDAR_CREATE_EVENT", "CALENDAR_UPDATE_EVENT"], direct: ["CALENDAR_CREATE_EVENT", "CALENDAR_UPDATE_EVENT"] },
      calendar_feed_alone: { names: ["CALENDAR_FEED"], direct: ["CALENDAR_FEED"] },
      calendar_search_alone: { names: ["CALENDAR_SEARCH_EVENTS"], direct: ["CALENDAR_SEARCH_EVENTS"] },
      calendar_next_alone: { names: ["CALENDAR_NEXT_EVENT"], direct: ["CALENDAR_NEXT_EVENT"] },
      calendar_trip_alone: { names: ["CALENDAR_TRIP_WINDOW"], direct: ["CALENDAR_TRIP_WINDOW"] },
      alarms_create_alone: { names: ["OWNER_ALARMS_CREATE"], direct: ["OWNER_ALARMS_CREATE"] },
      todos_create_alone: { names: ["OWNER_TODOS_CREATE"], direct: ["OWNER_TODOS_CREATE"] },
      routines_create_alone: { names: ["OWNER_ROUTINES_CREATE"], direct: ["OWNER_ROUTINES_CREATE"] },
      alarms_reminders_create: { names: ["OWNER_ALARMS_CREATE", "OWNER_REMINDERS_CREATE"], direct: ["OWNER_ALARMS_CREATE", "OWNER_REMINDERS_CREATE"] },
      message_send_alone: { names: ["MESSAGE_SEND"], direct: ["MESSAGE_SEND"] },
      calendar_avail_alone: { names: ["CALENDAR_CHECK_AVAILABILITY"], direct: ["CALENDAR_CHECK_AVAILABILITY"] },
      reminders_family: { names: family("OWNER_REMINDERS") },
      reminders_alone: { names: ["OWNER_REMINDERS"] },
      reminders_create_alone: { names: ["OWNER_REMINDERS_CREATE"], direct: ["OWNER_REMINDERS_CREATE"] },
      message_family: { names: family("MESSAGE") },
      message_alone: { names: ["MESSAGE"] },
    };
    mkdirSync(String(OUT), { recursive: true });
    const summary: Record<string, unknown> = {};
    for (const [label, set] of Object.entries(sets)) {
      let tools: ToolDefinition[];
      try {
        tools = render(set.names, set.direct);
      } catch (error) {
        summary[label] = { error: String(error).slice(0, 300) };
        continue;
      }
      const domain = tools.filter(
        (tool) => !["IGNORE", "STOP", "REPLY"].includes(tool.name),
      );
      summary[label] = domain.map((tool) => {
        const text = JSON.stringify(tool);
        return { name: tool.name, chars: text.length, hash: sha(text) };
      });
      writeFileSync(
        `${OUT}/${PLATFORM}.${SOURCE}.${label}.json`,
        JSON.stringify(domain),
      );
    }
    writeFileSync(
      `${OUT}/${PLATFORM}.${SOURCE}.summary.json`,
      JSON.stringify(summary, null, 1),
    );
    writeFileSync(
      `${OUT}/${PLATFORM}.${SOURCE}.families.json`,
      JSON.stringify({
        CALENDAR: family("CALENDAR"),
        OWNER_REMINDERS: family("OWNER_REMINDERS"),
        MESSAGE: family("MESSAGE"),
      }),
    );
  },
  300_000,
);
