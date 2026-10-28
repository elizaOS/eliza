import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  type Action,
  ContextRegistry,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { proposeDeviceAction } from "../device-actions/action.ts";

const binding = vi.hoisted(() => ({
  turn: undefined as unknown,
  notes: "runtime",
  calendar: "runtime",
}));
vi.mock("../device-actions/service.ts", async (original) => ({
  ...(await original<typeof import("../device-actions/service.ts")>()),
  getDeviceActionTurn: () => binding.turn,
  currentAppRecordSource: (_runtime: unknown, domain: string) =>
    domain === "notes" ? binding.notes : binding.calendar,
  readDeviceConversationReceipts: async () => [],
}));

import { createV5MessageContextObject } from "./context-assembly.ts";

const capabilities = [
  "notes.local-record.v1",
  "reminders.local-record.v1",
  "reminders.local-record.v2",
  "calendar.create.v1",
  "calendar.next-read.v1",
  "calendar.local-event.v1",
  "clock.alarms.v1",
  "clock.handoff.v2",
  "open_view",
  "create_note",
  "browser_navigate",
];
const native = proposeDeviceAction;
const notes = {
  name: "NOTES_UPDATE",
  description: "Update a canonical note.",
  contexts: ["notes"],
  parameters: [],
} as unknown as Action;
function fixture() {
  const runtime = {
    agentId: "agent",
    character: { name: "Alpha", bio: [], system: "Answer." },
    contexts: new ContextRegistry([
      { id: "general", description: "General tasks" },
      { id: "notes", description: "Saved notes" },
    ]),
    actions: [notes, native],
    providers: [],
    getSetting: () => null,
    getService: () => null,
    getRoom: async () => null,
    getModelRegistrations: () => [],
    reportError: vi.fn(),
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
  binding.turn = {
    runtime,
    credential: { capabilities },
    viewProfile: { views: ["notes", "home"] },
  };
  binding.notes = "runtime";
  binding.calendar = "runtime";
  return {
    runtime,
    message: {
      id: "message",
      roomId: "room",
      agentId: "agent",
      entityId: "owner",
      content: { text: "Do the requested task." },
    } as Memory,
    state: { values: {}, data: {}, text: "" },
    userRoles: ["OWNER"] as const,
  };
}
async function guidance(options: Record<string, unknown> = {}) {
  const args = fixture();
  const context = await createV5MessageContextObject({ ...args, ...options });
  const event = context.events.find(
    (event) => event.id === "authenticated-phone-capability",
  );
  if (!event || !("content" in event))
    throw Error("Missing capability context");
  return { text: String(event.content), context, args };
}

describe("selected phone capability guidance", () => {
  it("keeps compact authenticated availability and permission boundaries during routing", async () => {
    const { text } = await guidance({ providerPhase: "response" });
    expect(text).toContain("notes.local-record.v1");
    expect(text).toContain("not permission or completion");
    expect(text).toContain("phone owner's approval");
    expect(text).toContain("VIEWS or VIEWS_SHOW");
    expect(text).not.toContain("Snooze means ten minutes");
  });
  it("does not expand unrelated native instructions for canonical Notes", async () => {
    const { text } = await guidance({
      includeTools: true,
      providerPhase: "planning",
      selectedContexts: ["notes"],
      preselectedActions: [notes],
    });
    expect(text).toContain("Current Notes source: runtime");
    expect(text).not.toContain("calendar_read_next takes no window");
  });
  it("retains complete native instructions when the native tool is selected", async () => {
    const { text } = await guidance({
      includeTools: true,
      providerPhase: "planning",
      selectedContexts: ["general"],
      preselectedActions: [native],
    });
    for (const required of [
      "Snooze means ten minutes",
      "notes.local-record.v1",
      "calendar_read_next takes no window",
      "phone owner must separately approve",
      "only a native receipt establishes completion",
    ])
      expect(text).toContain(required);
  });
  it("retains Android Clock handoff constraints on a Clock-only installation", async () => {
    const args = fixture();
    (
      binding.turn as { credential: { capabilities: string[] } }
    ).credential.capabilities = ["clock.handoff.v2"];
    const context = await createV5MessageContextObject({
      ...args,
      providerPhase: "planning",
      selectedContexts: ["general"],
      preselectedActions: [native],
    });
    const event = context.events.find(
      (event) => event.id === "authenticated-phone-capability",
    );
    const text = event && "content" in event ? String(event.content) : "";
    expect(text).toContain("clock.handoff.v2");
    expect(text).toContain(
      "Every Clock handoff, including show, needs separate native approval",
    );
  });
  it("uses the exposed surface rather than an unrelated registered native action", async () => {
    const { text } = await guidance({
      includeTools: true,
      providerPhase: "planning",
      selectedContexts: ["general"],
      actionSurface: {
        exposedActionNames: new Set(["NOTES_UPDATE"]),
        summary: {},
      },
    });
    expect(text).not.toContain("Snooze means ten minutes");
  });
  it("preserves detailed native guidance through completion", async () => {
    const { text } = await guidance({
      providerPhase: "completion",
      selectedContexts: ["general"],
      preselectedActions: [native],
    });
    expect(text).toContain("only a native receipt establishes completion");
    expect(text).toContain("calendar.local-event.v1");
  });
  it("keeps unavailable typed source bindings fenced even in compact routing", async () => {
    const args = fixture();
    binding.notes = "unavailable";
    const context = await createV5MessageContextObject({
      ...args,
      providerPhase: "response",
    });
    const event = context.events.find(
      (event) => event.id === "authenticated-phone-capability",
    );
    expect(event && "content" in event ? event.content : "").toContain(
      "Current Notes source: unavailable",
    );
  });
  it.skipIf(
    !process.env.ALPHA_CONTEXT_TRACE_DIR ||
      !process.env.ALPHA_CONTEXT_METRICS_OUT,
  )(
    "measures exact six captured input fixtures without changing any other bytes",
    async () => {
      if (
        !process.env.ALPHA_CONTEXT_TRACE_DIR ||
        !process.env.ALPHA_CONTEXT_METRICS_OUT
      )
        return;
      const compact = (await guidance({ providerPhase: "response" })).text;
      const full = (
        await guidance({
          providerPhase: "completion",
          selectedContexts: ["general"],
          preselectedActions: [native],
        })
      ).text;
      const files = [
        "tj-d3e08344c5fa2b.json",
        "tj-d397d1e9097064.json",
        "tj-d3222aab53c2c1.json",
        "tj-d11efc63fa5dee.json",
        "tj-d07232570872ab.json",
        "tj-cfd6dd80cb33af.json",
      ];
      const results = files.map((file) => {
        const trace = JSON.parse(
          readFileSync(
            `${process.env.ALPHA_CONTEXT_TRACE_DIR}/${file}`,
            "utf8",
          ),
        );
        const stages: Array<{
          type: string;
          before: number;
          after: number;
          saved: number;
          nativeSurface: boolean;
        }> = [];
        let nativeSurface = false;
        for (const stage of trace.stages) {
          const model = stage.model;
          if (!model) continue;
          const keys = Array.isArray(model.tools)
            ? model.tools.map((tool: { name?: string }) => tool.name)
            : Object.keys(model.tools ?? {});
          if (model.modelType === "ACTION_PLANNER" && keys.length)
            nativeSurface = keys.includes("PROPOSE_DEVICE_ACTION");
          const text = model.messages[1].content as string;
          const line = text
            .split("\n")
            .find((line) =>
              line.startsWith(
                "The authenticated installation enabled-view profile",
              ),
            );
          if (!line)
            throw new Error("Missing captured authenticated capability block");
          const routing =
            model.modelType === "RESPONSE_HANDLER" &&
            !stages.some((s) => s.type === "ACTION_PLANNER");
          const replacement = routing || !nativeSurface ? compact : line;
          const candidate = text.replace(line, replacement);
          expect(candidate.replace(replacement, line)).toBe(text);
          stages.push({
            type: model.modelType,
            before: text.length,
            after: candidate.length,
            saved: text.length - candidate.length,
            nativeSurface: !routing && nativeSurface,
          });
        }
        return {
          file,
          compactGuidanceChars: compact.length,
          fullSyntheticGuidanceChars: full.length,
          fullNativeGuidanceSHA256: createHash("sha256")
            .update(full)
            .digest("hex"),
          stages,
        };
      });
      writeFileSync(
        process.env.ALPHA_CONTEXT_METRICS_OUT,
        JSON.stringify(results, null, 2) + "\n",
      );
      expect(results).toHaveLength(6);
      expect(results.every((result) => result.stages[0].saved > 3000)).toBe(
        true,
      );
    },
  );
  it("does not add another runtime's authenticated capability", async () => {
    const args = fixture();
    binding.turn = { ...(binding.turn as object), runtime: {} };
    const context = await createV5MessageContextObject({
      ...args,
      providerPhase: "response",
    });
    expect(
      context.events.some(
        (event) => event.id === "authenticated-phone-capability",
      ),
    ).toBe(false);
  });
});
