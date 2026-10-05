/**
 * Entity-recognition-from-voice benchmark corpus (#10726 pillar 4).
 *
 * 42 utterances across 4 voice sessions, spoken by 8 distinct Kokoro
 * voices. Each utterance carries ground-truth expectations for the four
 * benchmark capabilities:
 *
 *   - recognition      — a turn by an already-known speaker must bind to
 *                        that speaker's existing entity (no duplicate);
 *   - creation         — an introduction must mint a new person entity
 *                        with the right preferred name;
 *   - attribute        — a stated fact must attach to the right person;
 *   - disambiguation   — confusable names (Maria/Mario/Marie, Erin/Aaron)
 *                        must stay distinct and claims must land on the
 *                        right one of them.
 *
 * The corpus is code, committed; the WAVs it generates are artifacts
 * (see synthesize.ts) and stay out of git. Sessions are independent —
 * the runner executes each in its own process over a fresh PGLite dir,
 * because the knowledge-graph entity store is per-agent, not per-room.
 *
 * Ground truth describes what a correct entity pipeline SHOULD do with
 * each utterance. The shipped extractors intentionally cover only part
 * of it (e.g. partner labels but not "colleague"/"brother"); those rows
 * exist to measure the gap honestly, not to be skipped.
 */

export type BenchCategory =
  | "recognition"
  | "creation"
  | "attribute"
  | "disambiguation";

export interface BenchSpeaker {
  /** Stable key used by utterances. */
  key: string;
  /** Name the speaker claims aloud (null for the un-named owner). */
  spokenName: string | null;
  /** Kokoro voice preset id (must exist in KOKORO_VOICE_PACKS). */
  voice: string;
  /** True for the device owner (turns carry isOwner + bind to self). */
  isOwner?: boolean;
}

export interface ExpectedRelationship {
  /** Preferred name of the target entity. */
  toName: string;
  /** Relationship label as spoken ("wife", "colleague", ...). */
  label: string;
}

export interface ExpectedFact {
  /** Person the fact is about (preferred-name substring, normalized). */
  subject: string;
  /** All keywords must appear in the stored fact/attribute (normalized). */
  keywords: string[];
}

export interface BenchUtterance {
  /** Unique id, `<session>-<seq>`; also the WAV basename. */
  id: string;
  session: string;
  seq: number;
  /** Speaker key into SPEAKERS. */
  speaker: string;
  /**
   * Voice-imprint cluster id for the turn. A speaker's canonical cluster
   * is `cl-<key>`; `-b` variants simulate a profile reset (same person,
   * new cluster) to test name-based re-recognition.
   */
  cluster: string;
  /**
   * True when the cluster was already bound to an entity by an earlier
   * turn — the runner then passes `matchedEntityId`, exactly like the
   * production voice-profile store does after VOICE_ENTITY_BOUND.
   */
  profileBound: boolean;
  /** Reference transcript == Kokoro synthesis input. */
  text: string;
  category: BenchCategory;
  /** A new person entity with this name must exist after the turn. */
  expectCreates?: string;
  /** The turn must bind to the entity of this speaker key (no dupe). */
  expectBindsTo?: string;
  /** A relationship from the owner must exist after the session. */
  expectRelationship?: ExpectedRelationship;
  /** A fact/attribute must be attached after the session. */
  expectFact?: ExpectedFact;
}

export interface BenchSession {
  id: string;
  title: string;
  /** Speaker keys participating (owner always included). */
  speakers: string[];
  utterances: BenchUtterance[];
}

/** Kokoro registry voices only (unknown ids silently fall back). */
export const SPEAKERS: readonly BenchSpeaker[] = [
  { key: "owner", spokenName: null, voice: "bm_lewis", isOwner: true },
  { key: "jill", spokenName: "Jill", voice: "af_nicole" },
  { key: "bob", spokenName: "Bob", voice: "bm_george" },
  { key: "maria_chen", spokenName: "Maria Chen", voice: "af_bella" },
  { key: "maria", spokenName: "Maria", voice: "af_bella" },
  { key: "mario", spokenName: "Mario", voice: "am_michael" },
  { key: "marie", spokenName: "Marie", voice: "af_sarah" },
  { key: "erin", spokenName: "Erin", voice: "bf_emma" },
  { key: "aaron", spokenName: "Aaron", voice: "am_adam" },
] as const;

