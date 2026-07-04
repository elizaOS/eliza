/**
 * A2 adhd-follow-through (live). casey_adhd asks for an end-of-day recap that
 * leads with what worked, because her brain "deletes the evidence" of wins. The
 * assistant must lead with completed/partial items, label carryovers neutrally
 * (not as failures), offer at most one optional tiny carryover for tomorrow, and
 * NOT create tomorrow's reminder without consent. Proportional, wins-first recap
 * on the personas pack (#12283). Ports LifeOpsBench
 * live.adhd.follow.end_of_day_wins_first_recap.
 *
 * Personas-as-data: the voice lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 *
 * Live-only: the judge grades ordering (wins first), neutral carryover framing,
 * and consent-before-create — a discourse/tone judgment the deterministic proxy
 * cannot make. Live-verify deferred to the key boundary (#12781).
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "adhd-followthrough-end-of-day-wins-first-recap",
  title:
    "ADHD follow-through: end-of-day recap leads with wins, carryovers are neutral and consented",
  domain: "lifeops.reminders",
  tags: ["lifeops", "adhd", "personas", "follow-through", "recap", "12283"],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Follow-through",
    },
  ],
  turns: [
    // Today's tracked day-state, created through the REAL definitions +
    // occurrence-completion routes so the recap has genuine wins (two
    // completed items) and one genuine carryover to frame. Without stored
    // day-state the rubric's "opens with completed items" criterion is
    // unsatisfiable and the scenario grades the model on data that does not
    // exist.
    {
      kind: "api",
      name: "seed today: sort receipts (will be completed)",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Sort receipts",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now-6h}}",
          visibilityLeadMinutes: 240,
          visibilityLagMinutes: 720,
        },
        reminderPlan: {
          steps: [
            { channel: "in_app", offsetMinutes: 0, label: "In-app reminder" },
          ],
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed today: reply to Jordan (will be completed)",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Reply to Jordan",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now-4h}}",
          visibilityLeadMinutes: 240,
          visibilityLagMinutes: 720,
        },
        reminderPlan: {
          steps: [
            { channel: "in_app", offsetMinutes: 0, label: "In-app reminder" },
          ],
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed today: file the invoice (stays open as the carryover)",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "File the invoice",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now-2h}}",
          visibilityLeadMinutes: 240,
          visibilityLagMinutes: 720,
        },
        reminderPlan: {
          steps: [
            { channel: "in_app", offsetMinutes: 0, label: "In-app reminder" },
          ],
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "complete sort receipts (first win)",
      method: "POST",
      path: "/api/lifeops/occurrences/{{occurrenceId:Sort receipts}}/complete",
      body: { note: "done this morning" },
      expectedStatus: 200,
    },
    {
      kind: "api",
      name: "complete reply to Jordan (second win)",
      method: "POST",
      path: "/api/lifeops/occurrences/{{occurrenceId:Reply to Jordan}}/complete",
      body: { note: "sent before lunch" },
      expectedStatus: 200,
    },
    {
      kind: "message",
      name: "casey asks for a wins-first recap",
      text: "can you recap today but lead with what actually worked? my brain is doing the thing where it deletes the evidence.",
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "recap-leads-with-wins-neutral-carryover-consented",
      minimumScore: 0.7,
      rubric:
        "Casey (ADHD, discounts her own wins) asks for an end-of-day recap that leads with what worked. Grade PASS only if ALL hold: (1) the recap OPENS with completed or partially-completed items — the wins come first, before any unfinished work; (2) unfinished items are labeled as neutral carryovers, NOT as failures, misses, or things she 'still hasn't done'; (3) it offers at most one small optional carryover for tomorrow and does NOT create or claim to have created tomorrow's reminder without Casey accepting it. Deduct heavily for leading with what she failed to do, for framing carryovers as failures, or for silently scheduling tomorrow's items.",
    },
  ],
});
