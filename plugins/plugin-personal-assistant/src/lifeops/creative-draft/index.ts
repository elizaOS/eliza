/**
 * Creative drafting primitives for owner-voice writing workflows.
 *
 * The module turns transcribed voice memos and owner-authored exemplars into a
 * structured prompt contract, a style card, and an iterable draft artifact.
 * It deliberately keeps storage out of scope: work-thread/document surfaces can
 * persist the returned artifact without re-parsing prompt prose.
 */

import crypto from "node:crypto";

export const CREATIVE_DRAFT_INSTRUCTIONS = `Draft in the owner's voice from the supplied memos and style card.

Rules:
- Preserve each memo's argument and affect; when a memo has an affect directive, map that affect to the matching section instead of smoothing it away.
- Sound like the owner on a good day, not like a consultant.
- Revise the standing draft artifact when one is supplied; keep accepted edits and do not reintroduce vetoed phrasing.
- Return narrative text only unless the caller requested a structured outline.`;

export type CreativeMemoAffect =
  | "angry"
  | "urgent"
  | "tender"
  | "reflective"
  | "excited"
  | "neutral";

export interface CreativeMemoTranscript {
  readonly id: string;
  readonly transcript: string;
  readonly affect?: CreativeMemoAffect;
  readonly toneDirective?: string;
  readonly capturedAt?: string;
}

export interface OwnerVoiceSource {
  readonly id: string;
  readonly text: string;
  readonly source: "sent_mail" | "essay" | "thread" | "note";
}

export interface OwnerVoiceStyleCard {
  readonly sourceIds: readonly string[];
  readonly sentenceRhythm: "short" | "mixed" | "long";
  readonly averageSentenceWords: number;
  readonly stanceMarkers: readonly string[];
  readonly signaturePhrases: readonly string[];
  readonly avoidPhrases: readonly string[];
}

export interface CreativeDraftRequest {
  readonly title: string;
  readonly targetForm: "essay" | "launch_thread" | "narrative" | "memo";
  readonly ownerAsk: string;
  readonly requestedVoice?: string;
}

