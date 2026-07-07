/**
 * Creative drafting primitives for owner-voice writing workflows.
 *
 * The module turns transcribed voice memos and owner-authored exemplars into a
 * structured prompt contract, a style card, and an iterable draft artifact.
 * It deliberately keeps storage out of scope: work-thread/document surfaces can
 * persist the returned artifact without re-parsing prompt prose.
 *
 * The drafting instructions are a GEPA optimization target: buildCreativeDraftPrompt
 * sources them through OptimizedPromptService for the `creative_draft` task
 * (CREATIVE_DRAFT_INSTRUCTIONS is the baseline) rather than hardcoding the raw
 * string. The CREATIVE_DRAFT action (src/actions/creative-draft.ts) is the real
 * consumer that wires a runtime into this producer.
 */

import crypto from "node:crypto";
import {
  type OptimizedPromptRuntimeLike,
  type OptimizedPromptTask,
  resolveOptimizedPromptForRuntime,
} from "@elizaos/core";

/**
 * OptimizedPromptService task id for owner-voice drafting. The inline
 * {@link CREATIVE_DRAFT_INSTRUCTIONS} is the GEPA optimization baseline;
 * {@link buildCreativeDraftPrompt} substitutes an optimized artifact through
 * this task when one is loaded, so an absent artifact is a no-op.
 */
export const CREATIVE_DRAFT_OPTIMIZATION_TASK: OptimizedPromptTask =
  "creative_draft";

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
  /**
   * Which section {@link replacementText} rewrites. `sectionId` (the stable
   * hashed section id) wins when both are given; `sectionIndex` is the
   * positional fallback. Unspecified means the first section — the common case
   * of a single-section draft — but a memo maps to each section, so a revision
   * that only ever edited section 0 could not honor the owner's "keep the anger
   * in the second section" directive.
   */
  readonly sectionId?: string;
  readonly sectionIndex?: number;
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
  const targetIndex = resolveRevisionSectionIndex(draft.sections, revision);
  if (replacementText && targetIndex === null) {
    throw new Error(
      `[creative-draft] revision targets an unknown section (sectionId=${
        revision.sectionId ?? "<none>"
      }, sectionIndex=${revision.sectionIndex ?? "<none>"})`,
    );
  }
  return {
    ...draft,
    acceptedEdits,
    vetoedPhrases,
    sections:
      replacementText && targetIndex !== null
        ? draft.sections.map((section, index) =>
            index === targetIndex
              ? { ...section, text: replacementText }
              : section,
          )
        : draft.sections,
    updatedAt: revision.revisedAt,
  };
}

/**
 * Resolve which section a revision edits. `sectionId` (stable hashed id) wins
 * over the positional `sectionIndex`; when neither is set, default to the
 * first section. Returns `null` for an out-of-range index or an unknown
 * `sectionId` so the caller can reject the revision rather than silently
 * rewriting the wrong section.
 */
function resolveRevisionSectionIndex(
  sections: readonly CreativeDraftSection[],
  revision: CreativeDraftRevision,
): number | null {
  if (revision.sectionId !== undefined) {
    const byId = sections.findIndex(
      (section) => section.id === revision.sectionId,
    );
    return byId >= 0 ? byId : null;
  }
  if (revision.sectionIndex !== undefined) {
    return revision.sectionIndex >= 0 && revision.sectionIndex < sections.length
      ? revision.sectionIndex
      : null;
  }
  return sections.length > 0 ? 0 : null;
}

export function buildCreativeDraftPrompt(args: {
  request: CreativeDraftRequest;
  memos: readonly CreativeMemoTranscript[];
  styleCard: OwnerVoiceStyleCard;
  currentDraft?: CreativeDraftArtifact;
  /**
   * When supplied, the drafting instructions are sourced through
   * OptimizedPromptService for the `creative_draft` task; the inline
   * {@link CREATIVE_DRAFT_INSTRUCTIONS} is the baseline used when no artifact
   * is loaded. Omit it (e.g. in unit tests) to always use the baseline.
   */
  runtime?: OptimizedPromptRuntimeLike;
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
  const instructions = args.runtime
    ? resolveOptimizedPromptForRuntime(
        args.runtime,
        CREATIVE_DRAFT_OPTIMIZATION_TASK,
        CREATIVE_DRAFT_INSTRUCTIONS,
      )
    : CREATIVE_DRAFT_INSTRUCTIONS;
  return `${instructions}

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