export function speakerByKey(key: string): BenchSpeaker {
  const speaker = SPEAKERS.find((s) => s.key === key);
  if (!speaker) throw new Error(`unknown speaker key: ${key}`);
  return speaker;
}

function utt(
  session: string,
  seq: number,
  fields: Omit<BenchUtterance, "id" | "session" | "seq">,
): BenchUtterance {
  return {
    id: `${session}-${String(seq).padStart(2, "0")}`,
    session,
    seq,
    ...fields,
  };
}

const S1 = "household";
const HOUSEHOLD: BenchSession = {
  id: S1,
  title: "Household introductions, partner claim, attributes",
  speakers: ["owner", "jill", "bob"],
  utterances: [
    utt(S1, 1, {
      speaker: "jill",
      cluster: "cl-jill",
      profileBound: false,
      text: "Hi, my name is Jill.",
      category: "creation",
      expectCreates: "Jill",
    }),
    utt(S1, 2, {
      speaker: "owner",
      cluster: "cl-owner",
      profileBound: true,
      text: "This is my wife Jill.",
      category: "disambiguation",
      expectRelationship: { toName: "Jill", label: "wife" },
    }),
    utt(S1, 3, {
      speaker: "bob",
      cluster: "cl-bob",
      profileBound: false,
      text: "Hey there, I'm Bob.",
      category: "creation",
      expectCreates: "Bob",
    }),
    utt(S1, 4, {
      speaker: "jill",
      cluster: "cl-jill",
      profileBound: true,
      text: "Can you set a reminder for dinner at seven?",
      category: "recognition",
      expectBindsTo: "jill",
    }),
    utt(S1, 5, {
      speaker: "bob",
      cluster: "cl-bob",
      profileBound: true,
      text: "What is the weather looking like tomorrow?",
      category: "recognition",
      expectBindsTo: "bob",
    }),
    utt(S1, 6, {
      speaker: "owner",
      cluster: "cl-owner",
      profileBound: true,
      text: "Jill's birthday is on June twelfth.",
      category: "attribute",
      expectFact: { subject: "Jill", keywords: ["birthday", "june"] },
    }),
    utt(S1, 7, {
      speaker: "owner",
      cluster: "cl-owner",
      profileBound: true,
      text: "Bob works at Riverside Hospital.",
      category: "attribute",
      expectFact: { subject: "Bob", keywords: ["riverside", "hospital"] },
    }),
    utt(S1, 8, {
      speaker: "jill",
      cluster: "cl-jill-b",
      profileBound: false,
      text: "Hi, it's Jill again.",
      category: "recognition",
      expectBindsTo: "jill",
    }),
    utt(S1, 9, {
      speaker: "bob",
      cluster: "cl-bob",
      profileBound: true,
      text: "My birthday is in October, by the way.",
      category: "attribute",
      expectFact: { subject: "Bob", keywords: ["birthday", "october"] },
    }),
    utt(S1, 10, {
      speaker: "owner",
      cluster: "cl-owner",
      profileBound: true,
      text: "My anniversary with Jill is in September.",
      category: "attribute",
      expectFact: { subject: "Jill", keywords: ["anniversary", "september"] },
    }),
    utt(S1, 11, {
      speaker: "jill",
      cluster: "cl-jill",
      profileBound: true,
      text: "Bob is staying for dinner tonight.",
      category: "recognition",
      expectBindsTo: "jill",
    }),
    utt(S1, 12, {
      speaker: "bob",
      cluster: "cl-bob",
      profileBound: true,
      text: "Please turn off the porch light.",
      category: "recognition",
      expectBindsTo: "bob",
    }),
  ],
};

