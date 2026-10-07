/** Real planned-tool -> core action executor -> task extractor path. Model
 * responses are deterministic; no external inference or domain effects. */

import type {
  Action,
  ContextObject,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  buildCanonicalSystemPrompt,
  completionContextSources,
  runWithTrajectoryContext,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { executeV5PlannedToolCall } from "../../../../plugin-assistant/src/services/message/planned-tool.ts";
import { extractTaskCreatePlanWithLlm } from "./extract-task-plan";

const create = JSON.stringify({
  mode: "create",
  requestKind: "reminder",
  nativeProjection: "in_app_only",
  title: "saved title",
  cadenceKind: "once",
  dueInMinutes: 2,
});
async function run(mode: string, outputs: string[]) {
  const prompts: string[] = [];
  const systems: Array<string | undefined> = [];
  const character = { name: "QA", system: "TRUSTED_SYSTEM_PREFIX", bio: [] };
  let effects = 0;
  const rows = [
    {
      id: "old",
      roomId: "room",
      entityId: "owner",
      content: { text: "FULL_ONLY older correction: use exact words" },
    },
  ];
  const state: State = {
    text: "FULL_STATE all receipts and complete history",
    values: {},
    data: {},
  };
  const message = {
    id: "turn",
    roomId: "room",
    entityId: "owner",
    agentId: "agent",
    content: { text: "Remind me about that in 2 minutes, in app only." },
  } as Memory;
  const original: ContextObject = {
    id: "turn",
    metadata: { roomId: "room", messageId: "turn" },
    staticPrefix: {
      systemPrompt: {
        content: buildCanonicalSystemPrompt({ character, userRole: "OWNER" }),
        stable: true,
      },
      characterPrompt: { content: "STYLE_DIRECTION_RETAINED", stable: true },
    },
    events: [
      ...[
        "user: in-app only, never native",
        "assistant: saved title",
        "user: FULL_ONLY older correction: use exact words",
      ].map((content, i) => ({
        id: `history-${i}`,
        type: "segment" as const,
        source: "prior-dialogue",
        segment: {
          id: `history-${i}`,
          label: i === 1 ? "prior_message:agent" : "prior_message:user",
          content,
          stable: false,
        },
      })),
      {
        id: "provider",
        type: "provider",
        name: "permissions",
        text: "Standing constraint: no native grants",
      },
      {
        id: "receipt",
        type: "instruction",
        content: "Current saved effect receipt: record-7",
      },
    ],
  };
  if (mode === "provider-deferred" || mode === "provider-loaded") {
    original.metadata = {
      ...original.metadata,
      providerDiscoveryEnabled: true,
      loadedContextProviders: mode === "provider-loaded" ? ["lifeops"] : [],
    };
    original.events.push({
      id: "provider:lifeops",
      type: "provider",
      name: "lifeops",
      discoveryText:
        "Owner timezone America/Los_Angeles; account work; in-app only; no native permission. Full provider source is available on restoration.",
      text: `Owner timezone America/Los_Angeles; account work; in-app only; no native permission. ${"PROVIDER_FULL_ONLY live health and counts ".repeat(40)}`,
    });
  }
  const sourceSetId = completionContextSources(original).sourceSetId;
  const selection =
    mode === "null"
      ? null
      : {
          mode: mode === "full" ? "full" : "selected",
          complete: mode !== "incomplete",
          sourceSetId: mode === "stale" ? "stale" : sourceSetId,
          relevantSourceIds: ["h1", "h2"],
          constraintSourceIds: [],
          referentSourceIds: [],
          pendingIntentSourceIds: [],
        };
  const action: Action = {
    name: "TASK_EXTRACT_TEST",
    description: "test",
    contexts: ["reminders"],
    validate: async () => true,
    handler: async (runtime, msg, actionState) => {
      const plan = await extractTaskCreatePlanWithLlm({
        runtime,
        message: msg,
        state: actionState,
        intent: String(msg.content.text),
      });
      if (plan.mode === "create") effects++;
      return { success: true, text: JSON.stringify(plan) };
    },
  };
  const runtime = {
    actions: [action],
    character,
    agentId: "agent",
    getRoom: async () => ({ id: "room", worldId: "world" }),
    getWorld: async () => ({
      id: "world",
      metadata: {
        ownership: { ownerId: "owner" },
        roles: { owner: "OWNER" },
        roleSources: { owner: "owner" },
      },
    }),
    getService: () => undefined,
    getSetting: () => undefined,
    reportError: vi.fn(),
    getMemories: vi.fn(async () => structuredClone(rows)),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    useModel: vi.fn(
      async (_type: unknown, params: { prompt: string; system?: string }) => {
        expect(_type).toBe("TEXT_LARGE");
        expect(params).toHaveProperty("responseFormat", {
          type: "json_object",
        });
        expect(`${params.system ?? ""}\n${params.prompt}`).toMatch(/json/i);
        expect(params).not.toHaveProperty("responseSchema");
        prompts.push(params.prompt);
        systems.push(params.system);
        expect(effects).toBe(0);
        return outputs.shift() ?? '{"restoreContext":true}';
      },
    ),
  } as unknown as IAgentRuntime;
  if (mode === "wrong-request") message.id = "wrong" as Memory["id"];
  const before = JSON.stringify(original);
  const result = await runWithTrajectoryContext({ userRole: "OWNER" }, () =>
    executeV5PlannedToolCall({
      runtime,
      plannerRuntime: runtime as never,
      plannerContext: original,
      toolCall: {
        name: action.name,
        params: {},
        completionContext: selection as never,
      },
      executorCtx: {
        message,
        state,
        userRoles: ["OWNER"],
        activeContexts: ["general"],
      },
      executorOptions: { actions: [action] },
    }),
  );
  expect(JSON.stringify(original)).toBe(before);
  return {
    prompts,
    systems,
    effects,
    runtime,
    result,
    expectedSystem: original.staticPrefix?.systemPrompt?.content,
  };
}
describe("task extractor reviewed action handoff", () => {
  it("uses actual producer projection, retaining referent/standing constraints/current receipt, without DB duplication", async () => {
    const r = await run("selected", [create]);
    expect(r.prompts, JSON.stringify(r.result)).toHaveLength(1);
    expect(r.prompts[0]).toContain("assistant: saved title");
    expect(r.prompts[0]).toContain("Standing constraint: no native grants");
    expect(r.prompts[0]).toContain("Current saved effect receipt: record-7");
    expect(r.prompts[0]).not.toContain("FULL_ONLY");
    expect(r.runtime.getMemories).not.toHaveBeenCalled();
    expect(r.effects).toBe(1);
    expect(r.systems).toEqual([r.expectedSystem]);
    expect(r.prompts[0]).not.toContain("TRUSTED_SYSTEM_PREFIX");
    expect(r.prompts[0]).toContain("STYLE_DIRECTION_RETAINED");
  });
  it("uses the planner's deferred provider view without dropping scope, clock, destination or receipts", async () => {
    const r = await run("provider-deferred", [create]);
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0]).toContain(
      "Owner timezone America/Los_Angeles; account work; in-app only; no native permission",
    );
    expect(r.prompts[0]).toContain("Standing constraint: no native grants");
    expect(r.prompts[0]).toContain("Current saved effect receipt: record-7");
    expect(r.prompts[0]).not.toContain("PROVIDER_FULL_ONLY");
    expect(r.runtime.getMemories).not.toHaveBeenCalled();
    expect(r.effects).toBe(1);
  });
  it("keeps a loaded provider complete for extraction", async () => {
    const r = await run("provider-loaded", [create]);
    expect(r.prompts[0]).toContain("PROVIDER_FULL_ONLY");
    expect(r.effects).toBe(1);
  });
  it("restores exact deferred provider originals once before any effect", async () => {
    const r = await run("provider-deferred", [
      '{"restoreContext":true}',
      create,
    ]);
    expect(r.prompts).toHaveLength(2);
    expect(r.prompts[0]).not.toContain("PROVIDER_FULL_ONLY");
    expect(r.prompts[1]).toContain("PROVIDER_FULL_ONLY");
    expect(r.prompts[1]).toContain("Standing constraint: no native grants");
    expect(r.prompts[1]).toContain("Current saved effect receipt: record-7");
    expect(r.runtime.getMemories).toHaveBeenCalledOnce();
    expect(r.effects).toBe(1);
  });
  it("never effects a second unresolved provider restoration", async () => {
    const r = await run("provider-deferred", [
      '{"restoreContext":true}',
      '{"restoreContext":true}',
    ]);
    expect(r.prompts).toHaveLength(2);
    expect(r.prompts[1]).toContain("PROVIDER_FULL_ONLY");
    expect(r.effects).toBe(0);
    expect(r.result.success).toBe(false);
  });
  it.each(["null", "full", "stale", "incomplete", "wrong-request"])(
    "falls back to complete legacy input for %s",
    async (mode) => {
      const r = await run(mode, [create]);
      expect(r.prompts, JSON.stringify(r.result)).toHaveLength(1);
      expect(r.prompts[0]).toContain("FULL_ONLY");
      expect(r.prompts[0]).toContain("FULL_STATE");
      expect(r.runtime.getMemories).toHaveBeenCalledOnce();
      expect(r.systems).toEqual([undefined]);
    },
  );
  it("restores complete original history once before any create effect", async () => {
    const r = await run("selected", ['{"restoreContext":true}', create]);
    expect(r.prompts).toHaveLength(2);
    expect(r.prompts[0]).not.toContain("FULL_ONLY");
    expect(r.prompts[1]).toContain("FULL_ONLY");
    expect(r.prompts[1]).toContain("FULL_STATE");
    expect(r.prompts[1]).toContain("Standing constraint: no native grants");
    expect(r.prompts[1]).toContain("Current saved effect receipt: record-7");
    expect(r.prompts[1]).toContain("assistant: saved title");
    expect(r.runtime.getMemories).toHaveBeenCalledOnce();
    expect(r.effects).toBe(1);
    expect(r.systems).toEqual([r.expectedSystem, r.expectedSystem]);
    expect(
      r.prompts.every((prompt) => !prompt.includes("TRUSTED_SYSTEM_PREFIX")),
    ).toBe(true);
  });
  it.each([
    ['{"restoreContext":true}', '{"restoreContext":true}'],
    ['{"restoreContext":true,"mode":"create"}'],
  ])(
    "never executes repeated or mixed restore/create control",
    async (...outputs) => {
      const r = await run("selected", outputs);
      expect(r.effects).toBe(0);
      expect(r.result.success).toBe(false);
      expect(r.prompts.length).toBeLessThanOrEqual(2);
    },
  );
  it("keeps malformed-output repair within existing two calls", async () => {
    const r = await run("selected", ["not JSON", create]);
    expect(r.prompts).toHaveLength(2);
    expect(r.prompts[1]).toContain("Standing constraint: no native grants");
    expect(r.effects).toBe(1);
    expect(r.systems).toEqual([r.expectedSystem, r.expectedSystem]);
  });
  it("repairs an omitted destination before a planned create effect", async () => {
    const { nativeProjection: _projection, ...omitted } = JSON.parse(create);
    const r = await run("selected", [JSON.stringify(omitted), create]);
    expect(r.prompts).toHaveLength(2);
    expect(r.effects).toBe(1);
    expect(r.systems).toEqual([r.expectedSystem, r.expectedSystem]);
  });
  it("does not execute an unresolved destination after context restoration", async () => {
    const { nativeProjection: _projection, ...omitted } = JSON.parse(create);
    const r = await run("selected", [
      '{"restoreContext":true}',
      JSON.stringify(omitted),
    ]);
    expect(r.prompts).toHaveLength(2);
    expect(r.effects).toBe(0);
    expect(r.result.success).toBe(false);
  });
});

it("missing handoff retains legacy history-read errors instead of producing a plan", async () => {
  const failure = new Error("history storage unavailable");
  const runtime = {
    getMemories: vi.fn(async () => {
      throw failure;
    }),
    useModel: vi.fn(),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  await expect(
    extractTaskCreatePlanWithLlm({
      runtime,
      intent: "remind me",
      message: { roomId: "room", content: { text: "remind me" } } as Memory,
      state: { text: "full", values: {}, data: {} },
    }),
  ).rejects.toBe(failure);
  expect(runtime.useModel).not.toHaveBeenCalled();
});
