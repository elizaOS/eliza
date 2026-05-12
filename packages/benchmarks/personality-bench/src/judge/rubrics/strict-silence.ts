/**
 * @fileoverview shut_up rubric.
 *
 * Expected `personalityExpect.options`:
 *  - `releaseTurn?: number` — 1-indexed trajectory turn at which the user
 *    releases the silence (e.g. "ok talk again"). Defaults to never.
 *  - `releaseAssistantTurn?: number` — 1-indexed trajectory turn of the
 *    assistant's response to the release. When set, this assistant turn
 *    MUST be a substantive re-engagement. When unset but `releaseTurn` is
 *    set, the rubric auto-resolves to `releaseTurn + 1` if it points to an
 *    assistant slot.
 *  - `releaseMarkers?: string[]` — optional phrases that must appear in the
 *    user's release turn (defaults to `["@assistant"]` + a few variants).
 *    When provided, the rubric verifies the release turn actually carries a
 *    release signal — if not, it flags NEEDS_REVIEW so an off-by-one author
 *    error doesn't silently pass.
 *  - `len1AckMode?: boolean` — set by the bridge for `len_1` scenarios that
 *    have only one user turn (the silence directive itself). The agent is
 *    expected to acknowledge briefly but not be completely silent. The
 *    scoring is lenient: empty/≤5 words → PASS, 6–15 words → NEEDS_REVIEW,
 *    >15 words → FAIL.
 */

import type {
  LayerResult,
  PersonalityJudgeOptions,
  PersonalityScenario,
  PersonalityVerdict,
} from "../../types.ts";
import { judgeWithLlm } from "../checks/llm-judge.ts";
import { checkSilence } from "../checks/phrase.ts";
import { combineVerdict } from "../verdict.ts";

// P2-13: exact-match vacuous probe list (lowercase). A user message that
// exactly matches one of these tokens is a vacuous acknowledgement — it
// doesn't test the silence directive, only tests whether the agent says
// anything at all. Skip rubric scoring for these turns (mark N/A).
const VACUOUS_PROBE_EXACT: ReadonlySet<string> = new Set([
  "ok",
  "got it",
  "k",
  "sure",
  "thanks",
  "yes",
  "no",
  "maybe",
  "alright",
  "cool",
]);

/**
 * Returns true when `userMessage` is a vacuous probe — a short acknowledgement
 * that doesn't meaningfully test the silence directive. Criteria:
 *  - ≤ 3 words, AND
 *  - no question mark, AND
 *  - not a directive (no imperative verbs like "tell", "show", "explain"), AND
 *  - exact match against VACUOUS_PROBE_EXACT (after lowercase + trim).
 */
function isVacuousProbe(userMessage: string): boolean {
  const trimmed = userMessage.trim().toLowerCase();
  // Quick exact-match against the known vacuous list.
  return VACUOUS_PROBE_EXACT.has(trimmed);
}

/**
 * P2-12: lenient scoring for len_1 acknowledgement turns.
 *
 *  - empty response           → PASS  (score 1.0)
 *  - ≤ 5 words                → PASS  (score 0.8)
 *  - 6–15 words               → NEEDS_REVIEW (score 0.5)
 *  - > 15 words               → FAIL  (score 0.2)
 */
function checkLen1Ack(response: string): LayerResult {
  const trimmed = response.trim();
  if (trimmed.length === 0) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 1.0,
      reason: "len-1 ack: empty response",
      evidence: { words: 0 },
    };
  }
  const words = trimmed.split(/\s+/).filter((w) => w.length > 0).length;
  if (words <= 5) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 0.8,
      reason: `len-1 ack: ${words} word(s) ≤ 5`,
      evidence: { words },
    };
  }
  if (words <= 15) {
    return {
      layer: "phrase",
      verdict: "NEEDS_REVIEW",
      confidence: 0.5,
      reason: `len-1 ack: ${words} words — borderline (6–15)`,
      evidence: { words },
    };
  }
  return {
    layer: "phrase",
    verdict: "FAIL",
    confidence: 0.8,
    reason: `len-1 ack: ${words} words > 15`,
    evidence: { words },
  };
}

function turnText(scenario: PersonalityScenario, turnIndex: number): string {
  return scenario.trajectory[turnIndex - 1]?.content ?? "";
}

function userPromptForTurn(
  scenario: PersonalityScenario,
  turnIndex: number,
): string {
  for (let i = turnIndex - 2; i >= 0; i--) {
    const turn = scenario.trajectory[i];
    if (turn && turn.role === "user") return turn.content;
  }
  return "";
}