const S2 = "work";
const WORK: BenchSession = {
  id: S2,
  title: "Colleague introduction, employer + role attributes",
  speakers: ["owner", "maria_chen"],
  utterances: [
    utt(S2, 1, {
      speaker: "owner",
      cluster: "cl-owner",
      profileBound: true,
      text: "This is my colleague Maria Chen. She works at Acme Corporation.",
      category: "creation",
      expectCreates: "Maria Chen",
      expectRelationship: { toName: "Maria Chen", label: "colleague" },
      expectFact: { subject: "Maria", keywords: ["acme"] },
    }),
    utt(S2, 2, {
      speaker: "maria_chen",
      cluster: "cl-maria-chen",
      profileBound: false,
      text: "Hi, I'm Maria Chen. Nice to meet you.",
      category: "creation",
      expectCreates: "Maria Chen",
    }),
    utt(S2, 3, {
      speaker: "owner",
      cluster: "cl-owner",
      profileBound: true,
      text: "Maria's birthday is on March third.",
      category: "attribute",
      expectFact: { subject: "Maria", keywords: ["birthday", "march"] },
    }),
    utt(S2, 4, {
      speaker: "maria_chen",
      cluster: "cl-maria-chen",
      profileBound: true,
      text: "Could you schedule a design review for Thursday morning?",
      category: "recognition",
      expectBindsTo: "maria_chen",
    }),
    utt(S2, 5, {
      speaker: "owner",
      cluster: "cl-owner",
      profileBound: true,
      text: "Maria manages the platform team at Acme.",
      category: "attribute",
      expectFact: { subject: "Maria", keywords: ["platform", "team"] },
    }),
    utt(S2, 6, {
      speaker: "maria_chen",
      cluster: "cl-maria-chen",
      profileBound: true,
      text: "My extension at the office is four two seven.",
      category: "attribute",
      expectFact: { subject: "Maria", keywords: ["extension"] },
    }),
    utt(S2, 7, {
      speaker: "owner",
      cluster: "cl-owner",
      profileBound: true,
      text: "Maria Chen is my colleague.",
      category: "disambiguation",
      expectRelationship: { toName: "Maria Chen", label: "colleague" },
    }),
    utt(S2, 8, {
      speaker: "maria_chen",
      cluster: "cl-maria-chen-b",
      profileBound: false,
      text: "Hello, it's Maria Chen again.",
      category: "recognition",
      expectBindsTo: "maria_chen",
    }),
    utt(S2, 9, {
      speaker: "owner",
      cluster: "cl-owner",
      profileBound: true,
      text: "Doctor Patel is my dentist.",
      category: "creation",
      expectCreates: "Patel",
      expectRelationship: { toName: "Patel", label: "dentist" },
    }),
    utt(S2, 10, {
      speaker: "owner",
      cluster: "cl-owner",
      profileBound: true,
      text: "Doctor Patel's office is on Fifth Avenue.",
      category: "attribute",
      expectFact: { subject: "Patel", keywords: ["fifth avenue"] },
    }),
  ],
};

const S3 = "confusables";
const CONFUSABLES: BenchSession = {
  id: S3,
  title: "Maria / Mario / Marie must stay distinct",
  speakers: ["owner", "maria", "mario", "marie"],
  utterances: [
    utt(S3, 1, {
      speaker: "maria",
      cluster: "cl-maria",
      profileBound: false,
      text: "Hi, my name is Maria.",
      category: "creation",
      expectCreates: "Maria",
    }),
    utt(S3, 2, {
      speaker: "mario",
      cluster: "cl-mario",
      profileBound: false,
      text: "Hello, I'm Mario.",
      category: "creation",
      expectCreates: "Mario",
    }),
    utt(S3, 3, {
      speaker: "marie",
      cluster: "cl-marie",
      profileBound: false,
      text: "Hey, this is Marie.",
      category: "creation",
      expectCreates: "Marie",
    }),
    utt(S3, 4, {
      speaker: "owner",
      cluster: "cl-owner",
      profileBound: true,
      text: "Maria is my partner.",
      category: "disambiguation",
      expectRelationship: { toName: "Maria", label: "partner" },
    }),
    utt(S3, 5, {
      speaker: "mario",
      cluster: "cl-mario",
      profileBound: true,
      text: "Can you turn on the living room lights?",
      category: "recognition",
      expectBindsTo: "mario",
    }),
    utt(S3, 6, {
      speaker: "owner",
      cluster: "cl-owner",
      profileBound: true,
      text: "Mario's birthday is in March.",
      category: "attribute",
      expectFact: { subject: "Mario", keywords: ["birthday", "march"] },
    }),
    utt(S3, 7, {
      speaker: "marie",
      cluster: "cl-marie",
      profileBound: true,
      text: "Please add milk to the shopping list.",
      category: "recognition",
      expectBindsTo: "marie",
    }),
    utt(S3, 8, {
      speaker: "owner",
      cluster: "cl-owner",
      profileBound: true,
      text: "Marie works at the public library.",
      category: "attribute",
      expectFact: { subject: "Marie", keywords: ["library"] },
    }),
    utt(S3, 9, {
      speaker: "maria",
      cluster: "cl-maria",
      profileBound: true,
      text: "What time is my appointment tomorrow?",
      category: "recognition",
      expectBindsTo: "maria",
    }),
    utt(S3, 10, {
      speaker: "owner",
      cluster: "cl-owner",
      profileBound: true,
      text: "Mario is my brother.",
      category: "disambiguation",
      expectRelationship: { toName: "Mario", label: "brother" },
    }),
    utt(S3, 11, {
      speaker: "mario",
      cluster: "cl-mario-b",
      profileBound: false,
      text: "It's Mario again.",
      category: "disambiguation",
      expectBindsTo: "mario",
    }),
    utt(S3, 12, {
      speaker: "owner",
      cluster: "cl-owner",
      profileBound: true,
      text: "Marie is hosting book club on Wednesday.",
      category: "attribute",
      expectFact: { subject: "Marie", keywords: ["book club"] },
    }),
  ],
};

