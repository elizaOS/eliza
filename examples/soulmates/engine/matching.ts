import { buildAdjacency, expandGraphCandidates } from "./graph";
import { createLogger } from "./logger";
import type {
  DomainMode,
  EngineOptions,
  EngineState,
  LlmProvider,
  MatchAssessment,
  MatchRecord,
  Persona,
  PersonaId,
} from "./types";
import { clampInt, clampNumber, createRng, hashString, unique } from "./utils";

const logger = createLogger("matching");

const minutesOverlap = (
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): number => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

const hasAvailabilityOverlap = (
  a: Persona,
  b: Persona,
  minMinutes: number,
): boolean => {
  const byDay = new Map<string, Array<{ start: number; end: number }>>();
  for (const window of a.profile.availability.weekly) {
    const day = window.day;
    const list = byDay.get(day) ?? [];
    list.push({ start: window.startMinutes, end: window.endMinutes });
    byDay.set(day, list);
  }
  for (const window of b.profile.availability.weekly) {
    const list = byDay.get(window.day);
    if (!list) {
      continue;
    }
    for (const slot of list) {
      if (
        minutesOverlap(
          slot.start,
          slot.end,
          window.startMinutes,
          window.endMinutes,
        ) >= minMinutes
      ) {
        return true;
      }
    }
  }
  return false;
};

