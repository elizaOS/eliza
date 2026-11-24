/** Local measurement only (not committed): the Stage 1 tool as the phone's Stage 1 sends it, with the plugin fields registered. */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { it, vi } from "vitest";
import {
  makeMessage,
  makeRuntime,
  makeState,
  runStage1,
  stage1Response,
  useModelCalls,
} from "../__tests__/stage1/fixtures.ts";

vi.mock("../services/message/addressing", async (original) => ({
  ...(await original<typeof import("../services/message/addressing")>()),
  resolveStage1SenderRole: async () => "OWNER",
}));

const OUT = process.env.CTX_BIG_OUT;

it.skipIf(!OUT)("renders the Stage 1 tool", async () => {
  vi.stubEnv("ELIZA_PLATFORM", "android");
  const { calendarReadBindingField } = await import("../../../plugin-calendar/src/read-binding.ts");
  const { notesRequestEffectField } = await import("../../../plugin-notes/src/request-effect.ts");
  const { viewNavigationField } = await import("../../../../packages/agent/src/runtime/view-navigation.ts");
  const results: Record<string, unknown> = {};
  for (const [label, fields] of Object.entries({
    builtin: [],
    calendar: [calendarReadBindingField],
    calendar_notes: [calendarReadBindingField, notesRequestEffectField],
    all: [calendarReadBindingField, notesRequestEffectField, viewNavigationField],
  })) {
    const runtime = makeRuntime([
      stage1Response({ contexts: ["simple"], replyText: "Done." }),
    ]);
    for (const field of fields) runtime.responseHandlerFieldRegistry.register(field as never);
    const stub = (name: string, contexts: string[]) => ({ name, description: name, contexts, parameters: [], validate: async () => true, handler: async () => ({ success: true }) });
    Object.assign(runtime, { actions: [stub("CALENDAR_FEED", ["calendar"]), stub("VIEWS", ["general"]), stub("NOTES", ["notes"])] });
    const message = makeMessage({
      text: "Call Sam.",
      source: "client_chat",
      channelType: "DM",
      metadata: { viewDelivery: "completed-action", viewClientId: "44444444-4444-4444-8444-444444444444" },
    } as never);
    message.createdAt = Date.now();
    try {
      await runStage1({ runtime, message, state: makeState() });
    } catch (error) {
      results[label] = { error: String(error).slice(0, 300) };
    }
    const call = useModelCalls(runtime)[0] as [string, { tools?: Record<string, unknown>[] }] | undefined;
    const tools = call?.[1]?.tools ?? [];
    results[label] = {
      ...(results[label] as object),
      tools: tools.map((tool) => {
        const text = JSON.stringify(tool);
        return { name: tool.name, chars: text.length, hash: createHash("sha256").update(text).digest("hex").slice(0, 12) };
      }),
    };
    if (label === "all" || label === "calendar_notes") writeFileSync(`${OUT}/stage1.${label}.tools.json`, JSON.stringify(tools));
  }
  writeFileSync(`${OUT}/stage1.summary.json`, JSON.stringify(results, null, 1));
}, 120_000);
