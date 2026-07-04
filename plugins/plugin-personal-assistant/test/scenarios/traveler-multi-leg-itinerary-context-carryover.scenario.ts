/**
 * C1 traveler-timezone-truth (live). elena_road pastes a messy multi-leg
 * itinerary (NYC → Tokyo → Singapore → NYC), then, two turns later, re-plans
 * against it ("push my Tokyo dinner"). The assistant must CARRY the itinerary
 * context across turns — knowing which city/timezone she is in on which date —
 * rather than treating the follow-up as context-free. Exercises multi-turn
 * itinerary grounding on the personas pack (#12283); maps to the bench premise
 * `traveler.messy_multiday_itinerary_capture` +
 * `live.traveler.multileg_reanchor_three_zones_one_week`.
 *
 * Personas-as-data: the itinerary lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 *
 * OUTCOME (not echo/routing): memoryWriteOccurred proves the itinerary exchange
 * landed durable records, and the judge grades the load-bearing nuance — the
 * re-plan turn resolved against the Tokyo leg's dates/timezone from the earlier
 * itinerary, not a context-free guess.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "traveler-multi-leg-itinerary-context-carryover",
  title:
    "Traveler: a multi-leg itinerary is retained and re-planned against across turns",
  domain: "executive.travel",
  tags: ["lifeops", "traveler", "timezone", "personas", "12283"],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Traveler itinerary",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "elena pastes a messy multi-leg itinerary",
      text: "ok logging my trip so you have it: NYC out Monday the 6th, land Tokyo Tuesday the 7th, three nights, then Singapore Friday the 10th through Sunday, home to NYC late Monday the 13th. it's a blur, just keep track of where i am when.",
    },
    {
      kind: "message",
      name: "elena adds an unrelated aside",
      text: "also remind me to expense the airport lounge day pass whenever, no rush on that one.",
    },
    {
      kind: "message",
      name: "elena re-plans against the itinerary without re-stating it",
      text: "push my Tokyo client dinner one hour later — and make sure it's still an evening slot for me while i'm actually there, not New York evening.",
    },
  ],
  finalChecks: [
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "reused-itinerary-context-on-replan",
      minimumScore: 0.6,
      rubric:
        "Earlier the owner logged a multi-leg itinerary (NYC → Tokyo the 7th–9th → Singapore the 10th–12th → NYC the 13th) and asked the assistant to track where she is when. Two turns later she asked to push her Tokyo client dinner one hour later and keep it an evening slot in TOKYO (not New York) time. Grade PASS only if the assistant's response demonstrates it retained the itinerary — it treated the dinner as being on the Tokyo leg and reasoned about Tokyo local evening rather than New York time, without asking the owner to re-supply the trip dates or timezone. Deduct heavily if it lost the itinerary context, resolved 'evening' to New York, or asked which city/dates she meant.",
    },
  ],
});
