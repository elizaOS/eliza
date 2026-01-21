import { randomUUID } from "node:crypto";
import { upsertFact } from "./facts";
import { feedbackBiasWeight, processFeedbackQueue } from "./feedback";
import { addGraphEdge, normalizeGraphWeights } from "./graph";
import { createLogger } from "./logger";
import {
  buildCandidatePool,
  createMatchRecord,
  runLargePass,
  runSmallPass,
} from "./matching";
import { proposeMeetingRecord } from "./scheduling";
import type {
  EngineDependencies,
  EngineOptions,
  EngineRunResult,
  EngineState,
  MatchRecord,
  Persona,
} from "./types";
import { createRng, hashString, isoNow } from "./utils";

const logger = createLogger("engine");

const defaultIdFactory = (): string => randomUUID();

const selectBatch = (
  state: EngineState,
  options: EngineOptions,
  now: string,
): Persona[] => {
  if (options.targetPersonaIds && options.targetPersonaIds.length > 0) {
    const target = new Set(options.targetPersonaIds);
    return state.personas.filter((persona) => target.has(persona.id));
  }
  const active = state.personas.filter(
    (persona) => persona.status === "active",
  );

  // Sort by priority boost (highest first), then shuffle within same priority
  const seed = hashString(now);
  const rng = createRng(seed);

  // Group by priority: those with boost go first
  const prioritized = active.filter((p) => (p.priorityBoost ?? 0) > 0);
  const regular = active.filter((p) => (p.priorityBoost ?? 0) === 0);

  // Shuffle within each group to maintain fairness at same priority level
  const shuffledPrioritized = rng.shuffle(prioritized);
  const shuffledRegular = rng.shuffle(regular);

  // Combine: prioritized first, then regular
  const combined = [...shuffledPrioritized, ...shuffledRegular];
  return combined.slice(0, Math.max(0, options.batchSize));
};

const hasOpenMatch = (matches: MatchRecord[], a: number, b: number): boolean =>
  matches.some(
    (match) =>
      ((match.personaA === a && match.personaB === b) ||
        (match.personaA === b && match.personaB === a)) &&
      match.status !== "canceled" &&
      match.status !== "expired",
  );

