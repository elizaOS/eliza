/** Throwaway verifier harness (deleted after use): renders and validates the Calendar family with the
 * HEAD schema module (VERIFY_ARM=head, module mocked with a copy of HEAD) or the working-tree one. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Action, ContextObject, ToolDefinition } from "@elizaos/core";
import { it, vi } from "vitest";

const OUT = process.env.VERIFY_OUT;
const ARM = process.env.VERIFY_ARM ?? "now";

const sha = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 12);

function shareDescriptions(tools: ToolDefinition[]): ToolDefinition[] {
  const described = new Map<string, { tool: string; parameter: string }>();
  return tools.map((tool) => {
    const properties = (
      tool.parameters as
        | { properties?: Record<string, Record<string, unknown>> }
        | undefined
    )?.properties;
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
      ? ({
          ...tool,
          parameters: { ...tool.parameters, properties: next },
        } as ToolDefinition)
      : tool;
  });
}

type Schema = Record<string, unknown> & {
  type?: string;
  properties?: Record<string, Schema>;
  anyOf?: Schema[];
  oneOf?: Schema[];
  items?: Schema;
  enum?: unknown[];
};

function sampleValues(schema: Schema): unknown[] {
  if (schema.enum?.length) return [schema.enum[0]];
  if (schema.anyOf?.length) return schema.anyOf.flatMap(sampleValues);
  if (schema.oneOf?.length) return schema.oneOf.flatMap(sampleValues);
  switch (schema.type) {
    case "string":
      return ["2026-10-28T15:00:00"];
    case "number":
    case "integer":
      return [3];
    case "boolean":
      return [true];
    case "array":
      return [schema.items ? sampleValues(schema.items).slice(0, 1) : []];
    case "object": {
      const required = (schema.required as string[] | undefined) ?? [];
      return [
        Object.fromEntries(
          required.map((name) => [
            name,
            sampleValues(schema.properties?.[name] ?? { type: "string" })[0],
          ]),
        ),
      ];
    }
    default:
      return ["x"];
  }
}

const WRONG: unknown[] = [{ nested: 1 }, null];

it.skipIf(!OUT)(
  "verifies calendar details",
  async () => {
    vi.stubEnv("ELIZA_PLATFORM", "android");
    vi.stubEnv("ELIZA_ANDROID_APP_DATA_DIR", "/tmp/x-verify-cal-details");
    const head = (await import(
      "../../../plugin-calendar/test/verify-head-calendar-action-schema.ts"
    )) as Record<string, unknown>;
    if (ARM === "head") {
      vi.doMock(
        "../../../plugin-calendar/src/calendar-action-schema.ts",
        () => head,
      );
    }
    const { validateToolArgs, buildPlannerToolsFromActions } = await import(
      "@elizaos/core"
    );
    const { personalAssistantPlugin } = await import(
      "../../../plugin-personal-assistant/src/plugin.ts"
    );
    const { collectPlannerTools } = await import(
      "../services/message/planned-tool.ts"
    );
    const { withTurnScopeToolArg } = await import("../runtime/planner-loop.ts");
    const { plannerBatchScopeDescription } = await import(
      "../prompts/planner.ts"
    );
    const { calendarPlugin } = (await import(
      "../../../plugin-calendar/src/plugin.ts"
    )) as unknown as { calendarPlugin: { actions: Action[] } };
    const { normalizeCalendarDetails } = await import(
      "../../../plugin-calendar/src/actions/calendar-handler.ts"
    );
    const live = (await import(
      "../../../plugin-calendar/src/calendar-action-schema.ts"
    )) as Record<string, unknown>;

    mkdirSync(String(OUT), { recursive: true });
    const headUmbrella = (head.CALENDAR_DETAILS_PARAMETER_SCHEMA as Schema)
      .properties as Record<string, Schema>;
    const headKeys = Object.keys(headUmbrella);
    const result: Record<string, unknown> = {
      arm: ARM,
      mockedSameAsHead:
        JSON.stringify(live.CALENDAR_DETAILS_PARAMETER_SCHEMA) ===
        JSON.stringify(head.CALENDAR_DETAILS_PARAMETER_SCHEMA),
      headKeys,
    };

    const registrations: Record<string, Action[]> = {
      standalone: calendarPlugin.actions,
      pa: (personalAssistantPlugin.actions ?? []) as Action[],
    };

    // Every other tool in both plugins, to see anything outside the family move.
    const allTools: Record<string, Record<string, unknown>> = {};
    for (const [source, actions] of Object.entries(registrations)) {
      allTools[source] = {};
      const unique = actions.filter(
        (action, index) =>
          actions.findIndex((other) => other.name === action.name) === index,
      );
      for (const action of unique) {
        let text: string;
        try {
          text = JSON.stringify(buildPlannerToolsFromActions([action])[0]);
        } catch (error) {
          text = `ERROR ${String(error).slice(0, 200)}`;
        }
        allTools[source][action.name] = {
          chars: text.length,
          hash: sha(text),
          text,
        };
      }
    }
    result.allTools = allTools;

    // Real planner rendering.
    const renders: Record<string, unknown> = {};
    for (const [source, actions] of Object.entries(registrations)) {
      const byName = new Map<string, Action>();
      for (const action of actions)
        if (!byName.has(action.name)) byName.set(action.name, action);
      const render = (names: string[], direct: string[] = []) => {
        const context = {
          events: names.map((name) => {
            const action = byName.get(name) as Action;
            return {
              id: `tool:${action.name}`,
              type: "tool",
              source: "message-service",
              tool: {
                name: action.name,
                description: action.description,
                parameters: {},
                action,
              },
            };
          }),
        } as unknown as ContextObject;
        const collected = collectPlannerTools(context, undefined, {
          canonicalFamilies: true,
          directActionNames: new Set(direct),
        });
        return shareDescriptions(
          withTurnScopeToolArg(
            collected,
            plannerBatchScopeDescription,
          ) as ToolDefinition[],
        );
      };
      const family = [...byName.keys()].filter(
        (name) => name === "CALENDAR" || name.startsWith("CALENDAR_"),
      );
      const sets: Record<string, { names: string[]; direct?: string[] }> = {
        CALENDAR: { names: ["CALENDAR"] },
        family: { names: family },
        create_update: {
          names: ["CALENDAR_CREATE_EVENT", "CALENDAR_UPDATE_EVENT"],
          direct: ["CALENDAR_CREATE_EVENT", "CALENDAR_UPDATE_EVENT"],
        },
      };
      for (const name of family)
        if (name !== "CALENDAR") sets[name] = { names: [name], direct: [name] };
      const rendered: Record<string, unknown> = {};
      for (const [label, set] of Object.entries(sets)) {
        try {
          const tools = render(set.names, set.direct).filter(
            (tool) => !["IGNORE", "STOP", "REPLY"].includes(tool.name),
          );
          rendered[label] = tools.map((tool) => {
            const text = JSON.stringify(tool);
            return { name: tool.name, chars: text.length, hash: sha(text), tool };
          });
        } catch (error) {
          rendered[label] = { error: String(error).slice(0, 300) };
        }
      }
      renders[source] = rendered;
    }
    result.renders = renders;

    // Validation matrix against the registered actions.
    const validation: Record<string, Record<string, unknown>> = {};
    const spellingsOf = (key: string): string[] => {
      const aliases = head.CALENDAR_DETAIL_ALIASES as Record<string, string[]>;
      for (const [canonical, list] of Object.entries(aliases))
        if (canonical === key || list.includes(key)) return [canonical, ...list];
      return [key];
    };
    for (const [source, actions] of Object.entries(registrations)) {
      const unique = actions.filter(
        (action, index) =>
          actions.findIndex((other) => other.name === action.name) === index,
      );
      for (const action of unique) {
        if (!(action.name === "CALENDAR" || action.name.startsWith("CALENDAR_")))
          continue;
        const detailsParameter = (action.parameters ?? []).find(
          (parameter) => parameter.name === "details",
        );
        const requiredTop = Object.fromEntries(
          (action.parameters ?? [])
            .filter((parameter) => parameter.required)
            .map((parameter) => [
              parameter.name,
              (parameter.schema as Schema).enum?.[0] ?? "Weekly sync",
            ]),
        );
        const cases: Record<string, unknown> = {};
        const run = (label: string, args: Record<string, unknown>) => {
          let outcome: unknown;
          try {
            const validated = validateToolArgs(action, args);
            outcome = {
              valid: validated.valid,
              errors: validated.errors,
              args: validated.args,
              invalid: validated.invalidParameterNames,
            };
          } catch (error) {
            outcome = { threw: String(error).slice(0, 200) };
          }
          cases[label] = outcome;
        };
        run("no-details", { ...requiredTop });
        if (detailsParameter) {
          run("empty-details", { ...requiredTop, details: {} });
          const partners: Record<string, unknown>[] = [
            {},
            { date: "2026-10-28" },
            { timeMin: "2026-10-28T09:00:00", timeMax: "2026-10-28T17:00:00" },
            { windowDays: 3 },
            { windowPreset: "tomorrow" },
          ];
          for (const key of headKeys) {
            const values = [...sampleValues(headUmbrella[key]), ...WRONG, 7, "x", false];
            for (const [valueIndex, value] of values.entries()) {
              for (const [partnerIndex, partner] of partners.entries()) {
                if (Object.hasOwn(partner, key)) continue;
                run(`${key}#v${valueIndex}#p${partnerIndex}`, {
                  ...requiredTop,
                  details: { ...partner, [key]: value },
                });
              }
              run(`${key}#v${valueIndex}#json-string`, {
                ...requiredTop,
                details: JSON.stringify({ [key]: value }),
              });
              run(`${key}#v${valueIndex}#top-level`, {
                ...requiredTop,
                [key]: value,
              });
            }
          }
          // Every spelling pair of the two window bounds, and of each bound with each timezone spelling.
          for (const min of spellingsOf("timeMin"))
            for (const max of spellingsOf("timeMax"))
              for (const zone of [undefined, ...spellingsOf("timeZone")])
                run(`window:${min}+${max}+${zone}`, {
                  ...requiredTop,
                  details: {
                    [min]: "2026-10-28T09:00:00",
                    [max]: "2026-10-28T17:00:00",
                    ...(zone ? { [zone]: "America/Los_Angeles" } : {}),
                  },
                });
          // Every spelling of a field at once.
          for (const canonical of Object.keys(
            head.CALENDAR_DETAIL_ALIASES as Record<string, string[]>,
          )) {
            const all = Object.fromEntries(
              spellingsOf(canonical).map((name) => [
                name,
                sampleValues(headUmbrella[name] ?? { type: "string" })[0],
              ]),
            );
            run(`all-spellings:${canonical}`, { ...requiredTop, details: all });
          }
          // Unknown keys stay rejected.
          for (const unknown of ["calendarID", "EventId", "start_At", "foo"])
            run(`unknown:${unknown}`, {
              ...requiredTop,
              details: { [unknown]: "x" },
            });
        }
        validation[`${source}:${action.name}`] = cases;
      }
    }
    result.validation = validation;

    // Handler normalisation of every spelling.
    const normalised: Record<string, unknown> = {};
    for (const key of headKeys)
      for (const [valueIndex, value] of sampleValues(headUmbrella[key]).entries())
        normalised[`${key}#v${valueIndex}`] = normalizeCalendarDetails({
          [key]: value,
        });
    for (const canonical of Object.keys(
      head.CALENDAR_DETAIL_ALIASES as Record<string, string[]>,
    )) {
      const names = spellingsOf(canonical);
      normalised[`all:${canonical}`] = normalizeCalendarDetails(
        Object.fromEntries(names.map((name, index) => [name, `value-${index}`])),
      );
      normalised[`reverse:${canonical}`] = normalizeCalendarDetails(
        Object.fromEntries(
          [...names].reverse().map((name, index) => [name, `value-${index}`]),
        ),
      );
    }
    result.normalised = normalised;

    writeFileSync(`${OUT}/${ARM}.json`, JSON.stringify(result));
  },
  600_000,
);