export interface CreativeDraftArtifact {
  readonly id: string;
  readonly title: string;
  readonly targetForm: CreativeDraftRequest["targetForm"];
  readonly sourceMemoIds: readonly string[];
  readonly styleSourceIds: readonly string[];
  readonly acceptedEdits: readonly string[];
  readonly vetoedPhrases: readonly string[];
  readonly sections: readonly CreativeDraftSection[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreativeDraftSection {
  readonly id: string;
  readonly heading: string;
  readonly memoId: string | null;
  readonly affect: CreativeMemoAffect;
  readonly directive: string;
  readonly text: string;
}

export interface CreativeDraftRevision {
  readonly instruction: string;
  readonly acceptedEdit?: string;
  readonly vetoedPhrase?: string;
  readonly replacementText?: string;
  readonly revisedAt: string;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function hashId(prefix: string, parts: readonly string[]): string {
  return `${prefix}_${crypto
    .createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 16)}`;
}

function sentences(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function words(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/\s+/u)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
}

function sentenceRhythm(
  averageSentenceWords: number,
): "short" | "mixed" | "long" {
  if (averageSentenceWords <= 11) return "short";
  if (averageSentenceWords >= 22) return "long";
  return "mixed";
}

function phraseCounts(texts: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const sourceWords = words(text.toLowerCase());
    for (let index = 0; index < sourceWords.length - 1; index += 1) {
      const phrase = `${sourceWords[index]} ${sourceWords[index + 1]}`;
      if (phrase.length < 7) continue;
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }
  return counts;
}

function extractSignaturePhrases(texts: readonly string[]): readonly string[] {
  return [...phraseCounts(texts).entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([phrase]) => phrase);
}

function extractStanceMarkers(texts: readonly string[]): readonly string[] {
  const combined = texts.join(" ").toLowerCase();
  const markers = [
    "I think",
    "I want",
    "I do not",
    "we should",
    "look",
    "because",
    "the point is",
    "what matters",
  ];
  return markers.filter((marker) =>
    new RegExp(
      `\\b${marker.toLowerCase().replaceAll(" ", "\\s+")}\\b`,
      "u",
    ).test(combined),
  );
}

export function buildOwnerVoiceStyleCard(
  sources: readonly OwnerVoiceSource[],
): OwnerVoiceStyleCard {
  const texts = sources.map((source) => normalizeWhitespace(source.text));
  const allSentences = texts.flatMap(sentences);
  const totalWords = allSentences.reduce(
    (sum, sentence) => sum + words(sentence).length,
    0,
  );
  const averageSentenceWords =
    allSentences.length > 0 ? Math.round(totalWords / allSentences.length) : 0;
  return {
    sourceIds: sources.map((source) => source.id),
    sentenceRhythm: sentenceRhythm(averageSentenceWords),
    averageSentenceWords,
    stanceMarkers: extractStanceMarkers(texts),
    signaturePhrases: extractSignaturePhrases(texts),
    avoidPhrases: [
      "unlock value",
      "leverage synergies",
      "best-in-class",
      "delve",
      "robust framework",
      "game changer",
    ],
  };
}

function sectionHeading(index: number, memo: CreativeMemoTranscript): string {
  const firstWords = words(memo.transcript).slice(0, 5).join(" ");
  return firstWords.length > 0 ? firstWords : `Memo ${index + 1}`;
}

export function createCreativeDraftArtifact(args: {
  request: CreativeDraftRequest;
  memos: readonly CreativeMemoTranscript[];
  styleCard: OwnerVoiceStyleCard;
  nowIso: string;
}): CreativeDraftArtifact {
  const sections = args.memos.map((memo, index) => ({
    id: hashId("section", [memo.id, memo.transcript]),
    heading: sectionHeading(index, memo),
    memoId: memo.id,
    affect: memo.affect ?? "neutral",
    directive:
      memo.toneDirective ??
      (memo.affect
        ? `Preserve ${memo.affect} affect here.`
        : "Preserve argument."),
    text: normalizeWhitespace(memo.transcript),
  }));
  return {
    id: hashId("creative_draft", [
      args.request.title,
      args.request.ownerAsk,
      ...args.memos.map((memo) => memo.id),
    ]),
    title: args.request.title,
    targetForm: args.request.targetForm,
    sourceMemoIds: args.memos.map((memo) => memo.id),
    styleSourceIds: args.styleCard.sourceIds,
    acceptedEdits: [],
    vetoedPhrases: [],
    sections,
    createdAt: args.nowIso,
    updatedAt: args.nowIso,
  };
}

export function applyCreativeDraftRevision(
  draft: CreativeDraftArtifact,
  revision: CreativeDraftRevision,
): CreativeDraftArtifact {
  const acceptedEdits = revision.acceptedEdit
    ? [...draft.acceptedEdits, revision.acceptedEdit]
    : [...draft.acceptedEdits];
  const vetoedPhrases = revision.vetoedPhrase
    ? [...draft.vetoedPhrases, revision.vetoedPhrase]
    : [...draft.vetoedPhrases];
  const replacementText = revision.replacementText
    ? normalizeWhitespace(revision.replacementText)
    : null;
  return {
    ...draft,
    acceptedEdits,
    vetoedPhrases,
    sections: replacementText
      ? draft.sections.map((section, index) =>
          index === 0 ? { ...section, text: replacementText } : section,
        )
      : draft.sections,
    updatedAt: revision.revisedAt,
  };
}

export function buildCreativeDraftPrompt(args: {
  request: CreativeDraftRequest;
  memos: readonly CreativeMemoTranscript[];
  styleCard: OwnerVoiceStyleCard;
  currentDraft?: CreativeDraftArtifact;
}): string {
  const payload = JSON.stringify(
    {
      task: "creative_draft",
      request: args.request,
      memos: args.memos,
      styleCard: args.styleCard,
      currentDraft: args.currentDraft ?? null,
    },
    null,
    2,
  );
  return `${CREATIVE_DRAFT_INSTRUCTIONS}

Data:
${payload}`;
}

export function scoreOwnerVoiceFidelity(
  candidate: string,
  styleCard: OwnerVoiceStyleCard,
): number {
  const normalized = candidate.toLowerCase();
  const markerHits = styleCard.stanceMarkers.filter((marker) =>
    normalized.includes(marker.toLowerCase()),
  ).length;
  const phraseHits = styleCard.signaturePhrases.filter((phrase) =>
    normalized.includes(phrase.toLowerCase()),
  ).length;
  const genericPenalty = styleCard.avoidPhrases.filter((phrase) =>
    normalized.includes(phrase),
  ).length;
  const sentenceLengths = sentences(candidate).map(
    (sentence) => words(sentence).length,
  );
  const average =
    sentenceLengths.length > 0
      ? sentenceLengths.reduce((sum, length) => sum + length, 0) /
        sentenceLengths.length
      : 0;
  const rhythmHit =
    sentenceRhythm(Math.round(average)) === styleCard.sentenceRhythm ? 1 : 0;
  const raw = markerHits * 2 + phraseHits * 3 + rhythmHit - genericPenalty * 2;
  return Math.max(0, Math.min(1, raw / 10));
}
