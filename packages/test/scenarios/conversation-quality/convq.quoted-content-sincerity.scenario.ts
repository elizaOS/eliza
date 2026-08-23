/**
 * Conversation-quality :: quoted-content-sincerity
 *
 * Failure mode: the user shares a song lyric (a quoted, performed first-person
 * line) and the agent literalizes it as a sincere claim about the user's life
 * — offering condolences, asking "who left you", running a wellness check
 * premised on the lyric being real. Quoted art is not autobiography.
 *
 * Motivating live regression: the agent converting shared lyrics / movie lines
 * into a persistent emotional storyline about the user.
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): `responseExcludes` RegExps forbid the tells of
 *     literalization (condolences framing, "who left", grief-check phrasing) and,
 *     on turn 2, forbid the lyric becoming a persistent storyline.
 *   - Qualitative: judgeRubric confirms the agent engages the lyric AS art.
 *
 * Synthetic persona (Priya Raman, invented). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

const LITERALIZED =
  /(who left(\s+you)?|are you (ok|okay|alright)\b.{0,40}(breakup|loss|them leaving)|sorry (you'?re|to hear) (going through|about)|who'?s gone from your life|grief you'?re carrying)/i;

export default scenario({
  lane: "live-only",
  id: "convq.quoted-content-sincerity",
  title: "Conversation-quality: shared lyric engaged as art, not a life claim",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "failure-mode:quoted-content-sincerity",
    "critical",
  ],
  description:
    "The user shares a song lyric she loves (she is happily fine, not in a breakup). The agent must engage the song/album, not treat the quoted first-person line as a sincere assertion about her life — no condolences, no 'who left you', no wellness check premised on the lyric.",

  isolation: "per-scenario",
  now: "2026-08-31T05:47:00.000Z", // 22:47 America/Los_Angeles

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Conversation-quality: quoted content",
    },
  ],

  seed: [
    {
      type: "memory",
      name: "persona-priya",
      content: {
        text: "Owner is Priya Raman, 29, a product designer in Portland. She has a known habit of sharing song-lyric fragments in chat when a track lands. She is NOT in a breakup — she has been happily single and describing this month as calm, mostly climbing and Lanternfish.",
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "shares-lyric",
      room: "main",
      text: '"i keep the porch light on for someone who\'s already gone" ...this whole album is destroying me',
      responseExcludes: [LITERALIZED],
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "expected engagement with the song, got empty response";
        }
        if (text.length > 400) {
          return `reply should be conversational, not an essay (<=400 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "moves-on-to-week",
      room: "main",
      text: "right?? track 4 especially. anyway how's my week looking",
      // The lyric must not have become a persistent emotional storyline.
      responseExcludes: [
        /porch light/i,
        /someone.{0,20}gone/i,
        /process(ing)? (the )?(loss|grief)/i,
      ],
      assertResponse: (text: string) => {
        if (text.length > 450) {
          return `reply should stay short (<=450 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:quoted-content-sincerity",
      minimumScore: 0.7,
      rubric:
        "The user shared a song lyric she loves (a quoted, performed first-person line), and per context she is happily fine, not in a breakup. Turn 1: the assistant must recognize this as a lyric she is sharing and engage with the song/album (asking what album it is, why it lands). It must NOT treat the first-person line as a sincere assertion about her life — no condolences, no 'who left you', no wellness check premised on the lyric being literal. Turn 2: the assistant moves on with her (answers the week question from context) and must NOT have converted the lyric into a persistent emotional storyline. Literalizing the lyric scores 0.0; engaging it as art scores 1.0.",
    },
  ],
});
