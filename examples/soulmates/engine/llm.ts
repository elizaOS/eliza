import type {
  DomainMode,
  LargePassInput,
  LargePassResult,
  LlmProvider,
  Persona,
  SmallPassInput,
  SmallPassResult,
} from "./types";
import { clampInt } from "./utils";

interface MatchFactors {
  interestOverlap: number;
  availabilityFit: number;
  reliabilityScore: number;
  sentimentScore: number;
  dealbreakersHit: number;
  redFlagsCount: number;
  domainSpecificScore: number;
}

const extractMatchFactors = (
  persona: Persona,
  candidate: Persona,
  domain: DomainMode,
): MatchFactors => {
  const personaInterests = new Set(persona.profile.interests);
  const candidateInterests = new Set(candidate.profile.interests);
  const intersection = Array.from(personaInterests).filter((i) =>
    candidateInterests.has(i),
  );
  const union = new Set([...personaInterests, ...candidateInterests]);
  const interestOverlap = union.size > 0 ? intersection.length / union.size : 0;

  const availabilityFit =
    persona.profile.availability.timeZone ===
    candidate.profile.availability.timeZone
      ? 0.8
      : 0.3;
  const reliabilityScore =
    (persona.reliability.score + candidate.reliability.score) / 2;
  const sentimentScore = candidate.profile.feedbackSummary.sentimentScore;
  const dealbreakersHit = 0;
  const redFlagsCount = candidate.profile.feedbackSummary.redFlagTags.length;

  let domainSpecificScore = 0.5;
  if (domain === "dating" && candidate.domainProfiles.dating) {
    domainSpecificScore =
      candidate.domainProfiles.dating.attractionProfile.appearance
        .attractiveness / 10;
  } else if (domain === "business" && candidate.domainProfiles.business) {
    domainSpecificScore = 0.7;
  } else if (domain === "friendship" && candidate.domainProfiles.friendship) {
    domainSpecificScore = interestOverlap > 0.3 ? 0.8 : 0.4;
  }

  return {
    interestOverlap,
    availabilityFit,
    reliabilityScore,
    sentimentScore,
    dealbreakersHit,
    redFlagsCount,
    domainSpecificScore,
  };
};

const generateMatchReasoning = (
  factors: MatchFactors,
  positive: boolean,
): string[] => {
  const reasons: string[] = [];

  if (positive) {
    if (factors.interestOverlap > 0.4) {
      reasons.push(
        `Strong interest overlap (${Math.round(factors.interestOverlap * 100)}%)`,
      );
    }
    if (factors.reliabilityScore > 0.7) reasons.push("High reliability score");
    if (factors.sentimentScore > 0.6)
      reasons.push("Positive community feedback");
    if (factors.domainSpecificScore > 0.6)
      reasons.push("Strong domain compatibility");
    if (factors.availabilityFit > 0.7) reasons.push("Compatible schedules");
  } else {
    if (factors.interestOverlap < 0.2) {
      reasons.push(
        `Limited shared interests (${Math.round(factors.interestOverlap * 100)}%)`,
      );
    }
    if (factors.reliabilityScore < 0.5)
      reasons.push("Below-average reliability");
    if (factors.sentimentScore < 0.4)
      reasons.push("Concerning feedback patterns");
    if (factors.redFlagsCount > 2)
      reasons.push(`Multiple red flags (${factors.redFlagsCount})`);
    if (factors.availabilityFit < 0.5)
      reasons.push("Schedule compatibility issues");
    if (factors.dealbreakersHit > 0)
      reasons.push("Dealbreaker criteria not met");
  }

  return reasons.length > 0 ? reasons : ["General compatibility assessment"];
};

export class HeuristicLlmProvider implements LlmProvider {
  async smallPass(input: SmallPassInput): Promise<SmallPassResult> {
    const scored = input.candidates.map((candidate) => {
      const factors = extractMatchFactors(
        input.persona,
        candidate,
        input.domain,
      );

      let score = 0;
      score += factors.interestOverlap * 25;
      score += factors.availabilityFit * 15;
      score += factors.reliabilityScore * 20;
      score += factors.sentimentScore * 15;
      score += factors.domainSpecificScore * 25;
      score -= factors.dealbreakersHit * 50;
      score -= factors.redFlagsCount * 10;

      return { id: candidate.id, score: clampInt(score, 0, 100) };
    });

    scored.sort((a, b) => b.score - a.score);
    return {
      rankedIds: scored.map((s) => s.id),
      notes: input.notes || "Heuristic-based ranking",
    };
  }

  async largePass(input: LargePassInput): Promise<LargePassResult> {
    const factors = extractMatchFactors(
      input.persona,
      input.candidate,
      input.domain,
    );

    let score = 0;
    score += factors.interestOverlap * 22;
    score += factors.availabilityFit * 18;
    score += factors.reliabilityScore * 20;
    score += factors.sentimentScore * 15;
    score += factors.domainSpecificScore * 25;
    score -= factors.dealbreakersHit * 60;
    score -= factors.redFlagsCount * 12;

    const harshnessPenalty = Math.max(0, (100 - score) * 0.15);
    score -= harshnessPenalty;

    const finalScore = clampInt(score, -100, 100);
    const positiveReasons = generateMatchReasoning(factors, true);
    const negativeReasons = generateMatchReasoning(factors, false);
    const redFlags = input.candidate.profile.feedbackSummary.redFlagTags;

    return {
      score: finalScore,
      positiveReasons: finalScore > 0 ? positiveReasons : [],
      negativeReasons: finalScore < 50 ? negativeReasons : [],
      redFlags,
      notes: input.notes || "Detailed heuristic assessment",
    };
  }
}

export const createDefaultLlmProvider = () => new HeuristicLlmProvider();
