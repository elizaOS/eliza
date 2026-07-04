import type { UUID } from "@elizaos/core";
import type { JsonValue } from "@feed/shared";
import type { Experience } from "../types";
import { ExperienceType } from "../types";

const CONTENT_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "with",
]);

export interface ExperienceChain {
  rootExperience: string; // UUID of the root experience
  chain: string[]; // Ordered list of experience IDs
  strength: number; // How strong the causal relationship is
  validated: boolean; // Whether the chain has been validated
}

export interface ExperienceRelationship {
  fromId: string;
  toId: string;
  type: "causes" | "contradicts" | "supports" | "supersedes" | "related";
  strength: number; // 0-1
  metadata?: Record<string, JsonValue>;
}

export class ExperienceRelationshipManager {
  private relationships: Map<string, ExperienceRelationship[]> = new Map();

  addRelationship(relationship: ExperienceRelationship): void {
    const { fromId } = relationship;
    if (!this.relationships.has(fromId)) {
      this.relationships.set(fromId, []);
    }
    this.relationships.get(fromId)?.push(relationship);
  }

  findRelationships(
    experienceId: string,
    type?: string,
  ): ExperienceRelationship[] {
    const rels = this.relationships.get(experienceId) || [];
    if (type) {
      return rels.filter((r) => r.type === type);
    }
    return rels;
  }

  detectCausalChain(experiences: Experience[]): ExperienceChain[] {
    const chains: ExperienceChain[] = [];

    // Sort experiences by timestamp
    const sorted = [...experiences].sort((a, b) => a.createdAt - b.createdAt);

    // Look for sequences where success follows hypothesis
    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i];
      if (!current) {
        continue;
      }

      if (current && current.type === ExperienceType.HYPOTHESIS) {
        const chain: string[] = [current.id];
        let j = i + 1;

        // Look for related experiences
        while (j < sorted.length) {
          const next = sorted[j];
          if (!next) {
            j++;
            continue;
          }

          // Check if next experience validates or contradicts the hypothesis
          if (
            next &&
            (next.relatedExperiences?.includes(current.id) ||
              this.isRelated(current, next))
          ) {
            chain.push(next.id);

            // If we found a validation, create a chain
            if (next.type === ExperienceType.VALIDATION) {
              chains.push({
                rootExperience: current.id,
                chain,
                strength: next.confidence,
                validated: next.outcome === "positive",
              });
              break;
            }
          }
          j++;
        }
      }
    }

    return chains;
  }

  private isRelated(exp1: Experience, exp2: Experience): boolean {
    // Check domain match
    if (exp1.domain === exp2.domain) {
      // Check temporal proximity (within 5 minutes)
      const timeDiff = Math.abs(exp2.createdAt - exp1.createdAt);
      if (timeDiff < 5 * 60 * 1000) {
        // Check content similarity
        if (this.contentSimilarity(exp1, exp2) > 0.7) {
          return true;
        }
      }
    }
    return false;
  }

  private contentSimilarity(exp1: Experience, exp2: Experience): number {
    const tokens1 = tokenizeLearning(exp1.learning);
    const tokens2 = tokenizeLearning(exp2.learning);
    if (tokens1.size === 0 || tokens2.size === 0) {
      return 0;
    }

    const intersectionSize = [...tokens1].filter((token) =>
      tokens2.has(token),
    ).length;
    const unionSize = new Set([...tokens1, ...tokens2]).size;
    const jaccard = intersectionSize / unionSize;
    const overlap = Math.min(
      intersectionSize / tokens1.size,
      intersectionSize / tokens2.size,
    );

    return (jaccard + overlap) / 2;
  }

  findContradictions(
    experience: Experience,
    allExperiences: Experience[],
  ): Experience[] {
    const contradictions: Experience[] = [];
    const explicitContradictionIds = new Set(
      this.findRelationships(experience.id, "contradicts").map((r) => r.toId),
    );

    for (const other of allExperiences) {
      if (other.id === experience.id) continue;

      const sameActionDifferentOutcome =
        other.action === experience.action &&
        other.outcome !== experience.outcome &&
        other.domain === experience.domain;

      if (
        sameActionDifferentOutcome ||
        explicitContradictionIds.has(other.id)
      ) {
        contradictions.push(other);
      }
    }

    return contradictions;
  }

  getExperienceImpact(
    experienceId: string,
    allExperiences: Experience[],
  ): number {
    let impact = 0;

    for (const exp of allExperiences) {
      if (exp.relatedExperiences?.includes(experienceId as UUID)) {
        impact += exp.importance;
      }
    }

    // Add impact from relationships
    const relationships = this.findRelationships(experienceId);
    for (const rel of relationships) {
      if (rel.type === "causes") {
        impact += rel.strength;
      }
    }

    return impact;
  }
}

function tokenizeLearning(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((token) => token.length > 2 && !CONTENT_STOP_WORDS.has(token)) ??
      [],
  );
}
