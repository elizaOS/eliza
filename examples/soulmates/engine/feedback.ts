import { upsertFact } from "./facts";
import { createLogger } from "./logger";
import type {
  EngineState,
  FeedbackEntry,
  FeedbackRaterBias,
  FeedbackSentiment,
  IsoDateTime,
  Persona,
  ReliabilityEvent,
} from "./types";
import { clampNumber, isoNow } from "./utils";

const logger = createLogger("feedback");

const sentimentMap: Record<FeedbackSentiment, number> = {
  positive: 1,
  negative: -1,
  neutral: 0,
};
const sentimentToScore = (sentiment: FeedbackSentiment): number =>
  sentimentMap[sentiment];

const reliabilityImpactForIssue = (code: string): number => {
  const normalized = code.toLowerCase();
  if (normalized.includes("ghost") || normalized.includes("no_show")) {
    return -0.25;
  }
  if (normalized.includes("late_cancel") || normalized.includes("late")) {
    return -0.12;
  }
  if (normalized.includes("on_time") || normalized.includes("attended")) {
    return 0.08;
  }
  return 0;
};

const reliabilityImpactForRating = (rating: number): number =>
  rating >= 5 ? 0.08 : rating >= 4 ? 0.04 : rating <= 2 ? -0.06 : 0;

const pushReliabilityEvent = (
  persona: Persona,
  event: ReliabilityEvent,
): void => {
  persona.reliability.history = [...persona.reliability.history, event];
};

const applyReliabilityDelta = (
  persona: Persona,
  delta: number,
  now: IsoDateTime,
): void => {
  persona.reliability.score = clampNumber(
    persona.reliability.score + delta,
    0,
    1,
  );
  persona.reliability.lastUpdated = now;
};

const updateSentimentSummary = (
  persona: Persona,
  sentiment: FeedbackSentiment,
  entry: FeedbackEntry,
  now: IsoDateTime,
  weight: number,
): void => {
  const summary = persona.profile.feedbackSummary;
  const sentimentValue = sentimentToScore(sentiment) * weight;
  const totalCount =
    summary.positiveCount + summary.neutralCount + summary.negativeCount + 1;
  summary.sentimentScore =
    (summary.sentimentScore * (totalCount - 1) + sentimentValue) / totalCount;
  if (sentiment === "positive") {
    summary.positiveCount += 1;
  } else if (sentiment === "negative") {
    summary.negativeCount += 1;
  } else {
    summary.neutralCount += 1;
  }
  summary.issueTags = [
    ...new Set([
      ...summary.issueTags,
      ...entry.issues.map((issue) => issue.code),
    ]),
  ];
  summary.redFlagTags = [
    ...new Set([...summary.redFlagTags, ...entry.redFlags]),
  ];
  summary.lastUpdated = now;
};

const updateRaterBias = (
  persona: Persona,
  entry: FeedbackEntry,
  now: IsoDateTime,
): void => {
  const stats = persona.feedbackBias.stats;
  const totalBefore = stats.givenCount;
  const newCount = totalBefore + 1;
  stats.averageRating =
    (stats.averageRating * totalBefore + entry.rating) / newCount;
  const negative = entry.sentiment === "negative" ? 1 : 0;
  const redFlags = entry.redFlags.length > 0 ? 1 : 0;
  stats.negativeRate = (stats.negativeRate * totalBefore + negative) / newCount;
  stats.redFlagRate = (stats.redFlagRate * totalBefore + redFlags) / newCount;
  stats.givenCount = newCount;
  stats.lastUpdated = now;

  persona.feedbackBias.harshnessScore = clampNumber(
    1 - stats.averageRating / 5,
    0,
    1,
  );
  persona.feedbackBias.positivityBias = clampNumber(
    1 - stats.negativeRate,
    0,
    1,
  );
  persona.feedbackBias.redFlagFrequency = clampNumber(stats.redFlagRate, 0, 1);
  persona.feedbackBias.lastUpdated = now;

  const biasFields = [
    {
      key: "feedback_bias:harshness",
      value: persona.feedbackBias.harshnessScore,
    },
    {
      key: "feedback_bias:positivity",
      value: persona.feedbackBias.positivityBias,
    },
    {
      key: "feedback_bias:red_flag_frequency",
      value: persona.feedbackBias.redFlagFrequency,
    },
  ];
  for (const field of biasFields) {
    upsertFact(
      persona,
      { type: "feedback_bias", ...field, confidence: 0.7, evidence: [] },
      now,
    );
  }

  persona.profileRevision += 1;
  persona.lastUpdated = now;
};

const sentimentFromRating = (rating: number): FeedbackSentiment =>
  rating >= 4 ? "positive" : rating <= 2 ? "negative" : "neutral";

const ratingWithBias = (rating: number, bias: FeedbackRaterBias): number => {
  const harshnessOffset = (bias.harshnessScore - 0.5) * 0.9;
  const positivityOffset = (bias.positivityBias - 0.5) * -0.9;
  return clampNumber(rating + harshnessOffset + positivityOffset, 1, 5);
};

export const feedbackBiasWeight = (bias: FeedbackRaterBias): number => {
  const harshnessDistance = Math.abs(bias.harshnessScore - 0.5);
  const positivityDistance = Math.abs(bias.positivityBias - 0.5);
  return clampNumber(
    1 - (harshnessDistance * 0.5 + positivityDistance * 0.5),
    0.6,
    1.2,
  );
};

const isGhostingReport = (entry: FeedbackEntry): boolean => {
  const codes = entry.issues.map((issue) => issue.code.toLowerCase());
  return codes.some(
    (code) => code.includes("ghost") || code.includes("no_show"),
  );
};