const S4 = "homophones";
const HOMOPHONES: BenchSession = {
  id: S4,
  title: "Erin / Aaron — same-sounding names through real ASR",
  speakers: ["owner", "erin", "aaron"],
  utterances: [
    utt(S4, 1, {
      speaker: "erin",
      cluster: "cl-erin",
      profileBound: false,
      text: "Hi, I'm Erin.",
      category: "creation",
      expectCreates: "Erin",
    }),
    utt(S4, 2, {
      speaker: "aaron",
      cluster: "cl-aaron",
      profileBound: false,
      text: "Hey there, I'm Aaron.",
      category: "creation",
      expectCreates: "Aaron",
    }),
    utt(S4, 3, {
      speaker: "owner",
      cluster: "cl-owner",
      profileBound: true,
      text: "Erin is my girlfriend.",
      category: "disambiguation",
      expectRelationship: { toName: "Erin", label: "girlfriend" },
    }),
    utt(S4, 4, {
      speaker: "erin",
      cluster: "cl-erin",
      profileBound: true,
      text: "Could you play some jazz music?",
      category: "recognition",
      expectBindsTo: "erin",
    }),
    utt(S4, 5, {
      speaker: "owner",
      cluster: "cl-owner",
      profileBound: true,
      text: "Aaron works at Basecamp Brewing.",
      category: "attribute",
      expectFact: { subject: "Aaron", keywords: ["brewing"] },
    }),
    utt(S4, 6, {
      speaker: "aaron",
      cluster: "cl-aaron",
      profileBound: true,
      text: "Set an alarm for six in the morning, please.",
      category: "recognition",
      expectBindsTo: "aaron",
    }),
    utt(S4, 7, {
      speaker: "owner",
      cluster: "cl-owner",
      profileBound: true,
      text: "Erin's sister is named Dana.",
      category: "attribute",
      expectFact: { subject: "Erin", keywords: ["sister", "dana"] },
    }),
    utt(S4, 8, {
      speaker: "erin",
      cluster: "cl-erin-b",
      profileBound: false,
      text: "It's Erin. Can you unlock the door?",
      category: "recognition",
      expectBindsTo: "erin",
    }),
  ],
};

export const SESSIONS: readonly BenchSession[] = [
  HOUSEHOLD,
  WORK,
  CONFUSABLES,
  HOMOPHONES,
] as const;

export function sessionById(id: string): BenchSession {
  const session = SESSIONS.find((s) => s.id === id);
  if (!session) throw new Error(`unknown session id: ${id}`);
  return session;
}

export function allUtterances(): BenchUtterance[] {
  return SESSIONS.flatMap((s) => s.utterances);
}
