import { v4 as uuidv4 } from "uuid";
import { logger } from "../../../logger.ts";
import { ModelType } from "../../../types/model.ts";
import type { JsonValue, UUID } from "../../../types/primitives.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import { Service, type ServiceTypeName } from "../../../types/service.ts";
import {
	type Experience,
	type ExperienceAnalysis,
	type ExperienceQuery,
	ExperienceServiceType,
	ExperienceType,
	OutcomeType,
} from "./types.ts";
import { ConfidenceDecayManager } from "./utils/confidenceDecay";
import { ExperienceRelationshipManager } from "./utils/experienceRelationships";

export class ExperienceService extends Service {
	static override serviceType: ServiceTypeName =
		ExperienceServiceType.EXPERIENCE as ServiceTypeName;
	override capabilityDescription =
		"Manages agent experiences, learning from successes and failures to improve future decisions";

	private experiences: Map<UUID, Experience> = new Map();
	private experiencesByDomain: Map<string, Set<UUID>> = new Map();
	private experiencesByType: Map<ExperienceType, Set<UUID>> = new Map();
	private dirtyExperiences: Set<UUID> = new Set();
	private persistTimer: ReturnType<typeof setInterval> | null = null;
	private decayManager: ConfidenceDecayManager;
	private relationshipManager: ExperienceRelationshipManager;

	constructor(runtime: IAgentRuntime) {
		super(runtime);
		this.decayManager = new ConfidenceDecayManager();
		this.relationshipManager = new ExperienceRelationshipManager();

		void this.loadExperiences();

		// Batch-persist dirty access counts every 60 seconds
		this.persistTimer = setInterval(() => {
			void this.persistDirtyExperiences();
		}, 60_000);
	}

	static async start(runtime: IAgentRuntime): Promise<ExperienceService> {
		const service = new ExperienceService(runtime);
		// loadExperiences is triggered in constructor
		return service;
	}