const eventTypeForEntry = (entry: FeedbackEntry): ReliabilityEvent["type"] => {
  const codes = entry.issues.map((issue) => issue.code.toLowerCase());
  if (codes.some((code) => code.includes("ghost"))) {
    return "ghost";
  }
  if (codes.some((code) => code.includes("no_show"))) {
    return "no_show";
  }
  if (codes.some((code) => code.includes("late_cancel"))) {
    return "late_cancel";
  }
  if (entry.rating >= 4) {
    return "attended";
  }
  return "on_time";
};

const applyGhostedBoost = (
  rater: Persona,
  entry: FeedbackEntry,
  now: IsoDateTime,
  bias: FeedbackRaterBias,
): void => {
  if (!isGhostingReport(entry)) {
    return;
  }
  const weight = feedbackBiasWeight(bias);
  const delta = 0.05 * weight;
  const event: ReliabilityEvent = {
    eventId: `rel-ghosted-${entry.id}`,
    type: "attended",
    occurredAt: entry.createdAt,
    impact: delta,
    notes: "Reported ghost/no-show, assumed attended.",
  };
  pushReliabilityEvent(rater, event);
  applyReliabilityDelta(rater, delta, now);

  const currentMin = rater.matchPreferences.reliabilityMinScore ?? 0;
  const targetMin = clampNumber(rater.reliability.score + 0.15, 0, 0.85);
  rater.matchPreferences.reliabilityMinScore = Math.max(currentMin, targetMin);

  upsertFact(
    rater,
    {
      type: "feedback_experience",
      key: "feedback_experience:ghosted",
      value: `ghosted_by:${entry.toPersonaId}`,
      confidence: 0.75,
      evidence: [],
    },
    now,
  );
};

const applyFeedbackToPersona = (
  persona: Persona,
  entry: FeedbackEntry,
  now: IsoDateTime,
  bias: FeedbackRaterBias,
): void => {
  const adjustedRating = ratingWithBias(entry.rating, bias);
  const effectiveSentiment = sentimentFromRating(adjustedRating);
  const weight = feedbackBiasWeight(bias);
  updateSentimentSummary(persona, effectiveSentiment, entry, now, weight);

  let delta = reliabilityImpactForRating(adjustedRating);
  for (const issue of entry.issues) {
    delta += reliabilityImpactForIssue(issue.code);
    if (issue.code.toLowerCase().includes("no_show")) {
      persona.reliability.noShowCount += 1;
    } else if (issue.code.toLowerCase().includes("ghost")) {
      persona.reliability.ghostCount += 1;
    } else if (issue.code.toLowerCase().includes("late_cancel")) {
      persona.reliability.lateCancelCount += 1;
    }
  }

  if (adjustedRating >= 4) {
    persona.reliability.attendedCount += 1;
  }

  const event: ReliabilityEvent = {
    eventId: `rel-${entry.id}`,
    type: eventTypeForEntry(entry),
    occurredAt: entry.createdAt,
    impact: delta * weight,
    notes: entry.notes,
  };
  pushReliabilityEvent(persona, event);
  applyReliabilityDelta(persona, delta * weight, now);

  for (const issue of entry.issues) {
    const key = `feedback_issue:${issue.code}`;
    upsertFact(
      persona,
      {
        type: "feedback_issue",
        key,
        value: issue.code,
        confidence: clampNumber(entry.rating / 5, 0, 1),
        evidence: [],
      },
      now,
    );
  }
  for (const flag of entry.redFlags) {
    const key = `feedback_red_flag:${flag}`;
    upsertFact(
      persona,
      {
        type: "feedback_red_flag",
        key,
        value: flag,
        confidence: clampNumber(entry.rating / 5, 0, 1),
        evidence: [],
      },
      now,
    );
  }

  persona.lastUpdated = now;
  persona.profileRevision += 1;
};

export interface FeedbackProcessingResult {
  processed: FeedbackEntry[];
  personasUpdated: Persona[];
}

export const processFeedbackQueue = (
  state: EngineState,
  now: IsoDateTime = isoNow(),
  limit: number = 50,
): FeedbackProcessingResult => {
  logger.debug("Processing feedback queue", {
    queueSize: state.feedbackQueue.length,
    limit,
  });

  const byId = new Map<number, Persona>();
  for (const persona of state.personas) {
    byId.set(persona.id, persona);
  }

  const processed: FeedbackEntry[] = [];
  const updatedIds = new Set<number>();

  for (const entry of state.feedbackQueue) {
    if (processed.length >= limit) {
      break;
    }
    if (entry.processed) {
      continue;
    }

    const receiver = byId.get(entry.toPersonaId);
    const rater = byId.get(entry.fromPersonaId);
    if (!receiver || !rater) {
      logger.warn("Feedback references invalid persona", {
        feedbackId: entry.id,
        toPersonaId: entry.toPersonaId,
        fromPersonaId: entry.fromPersonaId,
      });
      entry.processed = true;
      entry.processedAt = now;
      processed.push(entry);
      continue;
    }

    applyFeedbackToPersona(receiver, entry, now, rater.feedbackBias);
    applyGhostedBoost(rater, entry, now, rater.feedbackBias);
    updateRaterBias(rater, entry, now);

    entry.processed = true;
    entry.processedAt = now;
    processed.push(entry);
    updatedIds.add(receiver.id);
    updatedIds.add(rater.id);
  }

  logger.info("Feedback queue processed", {
    processed: processed.length,
    personasUpdated: updatedIds.size,
    remaining: state.feedbackQueue.filter((e) => !e.processed).length,
  });

  const personasUpdated = state.personas.filter((persona) =>
    updatedIds.has(persona.id),
  );
  return { processed, personasUpdated };
};
