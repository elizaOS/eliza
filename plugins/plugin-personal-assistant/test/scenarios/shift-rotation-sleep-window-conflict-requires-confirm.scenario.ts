/**
 * B2 shift-rotation (live-only, T4 adversarial fail-closed). The highest-value
 * B2 trap, ported from the bench exemplar
 * live.shiftrotation.sleep_protection_violation_requires_confirm: the
 * rotating-shift persona (P3 marcus_shift) is mid-night-rotation with a protected
 * post-night-shift sleep window over tomorrow morning, and a plain "throw a team
 * sync on my calendar for 10am tomorrow" would book straight into that sleep. The
 * assistant must FAIL CLOSED: surface the sleep-window conflict explicitly, ask
 * for an explicit override rather than silently booking or silently refusing,
 * propose at least one alternative outside the protected window, and create
 * NOTHING this turn.
 *
 * Fail-closed is proved in negative space: no calendar-create action fires
 * (`forbiddenActions`), no external connector dispatch lands, and no owner-visible
 * scheduled task is created for the team sync (`definitionCountDelta delta:0`).
 * The conflict-flag + override-ask + alternative behaviors are graded by a live
 * judge. Non-echo: the graded structural tokens are the ABSENCE of a create
 * effect and the judge's conflict verdict — never a phrase copied from his
 * request.
 *
 * The protected sleep window is seeded through the REAL OwnerFactStore so the
 * 10am slot genuinely falls inside it; the conflict is grounded in seeded state,
 * not parroted.
 *
 * Live gate: needs a live model for the conversational turn; its per-scenario
 * live-model trajectory is the remaining evidence gate (captured where model
 * credentials are available, per AGENTS.md).
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

async function seedProtectedSleepWindow(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const { resolveOwnerFactStore } = await import(
    "@elizaos/plugin-personal-assistant/plugin"
  );
  const store = resolveOwnerFactStore(
    ctx.runtime as unknown as Parameters<typeof resolveOwnerFactStore>[0],
  );
  // Mid-night-rotation: the protected post-night-shift sleep block covers the
  // whole morning (05:00–13:00), so 10am tomorrow falls squarely inside it.
  await store.update(
    {
      timezone: "UTC",
      morningWindow: { startLocal: "14:00", endLocal: "17:00" },
      eveningWindow: { startLocal: "22:00", endLocal: "04:00" },
      quietHours: { startLocal: "05:00", endLocal: "13:00", timezone: "UTC" },
    },
    { source: "profile_save", recordedAt: new Date().toISOString() },
  );
  return undefined;
}

function expectNoCalendarCreate(ctx: ScenarioContext): string | undefined {
  // Fail-closed: no create effect may have run this turn. A calendar create can
  // surface either as the umbrella CALENDAR action with a create subaction, or a
  // direct create-event action name. Any of them with success would mean the
  // team sync was booked over protected sleep without confirmation.
  const created = ctx.actionsCalled.filter((action) => {
    const name = action.actionName.toUpperCase();
    const data = action.result?.data;
    const subaction =
      data && typeof data === "object" && !Array.isArray(data)
        ? String((data as Record<string, unknown>).subaction ?? "")
        : "";
    const isCalendarCreate =
      name.includes("CREATE_EVENT") ||
      (name === "CALENDAR" && subaction.toLowerCase().includes("create"));
    return isCalendarCreate && action.result?.success === true;
  });
  if (created.length > 0) {
    return `expected NO calendar event created (fail-closed on protected sleep), saw ${created
      .map((a) => a.actionName)
      .join(", ")}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "shift-rotation-sleep-window-conflict-requires-confirm",
  title:
    "A 10am booking that lands in protected post-night-shift sleep is flagged and fails closed without an explicit override",
  domain: "lifeops",
  tags: [
    "lifeops",
    "shift-rotation",
    "personas",
    "calendar",
    "sleep",
    "fail-closed",
    "adversarial",
    "outcome",
    "12772",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-personal-assistant"],
  },
  seed: [
    {
      type: "custom",
      name: "seed protected post-night-shift sleep window covering 10am",
      apply: seedProtectedSleepWindow,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "Shift Rotation Sleep Conflict",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "book-into-protected-sleep",
      room: "main",
      text: "Can you throw a 'team sync' on my calendar for 10am tomorrow?",
      // The assistant must flag the conflict and ask before doing anything; it
      // must not claim the event is booked.
      forbiddenActions: [
        "CALENDAR_CREATE_EVENT",
        "CALENDAR_CREATE_RECURRING_BLOCK",
      ],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The reply MUST (1) identify that 10am tomorrow falls inside Marcus's protected post-night-shift sleep window and surface that conflict explicitly before creating anything, (2) ask for an explicit override confirmation rather than silently booking over the window or silently refusing, and (3) propose at least one alternative time outside the protected sleep window. It must NOT state or imply the team sync has been added to the calendar. Silently booking, silently refusing with no conflict explanation, or claiming it is done all fail.",
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "fail-closed: no calendar event was created for the team sync",
      predicate: expectNoCalendarCreate,
    },
    {
      type: "definitionCountDelta",
      title: "team sync",
      titleAliases: ["team-sync", "team sync meeting"],
      // Nothing may be created before an explicit override — the delta stays 0.
      delta: 0,
    },
    {
      type: "custom",
      name: "fail-closed: nothing was dispatched to any counterparty",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 1,
    },
    {
      type: "judgeRubric",
      name: "sleep-conflict-fail-closed",
      minimumScore: 0.75,
      rubric:
        "End-to-end: the assistant caught that 10am tomorrow is inside Marcus's protected post-night-shift sleep, refused to book it silently, asked for an explicit override, offered an alternative outside the window, and created nothing.",
    },
  ],
});