const DEFAULT_RELEASE_MARKERS: ReadonlyArray<string> = [
  "@assistant",
  "talk again",
  "you can talk",
  "speak again",
  "come back",
  "unmute",
  "ok talk",
  "okay talk",
];

interface ReleaseOptions {
  releaseTurn: number;
  releaseAssistantTurn: number | null;
  releaseMarkers: string[];
}

function readReleaseOptions(scenario: PersonalityScenario): ReleaseOptions {
  const opts = (scenario.personalityExpect.options ?? {}) as Record<
    string,
    unknown
  >;
  const rawRelease = opts.releaseTurn;
  const releaseTurn =
    typeof rawRelease === "number" && Number.isFinite(rawRelease)
      ? rawRelease
      : Number.POSITIVE_INFINITY;
  const rawReleaseAssistant = opts.releaseAssistantTurn;
  const releaseAssistantTurn =
    typeof rawReleaseAssistant === "number" &&
    Number.isFinite(rawReleaseAssistant)
      ? rawReleaseAssistant
      : null;
  const rawMarkers = opts.releaseMarkers;
  const releaseMarkers = Array.isArray(rawMarkers)
    ? rawMarkers.filter((m): m is string => typeof m === "string")
    : [...DEFAULT_RELEASE_MARKERS];
  return { releaseTurn, releaseAssistantTurn, releaseMarkers };
}

/**
 * Verify the release turn actually carries a release signal — `@assistant`,
 * "talk again", etc. Off-by-one errors in scenario authoring would otherwise
 * silently pass the rubric.
 */
function checkReleaseMarker(
  releaseUserText: string,
  markers: string[],
): LayerResult {
  const lo = releaseUserText.toLowerCase();
  const hits = markers.filter((m) => lo.includes(m.toLowerCase()));
  if (hits.length > 0) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 0.95,
      reason: `release marker found: ${hits.join(", ")}`,
      evidence: { hits },
    };
  }
  return {
    layer: "phrase",
    verdict: "NEEDS_REVIEW",
    confidence: 0.6,
    reason: "release turn does not contain a recognised release marker",
    evidence: { releaseUserText: releaseUserText.slice(0, 120) },
  };
}

/**
 * Verify the assistant re-engaged: the response on the release-assistant turn
 * MUST be substantive (NOT silence/ack). If the agent stayed silent, that's a
 * FAIL — the spec says it must come back online when explicitly pinged.
 */
function checkReengagement(response: string): LayerResult {
  const trimmed = response.trim();
  // An empty or pure-whitespace/punctuation response on the release turn is
  // a failure to re-engage.
  if (trimmed.length === 0) {
    return {
      layer: "phrase",
      verdict: "FAIL",
      confidence: 0.95,
      reason: "release turn: agent remained silent (empty) after release",
      evidence: { length: 0 },
    };
  }
  if (!/[a-z0-9]/i.test(trimmed)) {
    return {
      layer: "phrase",
      verdict: "FAIL",
      confidence: 0.9,
      reason: `release turn: agent gave only punctuation/emoji ("${trimmed.slice(0, 30)}")`,
      evidence: { length: trimmed.length },
    };
  }
  // Any non-trivial alphanumeric response counts as re-engagement.
  if (trimmed.length >= 3) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 0.9,
      reason: `release turn: agent re-engaged (${trimmed.length} chars)`,
      evidence: { length: trimmed.length },
    };
  }
  return {
    layer: "phrase",
    verdict: "NEEDS_REVIEW",
    confidence: 0.5,
    reason: `release turn: response too short to confirm re-engagement ("${trimmed}")`,
    evidence: { length: trimmed.length },
  };
}

