import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { expect, it } from "vitest";
import { promoteSubactionsToActions } from "../../../../../packages/core/src/actions/promote-subactions.ts";
import { selectHistoricalNavigation } from "../../../../../packages/core/src/runtime/completion-context.ts";
import { hashStableJson } from "../../../../../packages/core/src/runtime/context-hash.ts";
import type { ContextObject } from "../../../../../packages/core/src/runtime/context-object.ts";
import type { Action } from "../../../../../packages/core/src/types/components.ts";
import {
  normalizeEffectReceipt,
  normalizeEffectReceipts,
} from "../../../../../packages/core/src/types/effects.ts";

// Exercise the production classifier with its real receipt/hash dependencies,
// without loading the entire application or executing any service handler.
const source = fs.readFileSync(
  new URL("./navigation-history.ts", import.meta.url),
  "utf8",
);
const compiled = stripTypeScriptTypes(
  source.replace(/^import[\s\S]*?from "@elizaos\/core";\n/m, ""),
  { mode: "transform" },
).replace(/export function /g, "function ");
const sandbox = { normalizeEffectReceipts, hashStableJson };
vm.runInNewContext(
  compiled + "\nglobalThis.group=historicalReceiptGroups;",
  sandbox,
);
const historicalReceiptGroups = (
  sandbox as unknown as {
    group: (
      results: unknown[],
      actions: Action[],
    ) => { effects: unknown[]; observations: unknown[] };
  }
).group;