const jaccard = (a: string[], b: string[]): number => {
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  const setA = new Set(a.map((value) => value.toLowerCase()));
  const setB = new Set(b.map((value) => value.toLowerCase()));
  const intersection = [...setA].filter((item) => setB.has(item)).length;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

const collectInterestSignals = (persona: Persona): string[] => {
  const tags: string[] = [...persona.profile.interests];
  for (const fact of persona.facts) {
    const key = fact.key.toLowerCase();
    if (fact.type === "interest" || key.includes("interest")) {
      if (typeof fact.value === "string") {
        tags.push(fact.value);
      } else if (Array.isArray(fact.value)) {
        for (const item of fact.value) {
          if (typeof item === "string") {
            tags.push(item);
          }
        }
      }
    }
  }
  return unique(tags);
};

const hasSharedInterests = (a: Persona, b: Persona): boolean => {
  const aTags = new Set(
    collectInterestSignals(a).map((value) => value.toLowerCase()),
  );
  const bTags = collectInterestSignals(b).map((value) => value.toLowerCase());
  return bTags.some((tag) => aTags.has(tag));
};

const haversineKm = (
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number => {
  const rad = (deg: number): number => (deg * Math.PI) / 180;
  const r = 6371;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const lat1 = rad(a.lat);
  const lat2 = rad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
};

const distanceScore = (a: Persona, b: Persona): number => {
  const locA = a.general.location;
  const locB = b.general.location;
  if (locA.city === locB.city) {
    return 1;
  }
  if (locA.geo && locB.geo) {
    const km = haversineKm(locA.geo, locB.geo);
    if (km <= 5) {
      return 0.9;
    }
    if (km <= 15) {
      return 0.7;
    }
    if (km <= 40) {
      return 0.4;
    }
    return 0.1;
  }
  return 0.2;
};

const profileDealbreakerHit = (
  dealbreakers: string[],
  candidate: Persona,
): string[] => {
  if (dealbreakers.length === 0) {
    return [];
  }
  const searchSpace = [
    ...candidate.profile.interests,
    ...candidate.general.values,
    candidate.general.bio,
    ...candidate.facts.flatMap((fact) =>
      typeof fact.value === "string"
        ? [fact.value]
        : Array.isArray(fact.value)
          ? fact.value.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
    ),
  ];
  const lowerSpace = searchSpace.map((value) => value.toLowerCase());
  return dealbreakers.filter((breaker) =>
    lowerSpace.some((value) => value.includes(breaker.toLowerCase())),
  );
};

const daysBetween = (a: string, b: string): number =>
  Math.abs(new Date(a).getTime() - new Date(b).getTime()) /
  (1000 * 60 * 60 * 24);

const recentlyMatched = (
  state: EngineState,
  personaA: PersonaId,
  personaB: PersonaId,
  now: string,
  cooldownDays: number,
): boolean =>
  state.matches.some(
    (match) =>
      ((match.personaA === personaA && match.personaB === personaB) ||
        (match.personaA === personaB && match.personaB === personaA)) &&
      daysBetween(match.createdAt, now) <= cooldownDays,
  );

const hasRecentNegativeFeedback = (
  state: EngineState,
  personaA: PersonaId,
  personaB: PersonaId,
  now: string,
  cooldownDays: number,
): boolean =>
  state.feedbackQueue.some((entry) => {
    const isPair =
      (entry.fromPersonaId === personaA && entry.toPersonaId === personaB) ||
      (entry.fromPersonaId === personaB && entry.toPersonaId === personaA);
    if (!isPair || daysBetween(entry.createdAt, now) > cooldownDays) {
      return false;
    }
    const severeIssue = entry.issues.some(
      (issue) =>
        issue.redFlag ||
        issue.severity === "high" ||
        issue.severity === "critical",
    );
    return (
      entry.sentiment === "negative" || entry.redFlags.length > 0 || severeIssue
    );
  });

const inRecentMatchWindow = (
  state: EngineState,
  personaA: PersonaId,
  personaB: PersonaId,
  windowSize: number,
): boolean => {
  if (windowSize <= 0) {
    return false;
  }
  const recentMatches = state.matches
    .filter(
      (match) => match.personaA === personaA || match.personaB === personaA,
    )
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, windowSize);
  return recentMatches.some(
    (match) => match.personaA === personaB || match.personaB === personaB,
  );
};

const genderCategory = (value: string): "woman" | "man" | "nonbinary" => {
  const normalized = value.toLowerCase();
  if (normalized.includes("woman")) {
    return "woman";
  }
  if (normalized.includes("man")) {
    return "man";
  }
  return "nonbinary";
};

const derivePreferredGenders = (
  orientation: string,
  genderIdentity: string,
): string[] => {
  const orientationLower = orientation.toLowerCase();
  const selfGender = genderCategory(genderIdentity);
  if (orientationLower.includes("bi") || orientationLower.includes("pan")) {
    return ["woman", "man", "nonbinary"];
  }
  if (orientationLower.includes("gay")) {
    return [selfGender];
  }
  if (orientationLower.includes("straight")) {
    if (selfGender === "man") {
      return ["woman"];
    }
    if (selfGender === "woman") {
      return ["man"];
    }
    return ["woman", "man"];
  }
  return ["woman", "man", "nonbinary"];
};

const matchesPreferredGender = (
  preferred: string[],
  candidateGender: string,
): boolean => {
  if (preferred.length === 0) {
    return true;
  }
  const candidateCategory = genderCategory(candidateGender);
  return preferred.some((value) => genderCategory(value) === candidateCategory);
};

const datingEligibility = (a: Persona, b: Persona): string | null => {
  const profileA = a.domainProfiles.dating;
  const profileB = b.domainProfiles.dating;
  if (!profileA || !profileB) {
    return "missing dating profile";
  }
  const prefA = profileA.datingPreferences;
  const prefB = profileB.datingPreferences;
  const preferredA =
    prefA.preferredGenders.length > 0
      ? prefA.preferredGenders
      : derivePreferredGenders(prefA.orientation, a.general.genderIdentity);
  const preferredB =
    prefB.preferredGenders.length > 0
      ? prefB.preferredGenders
      : derivePreferredGenders(prefB.orientation, b.general.genderIdentity);
  const genderOkA = matchesPreferredGender(
    preferredA,
    b.general.genderIdentity,
  );
  const genderOkB = matchesPreferredGender(
    preferredB,
    a.general.genderIdentity,
  );
  if (!genderOkA || !genderOkB) {
    return "gender preference mismatch";
  }
  if (
    a.general.age < prefB.preferredAgeMin ||
    a.general.age > prefB.preferredAgeMax
  ) {
    return "age preference mismatch (B)";
  }
  if (
    b.general.age < prefA.preferredAgeMin ||
    b.general.age > prefA.preferredAgeMax
  ) {
    return "age preference mismatch (A)";
  }

  const dealbreakersHitA = profileDealbreakerHit(prefA.dealbreakers, b);
  const dealbreakersHitB = profileDealbreakerHit(prefB.dealbreakers, a);
  if (dealbreakersHitA.length > 0 || dealbreakersHitB.length > 0) {
    return "dealbreaker hit";
  }
  return null;
};

const businessEligibility = (a: Persona, b: Persona): string | null => {
  const profileA = a.domainProfiles.business;
  const profileB = b.domainProfiles.business;
  if (!profileA || !profileB) {
    return "missing business profile";
  }
  if (
    profileA.seekingRoles.length === 0 &&
    profileB.seekingRoles.length === 0
  ) {
    return null;
  }
  const matchesA = profileA.seekingRoles.some((role) =>
    profileB.roles.includes(role),
  );
  const matchesB = profileB.seekingRoles.some((role) =>
    profileA.roles.includes(role),
  );
  return matchesA || matchesB ? null : "no complementary roles";
};

const friendshipEligibility = (a: Persona, b: Persona): string | null => {
  const profileA = a.domainProfiles.friendship;
  const profileB = b.domainProfiles.friendship;
  if (!profileA || !profileB) {
    return "missing friendship profile";
  }
  const overlap = jaccard(profileA.interests, profileB.interests);
  return overlap >= 0.05 ? null : "no shared interests";
};

const domainEligibility = (
  domain: DomainMode,
  a: Persona,
  b: Persona,
): string | null => {
  if (domain === "dating") {
    return datingEligibility(a, b);
  }
  if (domain === "business") {
    return businessEligibility(a, b);
  }
  if (domain === "friendship") {
    return friendshipEligibility(a, b);
  }
  return null;
};

const attractivenessGapPenalty = (a: Persona, b: Persona): number => {
  const profileA = a.domainProfiles.dating;
  const profileB = b.domainProfiles.dating;
  if (!profileA || !profileB) {
    return 0;
  }
  const gap = Math.abs(
    profileA.attractionProfile.appearance.attractiveness -
      profileB.attractionProfile.appearance.attractiveness,
  );
  const importanceA = profileA.datingPreferences.attractivenessImportance;
  const importanceB = profileB.datingPreferences.attractivenessImportance;
  const weight = (importanceA + importanceB) / 20;
  if (gap <= 2) {
    return 0;
  }
  return -weight * gap * 4;
};

const bodyTypePenalty = (a: Persona, b: Persona): number => {
  const profileA = a.domainProfiles.dating;
  const profileB = b.domainProfiles.dating;
  if (!profileA || !profileB) {
    return 0;
  }
  const prefsA = profileA.datingPreferences.bodyTypePreferences;
  const prefsB = profileB.datingPreferences.bodyTypePreferences;
  const buildA = profileA.attractionProfile.appearance.build;
  const buildB = profileB.attractionProfile.appearance.build;
  let penalty = 0;
  if (prefsA.length > 0 && !prefsA.includes(buildB)) {
    penalty -= 6;
  }
  if (prefsB.length > 0 && !prefsB.includes(buildA)) {
    penalty -= 6;
  }
  return penalty;
};

const baseHeuristicScore = (
  domain: DomainMode,
  a: Persona,
  b: Persona,
  reliabilityWeight: number,
  minAvailabilityMinutes: number,
): MatchAssessment => {
  const positiveReasons: string[] = [];
  const negativeReasons: string[] = [];
  const redFlags = unique([
    ...a.profile.feedbackSummary.redFlagTags,
    ...b.profile.feedbackSummary.redFlagTags,
  ]);

  let score = 0;

  const interestScore = jaccard(
    collectInterestSignals(a),
    collectInterestSignals(b),
  );
  score += interestScore * 40;
  if (interestScore > 0.25) {
    positiveReasons.push("shared interests");
  } else if (interestScore < 0.05) {
    negativeReasons.push("low interest overlap");
  }
  // ORI_MASTER_BIBLE spec: cap at 40% dissimilarity (penalize below 60% similarity)
  if (interestScore < 0.6) {
    const dissimilarityPenalty = (0.6 - interestScore) * 15;
    score -= dissimilarityPenalty;
  }

  const availabilityOk = hasAvailabilityOverlap(a, b, minAvailabilityMinutes);
  if (availabilityOk) {
    score += 12;
    positiveReasons.push("availability overlap");
  } else {
    score -= 20;
    negativeReasons.push("limited availability overlap");
  }

  const distance = distanceScore(a, b);
  score += distance * 10;
  if (distance < 0.2) {
    negativeReasons.push("distance friction");
  }

  const reliabilityAvg = (a.reliability.score + b.reliability.score) / 2;
  score += reliabilityAvg * 20 * clampNumber(reliabilityWeight, 0, 2);
  if (reliabilityAvg < 0.4) {
    negativeReasons.push("low reliability signals");
  } else if (reliabilityAvg > 0.7) {
    positiveReasons.push("strong reliability signals");
  }

  const biasPenalty =
    Math.max(0, a.feedbackBias.redFlagFrequency - 0.3) * 18 +
    Math.max(0, b.feedbackBias.redFlagFrequency - 0.3) * 18 +
    Math.max(0, a.feedbackBias.harshnessScore - 0.7) * 12 +
    Math.max(0, b.feedbackBias.harshnessScore - 0.7) * 12;
  if (biasPenalty > 0) {
    score -= biasPenalty;
    negativeReasons.push("harsh feedback patterns");
  }

  if (redFlags.length > 0) {
    score -= redFlags.length * 10;
    negativeReasons.push("feedback red flags");
  }

  if (domain === "dating") {
    score += attractivenessGapPenalty(a, b);
    score += bodyTypePenalty(a, b);
    if (score < -20) {
      negativeReasons.push("dating fit concerns");
    }
  }

  if (domain === "business") {
    const profileA = a.domainProfiles.business;
    const profileB = b.domainProfiles.business;
    if (profileA && profileB) {
      const complement = profileA.seekingRoles.some((role) =>
        profileB.roles.includes(role),
      );
      if (complement) {
        score += 12;
        positiveReasons.push("role complement");
      }
      const sharedSkills = jaccard(profileA.skills, profileB.skills);
      score += sharedSkills * 12;
      if (sharedSkills > 0.25) {
        positiveReasons.push("shared skills");
      }
    }
  }

  if (domain === "friendship") {
    const profileA = a.domainProfiles.friendship;
    const profileB = b.domainProfiles.friendship;
    if (profileA && profileB) {
      if (profileA.vibe === profileB.vibe) {
        score += 8;
        positiveReasons.push("similar vibe");
      }
      if (profileA.energy === profileB.energy) {
        score += 6;
        positiveReasons.push("energy alignment");
      }
      const boundaryOverlap = jaccard(profileA.boundaries, profileB.boundaries);
      if (boundaryOverlap > 0.1) {
        score += 4;
      }
    }
  }

  return {
    score: clampInt(score, -100, 100),
    positiveReasons,
    negativeReasons,
    redFlags,
  };
};

export interface ScoredCandidate {
  candidate: Persona;
  assessment: MatchAssessment;
}

const baselineWeight = (
  domain: DomainMode,
  persona: Persona,
  candidate: Persona,
  reliabilityWeight: number,
  minAvailabilityMinutes: number,
): number => {
  const assessment = baseHeuristicScore(
    domain,
    persona,
    candidate,
    reliabilityWeight,
    minAvailabilityMinutes,
  );
  // ORI_MASTER_BIBLE spec: Reliability score weighs higher for users who were ghosted or canceled on
  const victimBoost =
    (candidate.reliability.ghostedByOthersCount ?? 0) * 5 +
    (candidate.reliability.canceledOnByOthersCount ?? 0) * 3;
  return Math.max(1, assessment.score + 120 + victimBoost);
};

export const buildCandidatePool = (
  state: EngineState,
  persona: Persona,
  domain: DomainMode,
  options: EngineOptions,
): Persona[] => {
  logger.debug("Building candidate pool", {
    personaId: persona.id,
    domain,
    totalPersonas: state.personas.length,
  });

  const seed = hashString(options.now ?? "");
  const rng = createRng(seed ^ (persona.id * 1009 + options.batchSize * 17));
  const eligible = state.personas.filter((candidate) => {
    if (candidate.id === persona.id) {
      return false;
    }
    if (!candidate.domains.includes(domain)) {
      return false;
    }
    if (candidate.status !== "active") {
      return false;
    }
    if (options.requireSameCity !== false) {
      if (candidate.general.location.city !== persona.general.location.city) {
        return false;
      }
    }
    if (options.requireSharedInterests !== false) {
      if (!hasSharedInterests(persona, candidate)) {
        return false;
      }
    }
    if (persona.blockedPersonaIds.includes(candidate.id)) {
      return false;
    }
    if (persona.matchPreferences.blockedPersonaIds.includes(candidate.id)) {
      return false;
    }
    if (persona.matchPreferences.excludedPersonaIds.includes(candidate.id)) {
      return false;
    }
    if (
      persona.matchPreferences.reliabilityMinScore !== undefined &&
      candidate.reliability.score < persona.matchPreferences.reliabilityMinScore
    ) {
      return false;
    }
    if (
      recentlyMatched(
        state,
        persona.id,
        candidate.id,
        options.now,
        options.matchCooldownDays,
      )
    ) {
      return false;
    }
    const negativeCooldown = options.negativeFeedbackCooldownDays ?? 180;
    if (
      hasRecentNegativeFeedback(
        state,
        persona.id,
        candidate.id,
        options.now,
        negativeCooldown,
      )
    ) {
      return false;
    }
    const recentWindow = options.recentMatchWindow ?? 8;
    if (inRecentMatchWindow(state, persona.id, candidate.id, recentWindow)) {
      return false;
    }
    if (domainEligibility(domain, persona, candidate) !== null) {
      return false;
    }
    return hasAvailabilityOverlap(
      persona,
      candidate,
      options.minAvailabilityMinutes ?? 120,
    );
  });

  const adjacency = buildAdjacency(state.matchGraph);
  const graphCandidates = expandGraphCandidates(
    persona.id,
    adjacency,
    options.graphHops,
    options.maxCandidates,
  );
  const graphSet = new Set<number>(graphCandidates);
  const weighted = eligible.map((candidate) => ({
    item: candidate,
    weight: baselineWeight(
      domain,
      persona,
      candidate,
      options.reliabilityWeight,
      options.minAvailabilityMinutes ?? 120,
    ),
  }));

  const pool = eligible.filter((candidate) => graphSet.has(candidate.id));
  const seen = new Set<number>(pool.map((p) => p.id));
  const maxCandidates = Math.max(1, options.maxCandidates);

  if (weighted.length === 0) {
    logger.warn("No weighted candidates available", {
      personaId: persona.id,
      domain,
    });
    return pool.slice(0, maxCandidates);
  }

  let safety = 0;
  while (pool.length < maxCandidates && safety < maxCandidates * 3) {
    safety += 1;
    const candidate = rng.pickWeighted(weighted);
    if (seen.has(candidate.id)) {
      continue;
    }
    pool.push(candidate);
    seen.add(candidate.id);
  }

  logger.debug("Candidate pool built", {
    personaId: persona.id,
    domain,
    eligibleCount: eligible.length,
    graphCandidates: graphCandidates.length,
    finalPoolSize: pool.length,
  });

  return pool.slice(0, maxCandidates);
};

export const runSmallPass = async (
  persona: Persona,
  candidates: Persona[],
  domain: DomainMode,
  topK: number,
  llm?: LlmProvider,
  reliabilityWeight: number = 1,
  minAvailabilityMinutes: number = 120,
): Promise<Persona[]> => {
  if (candidates.length === 0) {
    logger.debug("No candidates for small pass", {
      personaId: persona.id,
      domain,
    });
    return [];
  }
  if (llm) {
    const result = await llm.smallPass({
      persona,
      candidates,
      domain,
      notes: "Small pass: coarse fit check and quick ranking.",
    });
    const ranked = result.rankedIds
      .map((id) => candidates.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is Persona => Boolean(candidate));
    logger.debug("Small pass completed (LLM)", {
      personaId: persona.id,
      domain,
      candidatesIn: candidates.length,
      candidatesOut: ranked.length,
      topK,
    });
    if (ranked.length > 0) {
      return ranked.slice(0, topK);
    }
  }
  const scored = candidates.map((candidate) => ({
    candidate,
    score: baseHeuristicScore(
      domain,
      persona,
      candidate,
      reliabilityWeight,
      minAvailabilityMinutes,
    ).score,
  }));
  scored.sort((a, b) => b.score - a.score);
  logger.debug("Small pass completed (heuristic)", {
    personaId: persona.id,
    domain,
    candidatesIn: candidates.length,
    topK,
  });
  return scored.slice(0, topK).map((entry) => entry.candidate);
};

export const runLargePass = async (
  persona: Persona,
  candidates: Persona[],
  domain: DomainMode,
  llm?: LlmProvider,
  reliabilityWeight: number = 1,
  minAvailabilityMinutes: number = 120,
): Promise<ScoredCandidate[]> => {
  logger.debug("Starting large pass", {
    personaId: persona.id,
    domain,
    candidateCount: candidates.length,
  });

  const results: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    if (llm) {
      const output = await llm.largePass({
        persona,
        candidate,
        domain,
        notes: "Large pass: critical, bias-resistant evaluation.",
      });
      const baseline = baseHeuristicScore(
        domain,
        persona,
        candidate,
        reliabilityWeight,
        minAvailabilityMinutes,
      );
      results.push({
        candidate,
        assessment: {
          score: clampInt(output.score, -100, 100),
          positiveReasons: output.positiveReasons,
          negativeReasons: output.negativeReasons,
          redFlags: output.redFlags,
          largePassScore: clampInt(output.score, -100, 100),
          smallPassScore: baseline.score,
        },
      });
    } else {
      const assessment = baseHeuristicScore(
        domain,
        persona,
        candidate,
        reliabilityWeight,
        minAvailabilityMinutes,
      );
      const harshness = Math.max(0, assessment.redFlags.length * 6);
      assessment.score = clampInt(assessment.score - harshness, -100, 100);
      results.push({ candidate, assessment });
    }
  }

  logger.debug("Large pass completed", {
    personaId: persona.id,
    domain,
    candidatesEvaluated: candidates.length,
    resultsCount: results.length,
  });

  results.sort((a, b) => b.assessment.score - a.assessment.score);
  return results;
};

export const createMatchRecord = (
  persona: Persona,
  candidate: Persona,
  domain: DomainMode,
  assessment: MatchAssessment,
  idFactory: () => string,
  now: string,
): MatchRecord => {
  return {
    matchId: idFactory(),
    domain,
    personaA: persona.id,
    personaB: candidate.id,
    createdAt: now,
    status: "proposed",
    assessment,
    reasoning: [...assessment.positiveReasons, ...assessment.negativeReasons],
  };
};