	private async loadExperiences(): Promise<void> {
		// Load experiences from the "experiences" table (same table we write to)
		const memories = await this.runtime.getMemories({
			entityId: this.runtime.agentId,
			tableName: "experiences",
		});

		for (const memory of memories) {
			const experienceData = memory.content.data as Partial<Experience> | null;
			if (experienceData?.id) {
				const memoryCreatedAt =
					typeof memory.createdAt === "number" ? memory.createdAt : Date.now();

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
					// Persisted memory rows keep the vector on the top-level Memory record.
					// Restoring it here preserves semantic recall across runtime restarts.
					embedding:
						Array.isArray(memory.embedding) && memory.embedding.length > 0
							? memory.embedding
							: experienceData.embedding,
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
		// Generate embedding for the experience (graceful fallback if unavailable)
		const embeddingText = `${experienceData.context} ${experienceData.action} ${experienceData.result} ${experienceData.learning}`;
		const runModel = this.runtime.useModel.bind(this.runtime);
		let embedding: number[] | undefined;
		try {
			const result = await runModel(ModelType.TEXT_EMBEDDING, {
				text: embeddingText,
			});
			// Validate the embedding is non-zero (some providers return zero vectors on error)
			if (
				Array.isArray(result) &&
				result.length > 0 &&
				result.some((v: number) => v !== 0)
			) {
				embedding = result;
			} else {
				logger.warn(
					"[ExperienceService] Embedding model returned empty/zero vector, storing without embedding",
				);
			}
		} catch (err) {
			logger.warn(
				`[ExperienceService] Embedding generation failed, storing without embedding: ${err}`,
			);
		}

		const now = Date.now();

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
			createdAt: now,
			updatedAt: now,
			accessCount: 0,
			lastAccessedAt: now,
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

		// Save to memory service
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

		logger.info(
			`[ExperienceService] Recorded experience: ${experience.id} (${experience.type})`,
		);

		return experience;
	}

	private async saveExperienceToMemory(experience: Experience): Promise<void> {
		const data: Record<string, JsonValue> = {
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
		};
		if (experience.lastAccessedAt !== undefined) {
			data.lastAccessedAt = experience.lastAccessedAt;
		}
		if (experience.relatedExperiences !== undefined) {
			data.relatedExperiences = experience.relatedExperiences;
		}
		if (experience.supersedes !== undefined) {
			data.supersedes = experience.supersedes;
		}
		if (experience.previousBelief !== undefined) {
			data.previousBelief = experience.previousBelief;
		}
		if (experience.correctedBelief !== undefined) {
			data.correctedBelief = experience.correctedBelief;
		}

		const memory = {
			id: experience.id,
			entityId: this.runtime.agentId,
			agentId: this.runtime.agentId,
			roomId: this.runtime.agentId,
			content: {
				text: `Experience: ${experience.learning}`,
				type: "experience",
				data,
			},
			createdAt: experience.createdAt,
		};

		await this.runtime.createMemory(memory, "experiences", true);
	}

	private async persistDirtyExperiences(): Promise<void> {
		if (this.dirtyExperiences.size === 0) return;

		const toSave = Array.from(this.dirtyExperiences);
		this.dirtyExperiences.clear();

		let saved = 0;
		for (const id of toSave) {
			const exp = this.experiences.get(id);
			if (exp) {
				try {
					await this.saveExperienceToMemory(exp);
					saved++;
				} catch {
					// Re-mark as dirty so it retries next cycle
					this.dirtyExperiences.add(id);
				}
			}
		}

		if (saved > 0) {
			logger.debug(`[ExperienceService] Persisted ${saved} dirty experiences`);
		}
	}

	async queryExperiences(query: ExperienceQuery): Promise<Experience[]> {
		let results: Experience[] = [];
		const limit = query.limit || 10;

		if (query.query) {
			// Semantic search path: over-fetch when filters will reduce the set
			const hasFilters = !!(
				query.type ||
				query.outcome ||
				query.domain ||
				(query.tags && query.tags.length > 0) ||
				query.minConfidence !== undefined ||
				query.minImportance !== undefined ||
				query.timeRange
			);
			const fetchLimit = hasFilters ? Math.max(limit * 5, 50) : limit;
			const candidates = this.applyFilters(
				await this.findSimilarExperiences(query.query, fetchLimit),
				query,
			);
			results = candidates.slice(0, limit);
		} else {
			// Non-semantic path: filter then sort by quality
			const candidates = this.applyFilters(
				Array.from(this.experiences.values()),
				query,
			);
			candidates.sort((a, b) => {
				const scoreA = this.decayManager.getDecayedConfidence(a) * a.importance;
				const scoreB = this.decayManager.getDecayedConfidence(b) * b.importance;
				return scoreB - scoreA;
			});
			results = candidates.slice(0, limit);
		}

		// Include related experiences if requested
		if (query.includeRelated) {
			const relatedIds = new Set<UUID>();
			for (const exp of results) {
				if (exp.relatedExperiences) {
					exp.relatedExperiences.forEach((id) => {
						relatedIds.add(id);
					});
				}
			}

			const related = Array.from(relatedIds)
				.map((id) => this.experiences.get(id))
				.filter((exp): exp is Experience => exp !== undefined)
				.filter((exp) => !results.some((r) => r.id === exp.id));

			results.push(...related);
		}

		// Update access counts and mark dirty for batch persistence
		for (const exp of results) {
			exp.accessCount++;
			exp.lastAccessedAt = Date.now();
			this.dirtyExperiences.add(exp.id);
		}

		return results;
	}

	/** Apply query filters (type, outcome, domain, tags, confidence, importance, timeRange). */
	private applyFilters(
		candidates: Experience[],
		query: ExperienceQuery,
	): Experience[] {
		let filtered = candidates;

		if (query.type) {
			const types = Array.isArray(query.type) ? query.type : [query.type];
			filtered = filtered.filter((e) => types.includes(e.type));
		}
		if (query.outcome) {
			filtered = filtered.filter((e) => e.outcome === query.outcome);
		}
		if (query.domain) {
			const domains = Array.isArray(query.domain)
				? query.domain
				: [query.domain];
			filtered = filtered.filter((e) => domains.includes(e.domain));
		}
		if (query.tags && query.tags.length > 0) {
			filtered = filtered.filter((e) =>
				query.tags?.some((t) => e.tags.includes(t)),
			);
		}
		if (query.minConfidence !== undefined) {
			const min = query.minConfidence;
			filtered = filtered.filter(
				(e) => this.decayManager.getDecayedConfidence(e) >= min,
			);
		}
		if (query.minImportance !== undefined) {
			const min = query.minImportance;
			filtered = filtered.filter((e) => e.importance >= min);
		}
		if (query.timeRange) {
			const { start, end } = query.timeRange;
			filtered = filtered.filter((e) => {
				if (start && e.createdAt < start) return false;
				if (end && e.createdAt > end) return false;
				return true;
			});
		}

		return filtered;
	}

	/**
	 * Find similar experiences using vector search + reranking.
	 *
	 * Reranking strategy:
	 *   Vector similarity is the dominant signal (70%) — an irrelevant experience
	 *   should never outrank a relevant one just because it has high confidence.
	 *   Quality signals (confidence, importance) act as tiebreakers among
	 *   similarly-relevant results (30% combined).
	 *
	 *   A minimum similarity threshold filters out noise so quality signals
	 *   can't promote genuinely irrelevant experiences.
	 */
	async findSimilarExperiences(text: string, limit = 5): Promise<Experience[]> {
		if (!text || this.experiences.size === 0) {
			return [];
		}

		const runModel = this.runtime.useModel.bind(this.runtime);
		let queryEmbedding: number[];
		try {
			queryEmbedding = await runModel(ModelType.TEXT_EMBEDDING, {
				text,
			});
			if (
				!Array.isArray(queryEmbedding) ||
				queryEmbedding.length === 0 ||
				queryEmbedding.every((v: number) => v === 0)
			) {
				logger.warn(
					"[ExperienceService] Query embedding is empty/zero, falling back to recency sort",
				);
				return this.fallbackSort(limit);
			}
		} catch {
			logger.warn(
				"[ExperienceService] Query embedding failed, falling back to recency sort",
			);
			return this.fallbackSort(limit);
		}

		// Minimum cosine similarity to be considered a candidate at all.
		// Prevents high-quality but irrelevant experiences from appearing.
		const SIMILARITY_FLOOR = 0.05;

		const scored: Array<{ experience: Experience; score: number }> = [];
		const now = Date.now();

		for (const experience of this.experiences.values()) {
			if (!experience.embedding) continue;

			const similarity = this.cosineSimilarity(
				queryEmbedding,
				experience.embedding,
			);
			if (similarity < SIMILARITY_FLOOR) continue;

			// --- Quality signals (all normalized 0-1) ---

			// Confidence with time-decay applied
			const decayedConfidence =
				this.decayManager.getDecayedConfidence(experience);

			// Smooth recency: half-life of 30 days, never goes to zero
			const ageDays = Math.max(
				0,
				(now - experience.createdAt) / (24 * 60 * 60 * 1000),
			);
			const recencyFactor = 1 / (1 + ageDays / 30);

			// Access frequency: log-scaled, capped at 1.0
			// ~0 at 0 accesses, ~0.33 at 1, ~0.66 at 3, ~1.0 at 9+
			const accessFactor = Math.min(
				1,
				Math.log2(experience.accessCount + 1) / Math.log2(10),
			);

			// Weighted quality score (0-1 range)
			const qualityScore =
				decayedConfidence * 0.45 +
				experience.importance * 0.35 +
				recencyFactor * 0.12 +
				accessFactor * 0.08;

			// Final reranking score: similarity dominates (70%), quality tiebreaks (30%)
			const rerankScore = similarity * 0.7 + qualityScore * 0.3;

			scored.push({ experience, score: rerankScore });
		}

		// Sort by combined reranking score (highest first)
		scored.sort((a, b) => b.score - a.score);
		const results = scored.slice(0, limit).map((item) => item.experience);

		for (const exp of results) {
			exp.accessCount++;
			exp.lastAccessedAt = now;
			this.dirtyExperiences.add(exp.id);
		}

		return results;
	}

	/** Fallback when embeddings are unavailable: sort by decayed confidence * importance. */
	private fallbackSort(limit: number): Experience[] {
		const all = Array.from(this.experiences.values());
		all.sort((a, b) => {
			const sa = this.decayManager.getDecayedConfidence(a) * a.importance;
			const sb = this.decayManager.getDecayedConfidence(b) * b.importance;
			return sb - sa;
		});
		return all.slice(0, limit);
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

		const learnings = experiences.map((exp) => exp.learning);
		const commonWords = this.findCommonPatterns(learnings);

		const avgConfidence =
			experiences.reduce((sum, exp) => sum + exp.confidence, 0) /
			experiences.length;
		const outcomeConsistency = this.calculateOutcomeConsistency(experiences);
		const reliability = (avgConfidence + outcomeConsistency) / 2;

		const alternatives = this.extractAlternatives(experiences);
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
					wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
				}
			}
		}

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

		return recommendations.slice(0, 5);
	}

	async stop(): Promise<void> {
		logger.info("[ExperienceService] Stopping...");

		// Stop the persistence timer
		if (this.persistTimer) {
			clearInterval(this.persistTimer);
			this.persistTimer = null;
		}

		// Final persist of all dirty experiences + full save
		const experiencesToSave = Array.from(this.experiences.values());
		let savedCount = 0;

		for (const experience of experiencesToSave) {
			try {
				await this.saveExperienceToMemory(experience);
				savedCount++;
			} catch (err) {
				logger.warn(
					`[ExperienceService] Failed to save experience ${experience.id}: ${err}`,
				);
			}
		}

		this.dirtyExperiences.clear();
		logger.info(`[ExperienceService] Saved ${savedCount} experiences`);
	}
}