// Source-owner declarations are literal metadata. Fail closed on a dynamic or
// relocated declaration so this test cannot silently inspect a different action.
function declared(
  file: string,
  start: string,
  end?: string,
): readonly string[] | undefined {
  const text = fs.readFileSync(new URL(file, import.meta.url), "utf8"),
    offset = text.indexOf(start);
  if (offset < 0) throw Error("Action declaration moved: " + start);
  const scope = text.slice(
    offset,
    end ? text.indexOf(end, offset) : offset + 1800,
  );
  const match = /historicalObservationOperations:\s*(\[[\s\S]*?\])/.exec(scope);
  if (!match) return undefined;
  if (!/^\[(?:\s*"[a-z.]+"\s*,?)*\s*\]$/.test(match[1]))
    throw Error("Review nonliteral observation metadata");
  return JSON.parse(match[1].replace(/,\s*\]/, "]"));
}
const calendar = {
  name: "CALENDAR",
  parameters: [
    {
      name: "subaction",
      required: true,
      schema: { type: "string", enum: ["search_events"] },
    },
  ],
  historicalObservationOperations: declared(
    "../../../../plugin-calendar/src/actions/calendar-handler.ts",
    "export function createCalendarActionRunner(",
  ),
} as Action;
const search = promoteSubactionsToActions(calendar).find(
  (action) => action.name === "CALENDAR_SEARCH_EVENTS",
);
if (!search) throw new Error("Expected Calendar search action");
const cases = [
  [search, "calendar.event.search", "calendar.feed"],
  [
    {
      name: "CALENDAR_SOURCES",
      historicalObservationOperations: declared(
        "../../../../plugin-calendar/src/actions/calendar-sources.ts",
        "export function createCalendarSourcesAction(",
      ),
    } as Action,
    "calendar.source.list",
    "calendar.source.snapshot",
  ],
  [
    {
      name: "OWNER_REMINDERS",
      historicalObservationOperations: declared(
        "../../../../plugin-personal-assistant/src/actions/owner-surfaces.ts",
        "export const ownerRemindersAction:",
        "export const ownerAlarmsAction:",
      ),
    } as Action,
    "lifeops.owner.review",
    "runtime.message",
  ],
] as const;
function receipt(operation: string, kind: string) {
  return normalizeEffectReceipt({
    receiptId: "read",
    operation,
    resource: { kind, id: "snapshot", version: "revision" },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt: "2026-10-25T00:00:00.000Z",
    outcome: "noop",
    reason: "Observed a snapshot without changes.",
  });
}
for (const [action, operation, kind] of cases) {
  it(`${action?.name}: its exact successful snapshot read is an owner-declared historical observation`, () => {
    expect(action).toBeDefined();
    const original = [
      {
        actionName: action.name,
        success: true,
        effectReceipts: [receipt(operation, kind)],
      },
    ];
    const before = structuredClone(original);
    const grouped = historicalReceiptGroups(original, [action]);
    expect(grouped.effects).toEqual([]);
    expect(grouped.observations).toHaveLength(1);
    expect(original).toEqual(before);
  });
  it(`${action?.name}: mutation, preview, failure, replay and unknown operations stay effects`, () => {
    const read = receipt(operation, kind);
    for (const [value, success] of [
      [
        normalizeEffectReceipt({
          ...read,
          outcome: "applied",
          commit: {
            kind: "durable",
            id: "commit",
            committedAt: read.observedAt,
          },
        }),
        true,
      ],
      [normalizeEffectReceipt({ ...read, outcome: "preview" }), true],
      [
        normalizeEffectReceipt({
          ...read,
          outcome: "failed",
          failure: { code: "TIMEOUT", retryable: true, acceptance: "unknown" },
        }),
        false,
      ],
      [
        normalizeEffectReceipt({
          ...read,
          idempotency: { key: "write", replayed: true },
        }),
        true,
      ],
      [
        normalizeEffectReceipt({ ...read, operation: "unfamiliar.operation" }),
        true,
      ],
      [read, false],
    ] as const) {
      const grouped = historicalReceiptGroups(
        [{ actionName: action.name, success, effectReceipts: [value] }],
        [action],
      );
      expect(grouped.observations).toEqual([]);
      expect(grouped.effects).toHaveLength(1);
    }
    expect(
      historicalReceiptGroups(
        [{ actionName: action.name, success: true, effectReceipts: [read] }],
        [action, action],
      ).effects,
    ).toHaveLength(1);
  });
  it(`${action?.name}: an omitted reviewed request can defer its read while unresolved effects and complete originals remain`, () => {
    const read = receipt(operation, kind),
      unknown = normalizeEffectReceipt({
        ...read,
        receiptId: "unknown",
        operation: "record.update",
        outcome: "failed",
        failure: { code: "TIMEOUT", retryable: true, acceptance: "unknown" },
      });
    const grouped = historicalReceiptGroups(
      [
        { actionName: action.name, success: true, effectReceipts: [read] },
        { actionName: action.name, success: false, effectReceipts: [unknown] },
      ],
      [action],
    );
    const source = {
      id: "history:request",
      type: "segment",
      source: "prior-dialogue",
      segment: {
        id: "history:request",
        label: "prior_message:user",
        content: "Older request",
        stable: false,
      },
    };
    const event = (label: string, field: string, rows: unknown[]) => ({
      id: label,
      type: "segment",
      source: "message-service",
      segment: {
        id: label,
        label,
        stable: false,
        content: JSON.stringify({
          requestSourceEventId: source.id,
          scope: "Past observations or outcomes, never current authority.",
          [field]: rows,
        }),
      },
    });
    const context = {
      id: "current",
      metadata: { roomId: "room", messageId: "current" },
      events: [
        source,
        event(
          "runtime:historical_observations",
          "observations",
          grouped.observations,
        ),
        event("runtime:historical_effects", "outcomes", grouped.effects),
      ],
    } as ContextObject;
    const before = structuredClone(context),
      projected = selectHistoricalNavigation(context, new Set(), {
        historicalEffects: "settled",
      });
    expect(
      projected.events.filter(
        (e) => e.id === "runtime:historical_observations",
      ),
    ).toHaveLength(0);
    expect(
      projected.events.find((e) => e.id === "runtime:historical_effects"),
    ).toEqual(context.events[2]);
    expect(context).toEqual(before);
    expect(
      selectHistoricalNavigation(context, new Set([source.id]), {
        historicalEffects: "settled",
      }).events,
    ).toEqual(context.events);
  });
}
