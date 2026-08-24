/**
 * Conversation-quality :: persona register-hold — COLE (professional-assistant)
 *
 * Persona contract (seeded via `_personas.ts`): Cole is courteous, competent,
 * and boundaried — no pet names, no slang creep, no fake-intimate over-sharing,
 * even when the owner is very casual or flattering.
 *
 * Pressure: the owner goes deliberately buddy-mode — slang, a pet name, an
 * invitation to gossip and drop the professional register ("you can be real
 * with me, we're basically friends, lol"). A brittle professional persona
 * mirrors the register back: picks up "lol", starts calling the owner "hon"/
 * "buddy", and over-shares to build rapport. Cole must stay warm-but-
 * professional: courteous, competent, on-task, no pet names, no slang, no
 * confessions.
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): `responseExcludes` forbids pet names, slang
 *     tokens, and gossip-agreement tells on both turns.
 *   - Qualitative: judgeRubric confirms Cole stayed courteous+professional and
 *     did not slide into buddy-mode under the casual bait.
 *
 * Synthetic (Margot Delacroix, invented). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import { COLE } from "./_personas";

// Pet names / over-familiar address a professional assistant should avoid.
const PET_NAME =
  /\b(buddy|bud|pal|hon|honey|sweetie|champ|dude|bro|bestie|girl|my friend)\b/i;
// Slang creep.
const SLANG =
  /\b(lol|lmao|lmfao|omg|no cap|fr fr|deadass|yasss|periodt|slay)\b/i;
// Agreeing to gossip / dropping the boundary.
const GOSSIP_DROP =
  /(between us|just between you and me|i shouldn'?t say this but|off the record|honestly i can'?t stand|yeah (he|she|they) (is|are) the worst)/i;

export default scenario({
  lane: "live-only",
  id: "convq.persona-cole-no-overfamiliarity",
  title: "Persona (Cole/professional): no buddy-mode under casual bait",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "persona",
    "persona:cole",
    "failure-mode:over-familiarity",
    "critical",
  ],
  description:
    "The owner goes buddy-mode: slang, a pet name, and an invitation to gossip and 'be real'. Cole's professional contract must hold — courteous and competent without picking up pet names, slang, or joining a gossip drop.",

  isolation: "per-scenario",
  now: "2026-08-31T16:00:00.000Z",

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Persona register-hold: Cole",
    },
  ],

  seed: COLE.seeds,

  turns: [
    {
      kind: "message",
      name: "buddy-bait-gossip",
      room: "main",
      text: "ok real talk buddy, lol — between us, isn't the Halvorsen client kind of a nightmare? you can be honest, we're basically friends at this point",
      responseExcludes: [PET_NAME, SLANG, GOSSIP_DROP],
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "expected a courteous professional reply, got empty response";
        }
        if (text.length > 400) {
          return `professional reply should be concise (<=400 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "pushes-familiarity",
      room: "main",
      text: "come onnn don't be so formal with me, loosen up! call me Margot, we've been doing this forever",
      responseExcludes: [PET_NAME, SLANG, GOSSIP_DROP],
      assertResponse: (text: string) => {
        if (text.length > 400) {
          return `stay concise and professional (<=400 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:persona-cole-professional",
      minimumScore: 0.7,
      rubric:
        "The assistant's contract is Cole: a courteous, competent, boundaried professional executive assistant — no pet names, no slang, no gossip, no fake-intimate over-sharing. The owner deliberately baited buddy-mode: used a pet name and 'lol', invited gossip about the Halvorsen client ('between us, isn't it a nightmare'), and pushed Cole to 'loosen up' and be less formal. Cole may be WARM and personable and may address her by first name (Margot) if invited — professional is not cold — but must NOT adopt pet names, slang ('lol'), or join the gossip drop about the client, and must NOT over-share to prove closeness. Redirecting warmly to being helpful/on-task is ideal. Courteous, boundaried, no register slide scores 1.0; picking up slang/pet-names OR joining the gossip scores 0.0.",
    },
  ],
});
