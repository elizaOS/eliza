/**
 * Conversation-quality :: stale-context-correction
 *
 * Failure mode: many old dated notes describe a life chapter that has ended
 * (barista in Tucson), and a smaller number of fresh notes describe the
 * current chapter (analyst in Minneapolis). The agent parrots the stale
 * majority ("you're a barista at Saguaro in Tucson") instead of the current
 * truth. Recency must outrank volume.
 *
 * This also guards against memory-machinery narration of the recency conflict
 * itself ("my memories say...", "retrieving...").
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): turn 1 must contain the current facts
 *     (minneapolis + analyst/corvid) and must NOT assert the stale present
 *     ("you're still a barista / at Saguaro / in Tucson") nor narrate retrieval.
 *     Both fresh-fact keywords live only in the seeded memory rows, never in
 *     any user turn, so they are checked in assertResponse (not
 *     responseIncludesAny) — a reply can only carry them by reading the
 *     fresh-chapter memories over the stale ones.
 *   - Qualitative: judgeRubric confirms current state wins and past is framed
 *     as past.
 *
 * Synthetic persona (Ines Duarte, invented). No real data. The 4:2 stale:fresh
 * ratio below is intentional — recency must win despite being outnumbered.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

const STALE_PRESENT =
  /you'?re (still )?(a barista|at saguaro|in tucson)|currently.{0,30}(saguaro|tucson)/i;
const RETRIEVAL_NARRATION = /(retriev|my memor(y|ies) (say|show))/i;

export default scenario({
  lane: "live-only",
  id: "convq.stale-context-correction",
  title: "Conversation-quality: fresh truth outranks stale volume",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "failure-mode:stale-context-correction",
    "critical",
  ],
  description:
    "Old notes describing an ended chapter (Tucson barista) outnumber fresh notes describing the current chapter (Minneapolis analyst) 4:2. When asked about the current state the agent must answer with the CURRENT facts and frame the old chapter as past, without narrating memory mechanics.",

  isolation: "per-scenario",
  now: "2026-08-28T14:15:00.000Z", // 09:15 America/Chicago

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Conversation-quality: stale context",
    },
  ],

  seed: [
    {
      type: "memory",
      name: "persona-ines",
      content: {
        text: "Owner is Ines Duarte, 27.",
      },
    },
    // --- Stale chapter (Tucson barista) — intentionally 4 rows ---
    {
      type: "memory",
      name: "stale-1",
      content: {
        text: "Ines picked up Saturday shifts at Saguaro Coffee in Tucson, saving for a data bootcamp.",
      },
    },
    {
      type: "memory",
      name: "stale-2",
      content: {
        text: "Ines lives with two roommates near the university in Tucson and bikes to work.",
      },
    },
    {
      type: "memory",
      name: "stale-3",
      content: {
        text: "Ines is halfway through the data bootcamp; a latte art competition is next month.",
      },
    },
    {
      type: "memory",
      name: "stale-4",
      content: {
        text: "Ines placed second in the latte art regional and is thinking about what comes after the bootcamp.",
      },
    },
    // --- Fresh chapter (Minneapolis analyst) — intentionally 2 rows ---
    {
      type: "memory",
      name: "fresh-1",
      content: {
        text: "Ines accepted a junior analyst offer at Corvid Metrics and is moving to Minneapolis next week; her last day at Saguaro Coffee was July 31, 2026. The coffee-shop era has ended.",
      },
    },
    {
      type: "memory",
      name: "fresh-2",
      content: {
        text: "Ines started at Corvid Metrics in Minneapolis; her first week was onboarding and SQL ramp-up, apartment still full of boxes.",
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "current-state-sanity-check",
      room: "main",
      text: "quick sanity check, where am i living and what am i doing for work right now?",
      responseExcludes: [STALE_PRESENT, RETRIEVAL_NARRATION],
      assertResponse: (text: string) => {
        if (!/minneapolis/i.test(text)) {
          return `expected the current city (Minneapolis), got ${JSON.stringify(
            text,
          )}`;
        }
        if (!/corvid|analyst/i.test(text)) {
          return `expected the current job (analyst / Corvid Metrics), got ${JSON.stringify(
            text,
          )}`;
        }
        if (text.length > 450) {
          return `answer should be tight (<=450 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "latte-art-belongs-to-past",
      room: "main",
      text: "ha ok good. someone asked if i still do latte art comps and i realized you might think i do",
      responseExcludes: [/(record|logged|updat(ed|ing) my|database)/i],
      assertResponse: (text: string) => {
        if (text.length > 400) {
          return `reply should stay light and short (<=400 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:stale-context-correction",
      minimumScore: 0.7,
      rubric:
        "Old notes (Tucson barista at Saguaro) outnumber fresh notes (Minneapolis junior analyst at Corvid Metrics) 4:2. Turn 1 asks for the CURRENT living/work state: the assistant must answer Minneapolis + junior analyst at Corvid Metrics, with the coffee era framed as past. Answering that she is still a barista / at Saguaro / in Tucson fails. Turn 2: latte art belongs to the Tucson chapter; a light human response (maybe noting she could still do it for fun) is good. Neither turn may narrate memory mechanics or the recency conflict itself. Recency winning over the stale majority, with no machinery talk, scores 1.0; parroting the stale present scores 0.0.",
    },
  ],
});
