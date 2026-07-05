/**
 * Record-shaping helper for the Character family: maps an API `ExperienceRecord`
 * onto the `CharacterExperienceRecord` view-model the Experience workspace
 * renders. Pure, no React — `CharacterExperienceView` calls it on fetched data.
 */
import type { ExperienceRecord } from "../../api";
import type { CharacterExperienceRecord } from "./character-hub-types";

export function mapExperienceRecordToHubRecord(
  experience: ExperienceRecord,
): CharacterExperienceRecord {
  return {
    id: experience.id,
    type: experience.type,
    outcome: experience.outcome,
    context: experience.context,
    action: experience.action,
    result: experience.result,
    learning: experience.learning,
    tags: experience.tags,
    keywords: experience.keywords,
    associatedEntityIds: experience.associatedEntityIds,
    domain: experience.domain,
    confidence: experience.confidence,
    importance: experience.importance,
    createdAt: experience.createdAt,
    updatedAt: experience.updatedAt,
    supersedes: experience.supersedes,
    relatedExperienceIds: experience.relatedExperiences,
    mergedExperienceIds: experience.mergedExperienceIds,
    embeddingDimensions: experience.embeddingDimensions,
    previousBelief: experience.previousBelief,
    correctedBelief: experience.correctedBelief,
    sourceMessageIds: experience.sourceMessageIds,
    sourceRoomId: experience.sourceRoomId,
    sourceTriggerMessageId: experience.sourceTriggerMessageId,
    sourceTrajectoryId: experience.sourceTrajectoryId,
    sourceTrajectoryStepId: experience.sourceTrajectoryStepId,
    extractionMethod: experience.extractionMethod,
    extractionReason: experience.extractionReason,
  };
}
