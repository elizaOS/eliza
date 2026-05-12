/**
 * @fileoverview escalation rubric.
 *
 * Expected `personalityExpect.options`:
 *  - `direction: "warmer" | "cooler" | "terser" | "looser" | "playful"`
 *  - `requireStrictMonotonic?: boolean` — when true, each step must move; when
 *    false (default), only the net delta across the first/last checked turn
 *    must move in the right direction.
 *
 * P1-12: For the `cooler` direction the rubric now computes a `coolnessScore`
 * (0.0–1.0) that measures HOW MUCH cooler the response became by detecting
 * warmth signals that disappeared between the first and last checked turn.
 * The PASS threshold is ≥ 0.5. This replaces the pure pass/fail that relied
 * only on the negated warmthScore delta, which was insufficiently sensitive
 * when warmth started at zero.
 */

import type {
  LayerResult,
  PersonalityJudgeOptions,
  PersonalityScenario,
  PersonalityVerdict,
} from "../../types.ts";
import { judgeWithLlm } from "../checks/llm-judge.ts";
import { playfulScore, tokenCount, warmthScore } from "../checks/phrase.ts";
import { combineVerdict } from "../verdict.ts";

/**
 * Measure how much cooler a response became relative to a baseline.
 *
 * Detects warmth signals in the PREVIOUS response that are ABSENT in the
 * CURRENT response. Each dropped signal contributes +0.25 (capped at 1.0).
 *
 * Signals detected:
 *  1. Exclamation marks (one or more)
 *  2. Informal contractions ("I'd", "you're", "it's", "I'll", etc.)
 *  3. Casual interjections ("hey", "great", "awesome", "nice", "wow")
 *  4. Emoji characters
 */
export function coolnessScore(prev: string, curr: string): number {
  const CONTRACTION_RE = /\b(?:I'd|I'm|I'll|I've|you're|you've|you'll|you'd|it's|that's|there's|here's|can't|won't|don't|isn't|aren't|let's)\b/i;
  const INTERJECTION_RE = /\b(?:hey|great|awesome|nice|wow|cool|absolutely|totally|sure thing|sounds good)\b/i;
  const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}]/u;
  const EXCLAMATION_RE = /!/;

  let score = 0;

  // +0.25 each for signals present in prev but absent in curr.
  if (EXCLAMATION_RE.test(prev) && !EXCLAMATION_RE.test(curr)) score += 0.25;
  if (CONTRACTION_RE.test(prev) && !CONTRACTION_RE.test(curr)) score += 0.25;
  if (INTERJECTION_RE.test(prev) && !INTERJECTION_RE.test(curr)) score += 0.25;
  if (EMOJI_RE.test(prev) && !EMOJI_RE.test(curr)) score += 0.25;

  return Math.min(score, 1.0);
}

type Direction = "warmer" | "cooler" | "terser" | "looser" | "playful";

interface EscalationOptions {
  direction: Direction;
  requireStrictMonotonic: boolean;
}

function readOptions(scenario: PersonalityScenario): EscalationOptions {
  const opts = (scenario.personalityExpect.options ?? {}) as Record<
    string,
    unknown
  >;
  return {
    direction: (opts.direction as Direction) ?? "warmer",
    requireStrictMonotonic: Boolean(opts.requireStrictMonotonic),
  };
}

function scoreFor(direction: Direction, text: string): number {
  switch (direction) {
    case "warmer":
    case "cooler":
      return warmthScore(text);
    case "terser":
    case "looser":
      return tokenCount(text);
    case "playful":
      return playfulScore(text);
    default:
      return 0;
  }
}

function expectedSign(direction: Direction): 1 | -1 {
  switch (direction) {
    case "warmer":
    case "looser":
    case "playful":
      return 1;
    case "cooler":
    case "terser":
      return -1;
    default:
      return 1;
  }
}

