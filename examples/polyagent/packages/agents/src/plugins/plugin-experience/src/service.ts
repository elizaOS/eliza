import {
  type EventPayload,
  type IAgentRuntime,
  logger,
  ModelType,
  Service,
  type ServiceTypeName,
  type UUID,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import {
  type Experience,
  type ExperienceAnalysis,
  type ExperienceQuery,
  ExperienceServiceType,
  ExperienceType,
  OutcomeType,
} from "./types";
import { ConfidenceDecayManager } from "./utils/confidenceDecay";
import { ExperienceRelationshipManager } from "./utils/experienceRelationships";

export class ExperienceService extends Service {
  static override serviceType: ServiceTypeName =
    ExperienceServiceType.EXPERIENCE;
  override capabilityDescription =
    "Manages agent experiences, learning from successes and failures to improve future decisions";

  private experiences: Map<UUID, Experience> = new Map();
  private experiencesByDomain: Map<string, Set<UUID>> = new Map();
  private experiencesByType: Map<ExperienceType, Set<UUID>> = new Map();
  private maxExperiences = 10000; // Configurable limit - reverted to default
  private decayManager: ConfidenceDecayManager;
  private relationshipManager: ExperienceRelationshipManager;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.decayManager = new ConfidenceDecayManager();
    this.relationshipManager = new ExperienceRelationshipManager();
    this.loadExperiences();
  }

  static async start(runtime: IAgentRuntime): Promise<ExperienceService> {
    const service = new ExperienceService(runtime);
    // loadExperiences is called by constructor
    return service;
  }

  private async loadExperiences(): Promise<void> {
    // Load experiences from memory/knowledge service
    // Filter memories by checking content.type after fetching
    const allMemories = await this.runtime.getMemories({
      entityId: this.runtime.agentId,
      count: this.maxExperiences,
      tableName: "memories",
    });

    // Filter for experience type memories
    const memories = allMemories.filter((m) => m.content.type === "experience");

    for (const memory of memories) {
      const experienceData = memory.content.data as Partial<Experience> | null;
      if (experienceData?.id) {
        // Memory.createdAt is a number (timestamp) from @elizaos/core
        const memoryCreatedAt =
          typeof memory.createdAt === "number" ? memory.createdAt : Date.now();

        // Convert experienceData timestamps to numbers (they should already be numbers, but handle Date objects if present)
        const toTimestamp = (
          value: number | Date | undefined,
          fallback: number,
        ): number => {
          if (value === undefined) return fallback;
          if (typeof value === "number") return value;
          if (value instanceof Date) return value.getTime();
          return fallback;
        };

        const experience: Experience = {
          id: experienceData.id as UUID,
          agentId: this.runtime.agentId,
          type: experienceData.type || ExperienceType.LEARNING,
          outcome: experienceData.outcome || OutcomeType.NEUTRAL,
          context: experienceData.context || "",
          action: experienceData.action || "",
          result: experienceData.result || "",
          learning: experienceData.learning || "",
          domain: experienceData.domain || "general",
          tags: experienceData.tags || [],
          confidence: experienceData.confidence || 0.5,
          importance: experienceData.importance || 0.5,
          createdAt: toTimestamp(
            experienceData.createdAt as number | Date | undefined,
            memoryCreatedAt,
          ),
          updatedAt: toTimestamp(
            experienceData.updatedAt as number | Date | undefined,
            memoryCreatedAt,
          ),
          accessCount: experienceData.accessCount ?? 0,
          lastAccessedAt: toTimestamp(
            experienceData.lastAccessedAt as number | Date | undefined,
            memoryCreatedAt,
          ),
          embedding: experienceData.embedding,
          relatedExperiences: experienceData.relatedExperiences,
          supersedes: experienceData.supersedes,
          previousBelief: experienceData.previousBelief,
          correctedBelief: experienceData.correctedBelief,
        };

        this.experiences.set(experience.id, experience);

        // Update indexes
        if (!this.experiencesByDomain.has(experience.domain)) {
          this.experiencesByDomain.set(experience.domain, new Set());
        }
        this.experiencesByDomain.get(experience.domain)?.add(experience.id);

        if (!this.experiencesByType.has(experience.type)) {
          this.experiencesByType.set(experience.type, new Set());
        }
        this.experiencesByType.get(experience.type)?.add(experience.id);
      }
    }

    logger.info(
      `[ExperienceService] Loaded ${this.experiences.size} experiences from memory`,
    );
  }

  async recordExperience(
    experienceData: Partial<Experience>,
  ): Promise<Experience> {
    // Generate embedding for the experience
    const embeddingText = `${experienceData.context} ${experienceData.action} ${experienceData.result} ${experienceData.learning}`;
    const embedding = await this.runtime.useModel(
      ModelType.TEXT_EMBEDDING,
      embeddingText,
    );

    const experience: Experience = {
      id: uuidv4() as UUID,
      agentId: this.runtime.agentId,
      type: experienceData.type || ExperienceType.LEARNING,
      outcome: experienceData.outcome || OutcomeType.NEUTRAL,
      context: experienceData.context || "",
      action: experienceData.action || "",
      result: experienceData.result || "",
      learning: experienceData.learning || "",
      domain: experienceData.domain || "general",
      tags: experienceData.tags || [],
      confidence: experienceData.confidence || 0.5,
      importance: experienceData.importance || 0.5,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      accessCount: 0,
      lastAccessedAt: Date.now(),
      embedding,
      relatedExperiences: experienceData.relatedExperiences,
      supersedes: experienceData.supersedes,
      previousBelief: experienceData.previousBelief,
      correctedBelief: experienceData.correctedBelief,
    };

    // Store the experience
    this.experiences.set(experience.id, experience);

    // Update indexes
    if (!this.experiencesByDomain.has(experience.domain)) {
      this.experiencesByDomain.set(experience.domain, new Set());
    }
    this.experiencesByDomain.get(experience.domain)?.add(experience.id);

    if (!this.experiencesByType.has(experience.type)) {
      this.experiencesByType.set(experience.type, new Set());
    }
    this.experiencesByType.get(experience.type)?.add(experience.id);

    // Save to memory/knowledge service
    await this.saveExperienceToMemory(experience);

    // Check for contradictions and add relationships
    const allExperiences = Array.from(this.experiences.values());
    const contradictions = this.relationshipManager.findContradictions(
      experience,
      allExperiences,
    );

    for (const contradiction of contradictions) {
      this.relationshipManager.addRelationship({
        fromId: experience.id,
        toId: contradiction.id,
        type: "contradicts",
        strength: 0.8,
      });
    }

    // Prune if necessary
    if (this.experiences.size > this.maxExperiences) {
      await this.pruneOldExperiences();
    }

    // Emit event
    await this.runtime.emitEvent("EXPERIENCE_RECORDED", {
      runtime: this.runtime,
      source: "plugin-experience",
      experienceId: experience.id,
      eventType: "created",
      timestamp: experience.createdAt,
    } as unknown as EventPayload);

    logger.info(
      `[ExperienceService] Recorded experience: ${experience.id} (${experience.type})`,
    );

    return experience;
  }

  /**
   * Save experience to memory/knowledge service
   */
  private async saveExperienceToMemory(experience: Experience): Promise<void> {
    const memory = {
      id: experience.id,
      entityId: this.runtime.agentId, // Use agentId as entityId for experiences
      agentId: this.runtime.agentId,
      roomId: this.runtime.agentId, // Use agentId as roomId for experiences
      content: {
        text: `Experience: ${experience.learning}`,
        type: "experience",
        data: {
          id: experience.id,
          agentId: experience.agentId,
          type: experience.type,
          outcome: experience.outcome,
          context: experience.context,
          action: experience.action,
          result: experience.result,
          learning: experience.learning,
          domain: experience.domain,
          tags: experience.tags,
          confidence: experience.confidence,
          importance: experience.importance,
          createdAt: experience.createdAt,
          updatedAt: experience.updatedAt,
          accessCount: experience.accessCount,
          lastAccessedAt: experience.lastAccessedAt,
          embedding: experience.embedding,
          relatedExperiences: experience.relatedExperiences,
          supersedes: experience.supersedes,
          previousBelief: experience.previousBelief,
          correctedBelief: experience.correctedBelief,
        },
      },
      createdAt: experience.createdAt,
    };

    await this.runtime.createMemory(memory, "experiences", true);
  }

  async queryExperiences(query: ExperienceQuery): Promise<Experience[]> {
    let results: Experience[] = [];

    // If query string provided, use semantic search
    if (query.query) {
      const similarExperiences = await this.findSimilarExperiences(
        query.query,
        query.limit || 10,
      );
      let candidates = similarExperiences;

      // Apply additional filters to semantic search results
      // Apply additional filters to semantic results
      if (query.type) {
        const types = Array.isArray(query.type) ? query.type : [query.type];
        candidates = candidates.filter((exp) => types.includes(exp.type));
      }

      if (query.outcome) {
        candidates = candidates.filter((exp) => exp.outcome === query.outcome);
      }

      if (query.domain) {
        const domains = Array.isArray(query.domain)
          ? query.domain
          : [query.domain];
        candidates = candidates.filter((exp) => domains.includes(exp.domain));
      }

      if (query.tags && query.tags.length > 0) {
        candidates = candidates.filter((exp) =>
          query.tags?.some((tag) => exp.tags.includes(tag)),
        );
      }

      if (query.minConfidence !== undefined) {
        candidates = candidates.filter((exp) => {
          const decayedConfidence = this.decayManager.getDecayedConfidence(exp);
          return decayedConfidence >= query.minConfidence!;
        });
      }

      if (query.minImportance !== undefined) {
        candidates = candidates.filter(
          (exp) => exp.importance >= query.minImportance!,
        );
      }

      if (query.timeRange) {
        candidates = candidates.filter((exp) => {
          if (query.timeRange?.start && exp.createdAt < query.timeRange?.start)
            return false;
          if (query.timeRange?.end && exp.createdAt > query.timeRange?.end)
            return false;
          return true;
        });
      }

      results = candidates;

      // Sort by relevance (considering decayed confidence) - only if not semantic search
      if (!query.query) {
        candidates.sort((a, b) => {
          const scoreA =
            this.decayManager.getDecayedConfidence(a) * a.importance;
          const scoreB =
            this.decayManager.getDecayedConfidence(b) * b.importance;
          return scoreB - scoreA;
        });
      }
    } else {
      // Start with all experiences for non-semantic queries
      let candidates = Array.from(this.experiences.values());

      // Apply filters for non-semantic search
      if (query.type) {
        const types = Array.isArray(query.type) ? query.type : [query.type];
        candidates = candidates.filter((exp) => types.includes(exp.type));
      }

      if (query.outcome) {
        candidates = candidates.filter((exp) => exp.outcome === query.outcome);
      }

      if (query.domain) {
        const domains = Array.isArray(query.domain)
          ? query.domain
          : [query.domain];
        candidates = candidates.filter((exp) => domains.includes(exp.domain));
      }

      if (query.tags && query.tags.length > 0) {
        candidates = candidates.filter((exp) =>
          query.tags?.some((tag) => exp.tags.includes(tag)),
        );
      }

      if (query.minConfidence !== undefined) {
        candidates = candidates.filter((exp) => {
          const decayedConfidence = this.decayManager.getDecayedConfidence(exp);
          return decayedConfidence >= query.minConfidence!;
        });
      }

      if (query.minImportance !== undefined) {
        candidates = candidates.filter(
          (exp) => exp.importance >= query.minImportance!,
        );
      }

      if (query.timeRange) {
        candidates = candidates.filter((exp) => {
          if (query.timeRange?.start && exp.createdAt < query.timeRange?.start)
            return false;
          if (query.timeRange?.end && exp.createdAt > query.timeRange?.end)
            return false;
          return true;
        });
      }

      // Sort by relevance (considering decayed confidence)
      candidates.sort((a, b) => {
        const scoreA = this.decayManager.getDecayedConfidence(a) * a.importance;
        const scoreB = this.decayManager.getDecayedConfidence(b) * b.importance;
        return scoreB - scoreA;
      });

      // Apply limit
      results = candidates.slice(0, query.limit || 10);
    }

    // Include related experiences if requested
    if (query.includeRelated) {
      const relatedIds = new Set<UUID>();
      for (const exp of results) {
        if (exp.relatedExperiences) {
          exp.relatedExperiences.forEach((id) => relatedIds.add(id as UUID));
        }
      }

      const related = Array.from(relatedIds)
        .map((id) => this.experiences.get(id))
        .filter((exp): exp is Experience => exp !== undefined)
        .filter((exp) => !results.some((r) => r.id === exp.id));

      results.push(...related);
    }

    // Update access counts
    for (const exp of results) {
      exp.accessCount++;
      exp.lastAccessedAt = Date.now();
    }

    return results;
  }

  async findSimilarExperiences(
    text: string,
    limit: number = 5,
  ): Promise<Experience[]> {
    if (!text || this.experiences.size === 0) {
      return [];
    }

    // Generate embedding for the query text
    const queryEmbedding = await this.runtime.useModel(
      ModelType.TEXT_EMBEDDING,
      text,
    );

    // Calculate similarities
    const similarities: Array<{
      experience: Experience;
      similarity: number;
    }> = [];

    for (const experience of this.experiences.values()) {
      if (experience.embedding) {
        const similarity = this.cosineSimilarity(
          queryEmbedding,
          experience.embedding,
        );
        similarities.push({ experience, similarity });
      }
    }

    // Sort by similarity and return top results
    similarities.sort((a, b) => b.similarity - a.similarity);
    const results = similarities.slice(0, limit).map((item) => item.experience);

    // Update access counts
    for (const exp of results) {
      exp.accessCount++;
      exp.lastAccessedAt = Date.now();
    }

    return results;
  }

  async analyzeExperiences(
    domain?: string,
    type?: ExperienceType,
  ): Promise<ExperienceAnalysis> {
    const experiences = await this.queryExperiences({
      domain: domain ? [domain] : undefined,
      type: type ? [type] : undefined,
      limit: 100,
    });

    if (experiences.length === 0) {
      return {
        pattern: "No experiences found for analysis",
        frequency: 0,
        reliability: 0,
        alternatives: [],
        recommendations: [],
      };
    }

    // Analyze patterns
    const learnings = experiences.map((exp) => exp.learning);
    const commonWords = this.findCommonPatterns(learnings);

    // Calculate reliability based on consistency and confidence
    const avgConfidence =
      experiences.reduce((sum, exp) => sum + exp.confidence, 0) /
      experiences.length;
    const outcomeConsistency = this.calculateOutcomeConsistency(experiences);
    const reliability = (avgConfidence + outcomeConsistency) / 2;

    // Find alternatives
    const alternatives = this.extractAlternatives(experiences);

    // Generate recommendations
    const recommendations = this.generateRecommendations(
      experiences,
      reliability,
    );

    return {
      pattern:
        commonWords.length > 0
          ? `Common patterns: ${commonWords.join(", ")}`
          : "No clear patterns detected",
      frequency: experiences.length,
      reliability,
      alternatives,
      recommendations,
    };
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      const valueA = a[i] ?? 0;
      const valueB = b[i] ?? 0;
      dotProduct += valueA * valueB;
      normA += valueA * valueA;
      normB += valueB * valueB;
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private findCommonPatterns(texts: string[]): string[] {
    const wordFreq = new Map<string, number>();

    for (const text of texts) {
      const words = text.toLowerCase().split(/\s+/);
      for (const word of words) {
        if (word.length > 3) {
          // Skip short words
          wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
        }
      }
    }

    // Return words that appear in at least 30% of texts
    const threshold = texts.length * 0.3;
    return Array.from(wordFreq.entries())
      .filter(([_, count]) => count >= threshold)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  private calculateOutcomeConsistency(experiences: Experience[]): number {
    if (experiences.length === 0) return 0;

    const outcomeCounts = new Map<OutcomeType, number>();
    for (const exp of experiences) {
      outcomeCounts.set(exp.outcome, (outcomeCounts.get(exp.outcome) || 0) + 1);
    }

    const maxCount = Math.max(...outcomeCounts.values());
    return maxCount / experiences.length;
  }

  private extractAlternatives(experiences: Experience[]): string[] {
    const alternatives = new Set<string>();

    for (const exp of experiences) {
      if (exp.type === ExperienceType.CORRECTION && exp.correctedBelief) {
        alternatives.add(exp.correctedBelief);
      }
      if (
        exp.outcome === OutcomeType.NEGATIVE &&
        exp.learning.includes("instead")
      ) {
        // Extract alternative from learning
        const match = exp.learning.match(/instead\s+(.+?)(?:\.|$)/i);
        const alternative = match?.[1]?.trim();
        if (alternative) {
          alternatives.add(alternative);
        }
      }
    }

    return Array.from(alternatives).slice(0, 5);
  }

  private generateRecommendations(
    experiences: Experience[],
    reliability: number,
  ): string[] {
    const recommendations: string[] = [];

    if (reliability > 0.8) {
      recommendations.push("Continue using successful approaches");
      recommendations.push("Document and share these reliable methods");
    } else if (reliability > 0.6) {
      recommendations.push("Continue using successful approaches with caution");
      recommendations.push("Monitor for potential issues");
      recommendations.push("Consider backup strategies");
    } else if (reliability > 0.4) {
      recommendations.push("Review and improve current approaches");
      recommendations.push("Investigate failure patterns");
      recommendations.push("Consider alternative methods");
    } else {
      recommendations.push("Significant changes needed to current approach");
      recommendations.push("Analyze failure causes thoroughly");
      recommendations.push("Seek alternative solutions");
    }

    // Add specific recommendations based on patterns
    const failureTypes = new Map<string, number>();
    experiences
      .filter((e) => e.outcome === OutcomeType.NEGATIVE)
      .forEach((e) => {
        const key = e.learning.toLowerCase();
        failureTypes.set(key, (failureTypes.get(key) || 0) + 1);
      });

    if (failureTypes.size > 0) {
      const mostCommonFailure = Array.from(failureTypes.entries()).sort(
        (a, b) => b[1] - a[1],
      )[0];

      if (mostCommonFailure && mostCommonFailure[1] > 1) {
        recommendations.push(
          `Address recurring issue: ${mostCommonFailure[0]}`,
        );
      }
    }

    // Add domain-specific recommendations
    const domains = new Set(experiences.map((e) => e.domain));
    if (domains.has("shell")) {
      recommendations.push("Verify command syntax and permissions");
    }
    if (domains.has("coding")) {
      recommendations.push("Test thoroughly before deployment");
    }
    if (domains.has("network")) {
      recommendations.push("Implement retry logic and error handling");
    }

    return recommendations.slice(0, 5); // Limit to 5 recommendations
  }

  private async pruneOldExperiences(): Promise<void> {
    if (this.experiences.size <= this.maxExperiences) {
      return;
    }

    // Sort experiences by importance (ascending) and access count (ascending)
    const experienceArray = Array.from(this.experiences.values());
    experienceArray.sort((a, b) => {
      // First sort by importance
      if (a.importance !== b.importance) {
        return a.importance - b.importance;
      }
      // Then by access count
      if (a.accessCount !== b.accessCount) {
        return a.accessCount - b.accessCount;
      }
      // Finally by age (older first)
      return a.createdAt - b.createdAt;
    });

    // Remove the least important experiences
    const toRemove = experienceArray.slice(
      0,
      experienceArray.length - this.maxExperiences,
    );
    let removedCount = 0;

    for (const experience of toRemove) {
      this.experiences.delete(experience.id);

      // Remove from domain index
      const domainSet = this.experiencesByDomain.get(experience.domain);
      if (domainSet) {
        domainSet.delete(experience.id);
        if (domainSet.size === 0) {
          this.experiencesByDomain.delete(experience.domain);
        }
      }

      // Remove from type index
      const typeSet = this.experiencesByType.get(experience.type);
      if (typeSet) {
        typeSet.delete(experience.id);
        if (typeSet.size === 0) {
          this.experiencesByType.delete(experience.type);
        }
      }

      removedCount++;
    }

    logger.info(`[ExperienceService] Pruned ${removedCount} old experiences`);
  }

  async stop(): Promise<void> {
    logger.info("[ExperienceService] Stopping...");

    // Save all experiences to memory
    const experiencesToSave = Array.from(this.experiences.values());
    let savedCount = 0;

    for (const experience of experiencesToSave) {
      await this.saveExperienceToMemory(experience);
      savedCount++;
    }

    logger.info(`[ExperienceService] Saved ${savedCount} experiences`);
  }
}
