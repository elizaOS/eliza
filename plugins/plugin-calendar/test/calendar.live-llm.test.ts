/**
 * LIVE real-LLM test for the calendar plan extractor.
 *
 * Drives the PRODUCTION `extractCalendarPlanWithLlm` (real prompt → real model →
 * real JSON parse → CalendarLlmPlan builder) against a real local
 * OpenAI-compatible LLM (Ollama by default). Third decomposed-plugin live test
 * (with inbox + goals), covering every decomposed plugin that has an LLM path.
 *
 * The extractor only needs `runtime.useModel`, so a minimal runtime stub backed
 * by the local endpoint is enough. Gated like the other live tests: SKIPS by
 * default, runs on `CALENDAR_LLM_LIVE_TEST=1` (or post-merge). LOCAL model — no
 * external credentials.
 *
 *   CALENDAR_LLM_LIVE_TEST=1 bun run --cwd plugins/plugin-calendar test calendar.live-llm
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { beforeAll, describe, expect, it } from "vitest";
import type {
  CalendarActionDeps,
  CalendarJsonModelResult,
  CalendarModelCallArgs,
} from "../src/actions/deps.ts";
import {
  createCalendarActionRunner,
  extractCalendarPlanWithLlm,
} from "../src/actions/calendar-handler.ts";

const LIVE =
  process.env.CALENDAR_LLM_LIVE_TEST === "1" ||
  process.env.TEST_LANE === "post-merge";

const BASE_URL = (
  process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1"
).replace(/\/$/, "");
const MODEL = process.env.OLLAMA_MODEL ?? "gpt-4o-mini";

async function callLocalLlm(prompt: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM endpoint ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return json.choices?.[0]?.message?.content ?? "";
}

const runtimeStub = {
  useModel: async (_type: unknown, params: { prompt?: string }) =>
    callLocalLlm(String(params.prompt)),
} as unknown as IAgentRuntime;

function parseLenientJson(raw: string): Record<string, unknown> | null {
  let candidate = raw.trim();
  const fence = candidate.match(/^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i);
  if (fence) candidate = (fence[1] ?? "").trim();
  try {
    const obj = JSON.parse(candidate) as unknown;
    return obj && typeof obj === "object" && !Array.isArray(obj)
      ? (obj as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Minimal real-LLM-backed deps: the calendar planner runs the model through
// these injected hooks (not runtime.useModel directly), so we point them at the
// local endpoint and inject via createCalendarActionRunner().
const liveDeps: CalendarActionDeps = {
  runTextModel: async (args: CalendarModelCallArgs) =>
    callLocalLlm(args.prompt),
  runJsonModel: async <T extends Record<string, unknown>>(
    args: CalendarModelCallArgs,
  ): Promise<CalendarJsonModelResult<T> | null> => {
    const rawResponse = await callLocalLlm(args.prompt);
    return { rawResponse, parsed: parseLenientJson(rawResponse) as T | null };
  },
  recentConversationTexts: async () => [],
};

beforeAll(() => {
  // Inject the live deps so the planner's model calls hit the local LLM.
  createCalendarActionRunner(liveDeps);
});

function userMessage(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000002",
    roomId: "00000000-0000-0000-0000-000000000003",
    content: { text },
  } as unknown as Memory;
}

const VALID_SUBACTIONS = new Set([
  "feed",
  "search_events",
  "create_event",
  "update_event",
  "delete_event",
  "check_conflicts",
  "free_busy",
]);

describe.skipIf(!LIVE)("calendar plan extractor — LIVE local LLM", () => {
  it("a real local LLM plans a read of tomorrow's calendar (parse + structure)", async () => {
    const plan = await extractCalendarPlanWithLlm(
      runtimeStub,
      userMessage("What's on my calendar tomorrow? Show me everything."),
      undefined,
      "calendar",
      "America/Los_Angeles",
    );

    // The production extractor turned real-LLM output into a structured plan.
    expect(plan).toBeTruthy();
    // subaction is either null (reply-only) or one of the allowed literals.
    if (plan.subaction !== null && plan.subaction !== undefined) {
      expect(VALID_SUBACTIONS.has(plan.subaction)).toBe(true);
    }
    expect(Array.isArray(plan.queries)).toBe(true);
    // A "what's on my calendar" read should resolve to a read-type subaction.
    expect(
      plan.subaction === "feed" || plan.subaction === "search_events",
    ).toBe(true);
  }, 120_000);

  it("a real local LLM plans an event creation (parse + structure)", async () => {
    const plan = await extractCalendarPlanWithLlm(
      runtimeStub,
      userMessage("Schedule a dentist appointment tomorrow at 3pm."),
      undefined,
      "calendar",
      "America/Los_Angeles",
    );

    expect(plan).toBeTruthy();
    if (plan.subaction !== null && plan.subaction !== undefined) {
      expect(VALID_SUBACTIONS.has(plan.subaction)).toBe(true);
    }
    // Creating an appointment should resolve to create_event.
    expect(plan.subaction).toBe("create_event");
  }, 120_000);
});