export async function gradeEscalationDelta(
  scenario: PersonalityScenario,
  options: PersonalityJudgeOptions,
): Promise<PersonalityVerdict> {
  const { direction, requireStrictMonotonic } = readOptions(scenario);
  const checkTurns = scenario.personalityExpect.checkTurns ?? [];
  const layers: LayerResult[] = [];

  if (checkTurns.length < 2) {
    return combineVerdict(
      scenario,
      [
        {
          layer: "trajectory",
          verdict: "NEEDS_REVIEW",
          confidence: 0.5,
          reason: "escalation rubric needs ≥ 2 checkTurns",
        },
      ],
      options.strict,
    );
  }

  const responses: { turn: number; score: number; text: string }[] = [];
  for (const t of checkTurns) {
    const turn = scenario.trajectory[t - 1];
    if (!turn || turn.role !== "assistant") {
      layers.push({
        layer: "trajectory",
        verdict: "NEEDS_REVIEW",
        confidence: 0.5,
        reason: `turn ${t} missing or not assistant`,
      });
      continue;
    }
    responses.push({
      turn: t,
      score: scoreFor(direction, turn.content),
      text: turn.content,
    });
  }

  if (responses.length >= 2) {
    const sign = expectedSign(direction);
    const first = responses[0];
    const last = responses[responses.length - 1];
    if (!first || !last) {
      layers.push({
        layer: "trajectory",
        verdict: "NEEDS_REVIEW",
        confidence: 0.5,
        reason: "could not extract first/last escalation response",
      });
    } else {
      const netDelta = (last.score - first.score) * sign;
      if (netDelta > 0) {
        layers.push({
          layer: "trajectory",
          verdict: "PASS",
          confidence: 0.85,
          reason: `net ${direction} delta = ${netDelta.toFixed(2)} (${first.score.toFixed(2)} → ${last.score.toFixed(2)})`,
          evidence: {
            responses: responses.map((r) => ({ turn: r.turn, score: r.score })),
          },
        });
      } else if (netDelta === 0) {
        // Zero movement when the user explicitly asked for sequential
        // change is a fail. Confidence is moderate (0.9) — strong enough
        // to dominate the verdict but allows a high-confidence LLM
        // disagreement to escalate to NEEDS_REVIEW.
        layers.push({
          layer: "trajectory",
          verdict: "FAIL",
          confidence: 0.9,
          reason: `no movement across escalation (${first.score.toFixed(2)} → ${last.score.toFixed(2)})`,
        });
      } else {
        layers.push({
          layer: "trajectory",
          verdict: "FAIL",
          confidence: 0.9,
          reason: `escalation went the wrong way: ${first.score.toFixed(2)} → ${last.score.toFixed(2)}`,
        });
      }

      // P1-12: for the `cooler` direction, add a `coolnessScore` sub-layer
      // that quantifies HOW MUCH cooler the response became by counting warmth
      // signals (exclamation marks, informal contractions, casual interjections,
      // emoji) that were present in the first checked turn but absent in the
      // last. Score ≥ 0.5 = PASS; < 0.5 but > 0 = NEEDS_REVIEW; 0 = FAIL.
      // This fires even when netDelta is 0 so warmth-signal dropout can rescue
      // scenarios where warmthScore started at zero (no politeness markers).
      if (direction === "cooler") {
        const cs = coolnessScore(first.text, last.text);
        if (cs >= 0.5) {
          layers.push({
            layer: "trajectory",
            verdict: "PASS",
            confidence: 0.8,
            reason: `coolnessScore = ${cs.toFixed(2)} ≥ 0.5 (warmth signals dropped between turn ${first.turn} and ${last.turn})`,
            evidence: {
              coolnessScore: cs,
              firstTurn: first.turn,
              lastTurn: last.turn,
            },
          });
        } else if (cs > 0) {
          layers.push({
            layer: "trajectory",
            verdict: "NEEDS_REVIEW",
            confidence: 0.5,
            reason: `coolnessScore = ${cs.toFixed(2)} < 0.5 (partial warmth-signal dropout; ambiguous)`,
            evidence: {
              coolnessScore: cs,
              firstTurn: first.turn,
              lastTurn: last.turn,
            },
          });
        } else {
          layers.push({
            layer: "trajectory",
            verdict: "FAIL",
            confidence: 0.75,
            reason: `coolnessScore = 0 (no warmth signals dropped between turn ${first.turn} and ${last.turn})`,
            evidence: {
              coolnessScore: cs,
              firstTurn: first.turn,
              lastTurn: last.turn,
            },
          });
        }
      }

      if (requireStrictMonotonic) {
        for (let i = 1; i < responses.length; i++) {
          const a = responses[i - 1];
          const b = responses[i];
          if (!a || !b) continue;
          const step = (b.score - a.score) * sign;
          if (step <= 0) {
            layers.push({
              layer: "trajectory",
              verdict: "FAIL",
              confidence: 0.9,
              reason: `step turn ${a.turn} → ${b.turn} did not move ${direction}`,
            });
            break;
          }
        }
      }
    }
  }

  if (options.enableLlm) {
    const transcript = scenario.trajectory
      .map((t, i) => `[${i + 1}][${t.role}] ${t.content}`)
      .join("\n");
    const llmLayer = await judgeWithLlm(options.llm, {
      question: `Across the checked assistant turns, did each response move ${direction} compared to the previous one?`,
      systemHint:
        "Escalation rubrics test sequential change. Identical responses or movement in the wrong direction is a fail.",
      evidence: {
        transcript,
        direction,
        checkTurns: checkTurns.join(","),
      },
    });
    layers.push(llmLayer);
  }

  return combineVerdict(scenario, layers, options.strict);
}
