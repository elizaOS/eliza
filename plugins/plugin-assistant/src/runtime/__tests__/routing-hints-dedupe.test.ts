/**
 * The planner's "# Routing hints" section must not repeat a hint that its
 * native wire tool already carries in its description (#31017), while hints
 * no wire tool carries stay in the section. Deterministic, no model.
 */

import type { ContextObject, ToolDefinition } from "@elizaos/core";
import { expect, it } from "vitest";
import { __renderRoutingHintsBlockForTests } from "../planner-loop.ts";

function toolEvent(name: string, routingHint?: string) {
  return {
    id: `tool-${name}`,
    type: "tool" as const,
    tool: {
      name,
      description: `${name} description`,
      action: {
        name,
        description: `${name} description`,
        ...(routingHint ? { routingHint } : {}),
        validate: async () => true,
        handler: async () => ({ success: true }),
      },
    },
  };
}

function wireTool(name: string, description: string): ToolDefinition {
  return {
    name,
    type: "function",
    description,
    parameters: { type: "object", properties: {} },
  } as ToolDefinition;
}

it("omits hints already on the native tool description and keeps the rest", () => {
  const context = {
    events: [
      toolEvent("CALENDAR", "calendar events and availability -> CALENDAR"),
      toolEvent("OWNER_TODOS", "todos -> OWNER_TODOS"),
    ],
  } as unknown as ContextObject;
  const tools = [
    wireTool(
      "CALENDAR",
      "calendar events and availability -> CALENDAR\nCALENDAR description",
    ),
    // Deferred/renamed: the wire description does not carry the hint.
    wireTool("OWNER_TODOS", "OWNER_TODOS description"),
  ];

  const withoutTools = __renderRoutingHintsBlockForTests(context);
  expect(withoutTools).toContain("calendar events and availability");
  expect(withoutTools).toContain("todos -> OWNER_TODOS");

  const deduped = __renderRoutingHintsBlockForTests(context, tools);
  expect(deduped).toBe("# Routing hints\n- todos -> OWNER_TODOS");
});

it("renders no section when every hint rides on its wire tool", () => {
  const context = {
    events: [toolEvent("CALENDAR", "calendar -> CALENDAR")],
  } as unknown as ContextObject;
  expect(
    __renderRoutingHintsBlockForTests(context, [
      wireTool("CALENDAR", "calendar -> CALENDAR\nCALENDAR description"),
    ]),
  ).toBeNull();
});