export const runEngineTick = async (
  state: EngineState,
  options: EngineOptions,
  deps: EngineDependencies = {},
): Promise<EngineRunResult> => {
  const now = options.now ?? isoNow();
  logger.info("Starting engine tick", {
    batchSize: options.batchSize,
    matchDomains: options.matchDomains,
    personaCount: state.personas.length,
  });

  try {
    const nextState = structuredClone(state);
    const idFactory = deps.idFactory ?? defaultIdFactory;

    let feedbackResult;
    try {
      feedbackResult = processFeedbackQueue(
        nextState,
        now,
        options.processFeedbackLimit ?? 50,
      );
      logger.info("Processed feedback queue", {
        processed: feedbackResult.processed.length,
        personasUpdated: feedbackResult.personasUpdated.length,
      });
    } catch (error) {
      logger.error("Failed to process feedback queue", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw new Error(
        `Feedback processing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    for (const entry of feedbackResult.processed) {
      try {
        const rater = nextState.personas.find(
          (persona) => persona.id === entry.fromPersonaId,
        );
        const biasWeight = rater ? feedbackBiasWeight(rater.feedbackBias) : 1;
        const hasSevereIssue = entry.issues.some(
          (issue) =>
            issue.redFlag ||
            issue.severity === "high" ||
            issue.severity === "critical",
        );
        const edgeType =
          entry.sentiment === "negative" ||
          entry.redFlags.length > 0 ||
          hasSevereIssue
            ? "feedback_negative"
            : "feedback_positive";
        addGraphEdge(nextState.matchGraph, {
          from: entry.fromPersonaId,
          to: entry.toPersonaId,
          weight: Math.max(0.05, (entry.rating / 5) * biasWeight),
          type: edgeType,
          createdAt: now,
        });
      } catch (error) {
        logger.warn("Failed to add graph edge for feedback", {
          feedbackId: entry.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const batch = selectBatch(nextState, options, now);
    logger.info("Selected batch for processing", { batchSize: batch.length });

    const matchesCreated: MatchRecord[] = [];
    const personasUpdated: Persona[] = [...feedbackResult.personasUpdated];
    const maxConversations = options.processConversationLimit ?? 50;
    let processedConversations = 0;

    for (const persona of batch) {
      try {
        for (const conversation of persona.conversations) {
          if (processedConversations >= maxConversations) {
            break;
          }
          if (conversation.processed) {
            continue;
          }

          try {
            const lastUserTurn = [...conversation.turns]
              .reverse()
              .find((turn) => turn.role === "user");
            if (lastUserTurn) {
              upsertFact(
                persona,
                {
                  type: "conversation",
                  key: `conversation:${conversation.conversationId}`,
                  value: lastUserTurn.text,
                  confidence: 0.6,
                  evidence: [
                    {
                      conversationId: conversation.conversationId,
                      turnIds: [lastUserTurn.turnId],
                    },
                  ],
                },
                now,
              );
            }
            conversation.processed = true;
            conversation.processedAt = now;
            processedConversations += 1;
            persona.profileRevision += 1;
            persona.lastUpdated = now;
            if (!personasUpdated.includes(persona)) {
              personasUpdated.push(persona);
            }
          } catch (error) {
            logger.warn("Failed to process conversation", {
              personaId: persona.id,
              conversationId: conversation.conversationId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        for (const domain of persona.domains) {
          if (!options.matchDomains.includes(domain)) {
            continue;
          }

          try {
            const candidates = buildCandidatePool(
              nextState,
              persona,
              domain,
              options,
            );
            if (candidates.length === 0) {
              continue;
            }

            logger.debug("Running small pass", {
              personaId: persona.id,
              domain,
              candidateCount: candidates.length,
            });

            const smallPass = await runSmallPass(
              persona,
              candidates,
              domain,
              Math.max(1, options.smallPassTopK),
              deps.llm,
              options.reliabilityWeight,
              options.minAvailabilityMinutes ?? 120,
            );

            logger.debug("Running large pass", {
              personaId: persona.id,
              domain,
              topKCount: Math.max(1, options.largePassTopK),
            });

            const largePass = await runLargePass(
              persona,
              smallPass.slice(0, Math.max(1, options.largePassTopK)),
              domain,
              deps.llm,
              options.reliabilityWeight,
              options.minAvailabilityMinutes ?? 120,
            );

            for (const scored of largePass) {
              try {
                if (
                  hasOpenMatch(
                    nextState.matches,
                    persona.id,
                    scored.candidate.id,
                  )
                ) {
                  continue;
                }
                const assessment = {
                  ...scored.assessment,
                  smallPassScore:
                    scored.assessment.smallPassScore ?? scored.assessment.score,
                  largePassScore:
                    scored.assessment.largePassScore ?? scored.assessment.score,
                };
                const match = createMatchRecord(
                  persona,
                  scored.candidate,
                  domain,
                  assessment,
                  idFactory,
                  now,
                );
                nextState.matches.push(match);
                matchesCreated.push(match);
                addGraphEdge(nextState.matchGraph, {
                  from: persona.id,
                  to: scored.candidate.id,
                  weight: Math.max(0, assessment.score) / 100,
                  type: "match",
                  createdAt: now,
                });

                if (options.autoScheduleMatches) {
                  try {
                    const meeting = await proposeMeetingRecord(
                      match,
                      persona,
                      scored.candidate,
                      now,
                      deps.locationProvider,
                      options.minAvailabilityMinutes ?? 120,
                      idFactory,
                    );
                    if (meeting) {
                      match.status = "scheduled";
                      match.scheduledMeetingId = meeting.meetingId;
                      nextState.meetings.push(meeting);
                      logger.info("Scheduled meeting for match", {
                        matchId: match.matchId,
                        meetingId: meeting.meetingId,
                      });
                    }
                  } catch (error) {
                    logger.warn("Failed to schedule meeting for match", {
                      matchId: match.matchId,
                      error:
                        error instanceof Error ? error.message : String(error),
                    });
                  }
                }
              } catch (error) {
                logger.warn("Failed to create match record", {
                  personaId: persona.id,
                  candidateId: scored.candidate.id,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          } catch (error) {
            logger.error("Failed to run matching for domain", {
              personaId: persona.id,
              domain,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            });
          }
        }
        persona.lastUpdated = now;
      } catch (error) {
        logger.error("Failed to process persona", {
          personaId: persona.id,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    }

    try {
      normalizeGraphWeights(nextState.matchGraph);
    } catch (error) {
      logger.warn("Failed to normalize graph weights", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    for (const match of matchesCreated) {
      const pA = nextState.personas.find((p) => p.id === match.personaA);
      const pB = nextState.personas.find((p) => p.id === match.personaB);
      if (pA) {
        pA.profileRevision += 1;
        if (!personasUpdated.includes(pA)) {
          personasUpdated.push(pA);
        }
      }
      if (pB) {
        pB.profileRevision += 1;
        if (!personasUpdated.includes(pB)) {
          personasUpdated.push(pB);
        }
      }
    }

    logger.info("Engine tick completed successfully", {
      matchesCreated: matchesCreated.length,
      feedbackProcessed: feedbackResult.processed.length,
      personasUpdated: personasUpdated.length,
      conversationsProcessed: processedConversations,
    });

    return {
      state: nextState,
      matchesCreated,
      feedbackProcessed: feedbackResult.processed,
      personasUpdated,
    };
  } catch (error) {
    logger.error("Engine tick failed catastrophically", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      batchSize: options.batchSize,
      matchDomains: options.matchDomains,
    });
    throw error;
  }
};