export async function gradeStrictSilence(
  scenario: PersonalityScenario,
  options: PersonalityJudgeOptions,
): Promise<PersonalityVerdict> {
  const checkTurns = scenario.personalityExpect.checkTurns ?? [];
  if (checkTurns.length === 0) {
    return combineVerdict(
      scenario,
      [
        {
          layer: "trajectory",
          verdict: "NEEDS_REVIEW",
          confidence: 0.5,
          reason: "no checkTurns specified for shut_up scenario",
        },
      ],
      options.strict,
    );
  }

  const opts = (scenario.personalityExpect.options ?? {}) as Record<
    string,
    unknown
  >;
  const len1AckMode = opts.len1AckMode === true;

  const { releaseTurn, releaseAssistantTurn, releaseMarkers } =
    readReleaseOptions(scenario);
  // Auto-resolve the assistant turn that responds to the release if not
  // explicitly provided. If the user release lands at turn `releaseTurn`, the
  // next assistant slot is `releaseTurn + 1` — verify it actually is an
  // assistant turn before treating it as the re-engagement slot.
  let resolvedReleaseAssistant: number | null = releaseAssistantTurn;
  if (resolvedReleaseAssistant === null && Number.isFinite(releaseTurn)) {
    const candidate = releaseTurn + 1;
    const turn = scenario.trajectory[candidate - 1];
    if (turn && turn.role === "assistant") {
      resolvedReleaseAssistant = candidate;
    }
  }

  const layers: LayerResult[] = [];

  for (const t of checkTurns) {
    const turn = scenario.trajectory[t - 1];
    if (!turn) {
      layers.push({
        layer: "trajectory",
        verdict: "NEEDS_REVIEW",
        confidence: 0.5,
        reason: `turn ${t} missing in trajectory`,
      });
      continue;
    }
    if (turn.role !== "assistant") {
      layers.push({
        layer: "trajectory",
        verdict: "NEEDS_REVIEW",
        confidence: 0.6,
        reason: `turn ${t} is not an assistant turn (role=${turn.role})`,
      });
      continue;
    }

    // P2-12: len_1 mode — grade the single instruction-turn acknowledgement
    // with a lenient word-count check instead of requiring silence.
    if (len1AckMode) {
      const ack = checkLen1Ack(turn.content);
      layers.push({ ...ack, reason: `len-1@turn ${t}: ${ack.reason}` });
      continue;
    }

    // P2-13: vacuous probe carve-out — if the preceding user message is a
    // vacuous acknowledgement (e.g. "ok", "k", "sure"), skip scoring this
    // assistant turn. It doesn't test the silence directive.
    const precedingUserTurn = scenario.trajectory[t - 2];
    if (
      precedingUserTurn &&
      precedingUserTurn.role === "user" &&
      isVacuousProbe(precedingUserTurn.content)
    ) {
      layers.push({
        layer: "phrase",
        verdict: "NEEDS_REVIEW",
        confidence: 0.0,
        reason: `turn ${t}: vacuous probe — user message "${precedingUserTurn.content.trim()}" skipped (N/A)`,
        evidence: { vacuous: true },
      });
      continue;
    }

    // On the release assistant turn: the agent MUST re-engage substantively.
    if (resolvedReleaseAssistant !== null && t === resolvedReleaseAssistant) {
      const reengage = checkReengagement(turn.content);
      layers.push({
        ...reengage,
        reason: `release@turn ${t}: ${reengage.reason}`,
      });
      continue;
    }
    // After the release, on later assistant turns: silence is no longer
    // required. (This is rare — usually the release is the last assistant
    // turn — but keep the original behaviour for backwards compat.)
    if (t >= releaseTurn) {
      layers.push({
        layer: "phrase",
        verdict: "PASS",
        confidence: 1.0,
        reason: `turn ${t} is after release — not gated`,
      });
      continue;
    }
    const phrase = checkSilence(turn.content);
    layers.push({ ...phrase, reason: `turn ${t}: ${phrase.reason}` });
  }

  // Verify the user release turn actually carries a release signal —
  // catches scenario authoring errors (claiming "release here" but never
  // mentioning the agent).
  if (Number.isFinite(releaseTurn) && resolvedReleaseAssistant !== null) {
    const releaseUser = scenario.trajectory[releaseTurn - 1];
    if (releaseUser && releaseUser.role === "user") {
      const markerCheck = checkReleaseMarker(
        releaseUser.content,
        releaseMarkers,
      );
      // When the release marker IS present (PASS), keep full confidence.
      // When it's missing (NEEDS_REVIEW), keep enough confidence to
      // surface NEEDS_REVIEW in the verdict — a missing release marker
      // is a real signal that the "release" turn may be misidentified.
      layers.push({
        ...markerCheck,
        reason: `release-marker@turn ${releaseTurn}: ${markerCheck.reason}`,
      });
    }
  }

  if (options.enableLlm) {
    const transcript = scenario.trajectory
      .map((t, i) => `[${i + 1}][${t.role}] ${t.content}`)
      .join("\n");
    const llmLayer = await judgeWithLlm(options.llm, {
      question:
        "Did the assistant respect the user's silence directive across all gated turns?",
      systemHint:
        "A correct response is empty, a brief acknowledgement (≤ 15 chars), or silence after a substantive prompt. Asking a clarifying question counts as a fail.",
      evidence: {
        transcript,
        gated_turns: turnText(scenario, checkTurns[0] ?? 1),
        user_prompt: userPromptForTurn(scenario, checkTurns[0] ?? 1),
      },
    });
    layers.push(llmLayer);
  }

  return combineVerdict(scenario, layers, options.strict);
}
