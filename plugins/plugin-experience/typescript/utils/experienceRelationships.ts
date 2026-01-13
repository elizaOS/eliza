import type { UUID } from "@elizaos/core";
import type { Experience, JsonObject } from "../types";
import { ExperienceType, OutcomeType } from "../types";

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
  metadata?: JsonObject;
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

  findRelationships(experienceId: string, type?: string): ExperienceRelationship[] {
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

    // Look for sequences where validation follows hypothesis
    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i];
      if (!current) {
        continue;
      }

      if (current.type === ExperienceType.HYPOTHESIS) {
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
          if (next.relatedExperiences?.includes(current.id) || this.isRelated(current, next)) {
            chain.push(next.id);

            // If we found a validation, create a chain
            if (next.type === ExperienceType.VALIDATION) {
              chains.push({
                rootExperience: current.id,
                chain,
                strength: next.confidence,
                validated: next.outcome === OutcomeType.POSITIVE,
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
    // Simple keyword overlap for now
    const words1 = new Set(exp1.learning.toLowerCase().split(/\s+/));
    const words2 = new Set(exp2.learning.toLowerCase().split(/\s+/));

    const intersection = new Set([...words1].filter((x) => words2.has(x)));
    const union = new Set([...words1, ...words2]);

    return intersection.size / union.size;
  }

  findContradictions(experience: Experience, allExperiences: Experience[]): Experience[] {
    const contradictions: Experience[] = [];

    for (const other of allExperiences) {
      if (other.id === experience.id) continue;

      // Same action, different outcome
      if (
        other.action === experience.action &&
        other.outcome !== experience.outcome &&
        other.domain === experience.domain
      ) {
        contradictions.push(other);
      }

      // Explicit contradiction relationship
      const rels = this.findRelationships(experience.id, "contradicts");
      if (rels.some((r) => r.toId === other.id)) {
        contradictions.push(other);
      }
    }

    return contradictions;
  }

  getExperienceImpact(experienceId: string, allExperiences: Experience[]): number {
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
