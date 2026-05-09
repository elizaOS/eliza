import { logger } from "../../../logger.ts";
import {
	type Component,
	type IAgentRuntime,
	type Metadata,
	type MetadataValue,
	Service,
	type UUID,
} from "../../../types/index.ts";
import { stringToUuid } from "../../../utils.ts";

import {
	type TrustCalculationConfig,
	type TrustContext,
	type TrustDecision,
	type TrustDimensions,
	type TrustEvidence,
	TrustEvidenceType,
	type TrustInteraction,
	type TrustProfile,
	type TrustRequirements,
} from "../types/trust.ts";

import { getDb } from "./db.ts";
import { getTrustEvidence, insertTrustEvidence } from "./SecurityStore.ts";

/**
 * Default configuration for trust calculations
 */
const DEFAULT_CONFIG: TrustCalculationConfig = {
	recencyBias: 0.7,
	evidenceDecayRate: 0.5, // Points per day
	minimumEvidenceCount: 3,
	verificationMultiplier: 1.5,
	dimensionWeights: {
		reliability: 0.25,
		competence: 0.2,
		integrity: 0.25,
		benevolence: 0.2,
		transparency: 0.1,
	},
};

const TRUST_EVIDENCE_TYPE_VALUES = new Set<string>(
	Object.values(TrustEvidenceType),
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTrustEvidenceType(value: unknown): value is TrustEvidenceType {
	return typeof value === "string" && TRUST_EVIDENCE_TYPE_VALUES.has(value);
}

function isUuidValue(value: unknown): value is UUID {
	return typeof value === "string";
}

function isTrustDimensions(value: unknown): value is TrustDimensions {
	return (
		isRecord(value) &&
		typeof value.reliability === "number" &&
		typeof value.competence === "number" &&
		typeof value.integrity === "number" &&
		typeof value.benevolence === "number" &&
		typeof value.transparency === "number"
	);
}

function isTrustContext(value: unknown): value is TrustContext {
	return isRecord(value) && isUuidValue(value.evaluatorId);
}

function isTrustEvidence(value: unknown): value is TrustEvidence {
	return (
		isRecord(value) &&
		isTrustEvidenceType(value.type) &&
		typeof value.timestamp === "number" &&
		typeof value.impact === "number" &&
		typeof value.weight === "number" &&
		typeof value.description === "string" &&
		isUuidValue(value.reportedBy) &&
		typeof value.verified === "boolean" &&
		isTrustContext(value.context) &&
		isUuidValue(value.targetEntityId) &&
		isUuidValue(value.evaluatorId)
	);
}

function isTrustProfile(value: unknown): value is TrustProfile {
	if (!isRecord(value)) return false;
	const trend = value.trend;
	return (
		isUuidValue(value.entityId) &&
		isTrustDimensions(value.dimensions) &&
		typeof value.overallTrust === "number" &&
		typeof value.confidence === "number" &&
		typeof value.interactionCount === "number" &&
		Array.isArray(value.evidence) &&
		value.evidence.every(isTrustEvidence) &&
		typeof value.lastCalculated === "number" &&
		typeof value.calculationMethod === "string" &&
		isRecord(trend) &&
		(trend.direction === "increasing" ||
			trend.direction === "decreasing" ||
			trend.direction === "stable") &&
		typeof trend.changeRate === "number" &&
		typeof trend.lastChangeAt === "number" &&
		isUuidValue(value.evaluatorId)
	);
}

function toMetadataValue(value: unknown): MetadataValue {
	if (
		value === null ||
		value === undefined ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(toMetadataValue);
	}
	if (isRecord(value)) {
		const metadata: Metadata = {};
		for (const [key, nestedValue] of Object.entries(value)) {
			metadata[key] = toMetadataValue(nestedValue);
		}
		return metadata;
	}
	return String(value);
}

function trustEvidenceToMetadata(evidence: TrustEvidence): Metadata {
	return {
		type: evidence.type,
		timestamp: evidence.timestamp,
		impact: evidence.impact,
		weight: evidence.weight,
		description: evidence.description,
		reportedBy: evidence.reportedBy,
		verified: evidence.verified,
		context: toMetadataValue(evidence.context),
		targetEntityId: evidence.targetEntityId,
		evaluatorId: evidence.evaluatorId,
		metadata: toMetadataValue(evidence.metadata),
	};
}

function trustProfileToMetadata(profile: TrustProfile): Metadata {
	return {
		entityId: profile.entityId,
		dimensions: {
			reliability: profile.dimensions.reliability,
			competence: profile.dimensions.competence,
			integrity: profile.dimensions.integrity,
			benevolence: profile.dimensions.benevolence,
			transparency: profile.dimensions.transparency,
		},
		overallTrust: profile.overallTrust,
		confidence: profile.confidence,
		interactionCount: profile.interactionCount,
		evidence: profile.evidence.map(trustEvidenceToMetadata),
		lastCalculated: profile.lastCalculated,
		calculationMethod: profile.calculationMethod,
		trend: {
			direction: profile.trend.direction,
			changeRate: profile.trend.changeRate,
			lastChangeAt: profile.trend.lastChangeAt,
		},
		evaluatorId: profile.evaluatorId,
	};
}

/**
 * Evidence impact mapping for different evidence types
 */
const EVIDENCE_IMPACT_MAP: Record<
	TrustEvidenceType,
	{ dimensions: Partial<TrustDimensions>; baseImpact: number }
> = {
	// Positive evidence
	[TrustEvidenceType.PROMISE_KEPT]: {
		dimensions: { reliability: 15, integrity: 10 },
		baseImpact: 10,
	},
	[TrustEvidenceType.HELPFUL_ACTION]: {
		dimensions: { benevolence: 15, competence: 10 },
		baseImpact: 8,
	},
	[TrustEvidenceType.CONSISTENT_BEHAVIOR]: {
		dimensions: { reliability: 20, transparency: 10 },
		baseImpact: 12,
	},
	[TrustEvidenceType.VERIFIED_IDENTITY]: {
		dimensions: { transparency: 20, integrity: 10 },
		baseImpact: 15,
	},
	[TrustEvidenceType.COMMUNITY_CONTRIBUTION]: {
		dimensions: { benevolence: 20, competence: 15 },
		baseImpact: 12,
	},
	[TrustEvidenceType.SUCCESSFUL_TRANSACTION]: {
		dimensions: { reliability: 15, competence: 15 },
		baseImpact: 10,
	},

	// Negative evidence
	[TrustEvidenceType.PROMISE_BROKEN]: {
		dimensions: { reliability: -25, integrity: -15 },
		baseImpact: -15,
	},
	[TrustEvidenceType.HARMFUL_ACTION]: {
		dimensions: { benevolence: -30, integrity: -20 },
		baseImpact: -20,
	},
	[TrustEvidenceType.INCONSISTENT_BEHAVIOR]: {
		dimensions: { reliability: -20, transparency: -15 },
		baseImpact: -12,
	},
	[TrustEvidenceType.SUSPICIOUS_ACTIVITY]: {
		dimensions: { integrity: -15, transparency: -20 },
		baseImpact: -15,
	},
	[TrustEvidenceType.FAILED_VERIFICATION]: {
		dimensions: { transparency: -25, integrity: -10 },
		baseImpact: -10,
	},
	[TrustEvidenceType.SPAM_BEHAVIOR]: {
		dimensions: { benevolence: -15, competence: -10 },
		baseImpact: -10,
	},
	[TrustEvidenceType.SECURITY_VIOLATION]: {
		dimensions: { integrity: -35, reliability: -20 },
		baseImpact: -25,
	},

	// Neutral evidence
	[TrustEvidenceType.IDENTITY_CHANGE]: {
		dimensions: { transparency: -5 },
		baseImpact: 0,
	},
	[TrustEvidenceType.ROLE_CHANGE]: {
		dimensions: {},
		baseImpact: 0,
	},
	[TrustEvidenceType.CONTEXT_SWITCH]: {
		dimensions: {},
		baseImpact: 0,
	},
};

export class TrustEngine extends Service {
	static serviceType = "trust-engine:core" as const;

	capabilityDescription =
		"Multi-dimensional trust scoring and evaluation system";

	private static readonly ACTION_CONTEXT_WEIGHTS: Record<
		string,
		Partial<TrustCalculationConfig["dimensionWeights"]>
	> = {
		financial: {
			integrity: 0.35,
			reliability: 0.3,
			competence: 0.15,
			benevolence: 0.1,
			transparency: 0.1,
		},
		moderation: {
			benevolence: 0.3,
			integrity: 0.25,
			competence: 0.2,
			reliability: 0.15,
			transparency: 0.1,
		},
		content_creation: {
			competence: 0.3,
			integrity: 0.2,
			reliability: 0.2,
			benevolence: 0.15,
			transparency: 0.15,
		},
	};

	private trustConfig: TrustCalculationConfig;
	private profileCache: Map<string, TrustProfile> = new Map();
	private readonly cacheTimeout = 5 * 60 * 1000; // 5 minutes
	private readonly maxInteractionsInMemory = 500;
	private interactions: TrustInteraction[] = [];
	private rateLimits: Map<
		string,
		{ count: number; windowStart: number; typeHistory: Map<string, number> }
	> = new Map();
	private readonly maxEvidencePerHour = 10;

	constructor(config?: Partial<TrustCalculationConfig>) {
		super();
		this.trustConfig = { ...DEFAULT_CONFIG, ...config };
	}

	async initialize(runtime: IAgentRuntime): Promise<void> {
		this.runtime = runtime;
		logger.info(
			{ trustConfig: this.trustConfig },
			"[TrustEngine] Initialized with config:",
		);
	}

	async stop(): Promise<void> {
		this.profileCache.clear();
		logger.info("[TrustEngine] Stopped");
	}

	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new TrustEngine();
		await service.initialize(runtime);
		return service;
	}

	/**
	 * Calculate trust profile for an entity
	 */
	async calculateTrust(
		subjectId: UUID,
		context: TrustContext,
	): Promise<TrustProfile> {
		const cacheKey = `${context.evaluatorId}-${subjectId}`;

		// Check cache
		const cached = this.profileCache.get(cacheKey);
		if (cached && Date.now() - cached.lastCalculated < this.cacheTimeout) {
			return cached;
		}

		// Load evidence from components
		const evidence = await this.loadEvidence(subjectId, context);

		// Calculate dimensions
		const dimensions = this.calculateDimensions(evidence);

		// Resolve dimension weights (context-specific overrides or defaults)
		const baseWeights = this.trustConfig.dimensionWeights;
		const overrides = context.action
			? TrustEngine.ACTION_CONTEXT_WEIGHTS[context.action]
			: undefined;
		const activeWeights = overrides
			? {
					reliability: overrides.reliability ?? baseWeights.reliability,
					competence: overrides.competence ?? baseWeights.competence,
					integrity: overrides.integrity ?? baseWeights.integrity,
					benevolence: overrides.benevolence ?? baseWeights.benevolence,
					transparency: overrides.transparency ?? baseWeights.transparency,
				}
			: baseWeights;

		// Calculate overall trust with resolved weights
		const overallTrust = this.calculateOverallTrust(dimensions, activeWeights);

		// Calculate confidence
		const confidence = this.calculateConfidence(evidence);

		// Analyze trend
		const trend = await this.analyzeTrend(subjectId, context, overallTrust);

		const profile: TrustProfile = {
			entityId: subjectId,
			dimensions,
			overallTrust,
			confidence,
			interactionCount: evidence.length,
			evidence: evidence.slice(0, 100), // Keep most recent 100
			lastCalculated: Date.now(),
			calculationMethod: "dimensional_aggregation_v1",
			trend,
			evaluatorId: context.evaluatorId,
		};

		// Save to cache and storage
		this.profileCache.set(cacheKey, profile);
		await this.saveTrustProfile(profile, context);

		return profile;
	}

	/**
	 * Records a trust interaction
	 */
	async recordInteraction(interaction: TrustInteraction): Promise<void> {
		// Rate limit check
		const rateCheck = this.checkRateLimit(
			interaction.targetEntityId,
			interaction.type,
		);
		if (!rateCheck.allowed) {
			logger.warn(
				{ entityId: interaction.targetEntityId, type: interaction.type },
				"[TrustEngine] Rate limit exceeded, skipping interaction recording",
			);
			return;
		}

		// Apply diminishing returns weight to impact
		if (rateCheck.weight < 1.0) {
			interaction.impact = interaction.impact * rateCheck.weight;
		}

		this.interactions.push(interaction);
		// Trim in-memory interactions to prevent unbounded growth
		if (this.interactions.length > this.maxInteractionsInMemory) {
			this.interactions = this.interactions.slice(
				-this.maxInteractionsInMemory,
			);
		}

		// Invalidate cache entries for the affected entity
		for (const key of this.profileCache.keys()) {
			if (key.endsWith(`-${interaction.targetEntityId}`)) {
				this.profileCache.delete(key);
			}
		}

		logger.info(
			{
				type: interaction.type,
				impact: interaction.impact,
				source: interaction.sourceEntityId,
				target: interaction.targetEntityId,
			},
			"[TrustEngine] Recorded interaction:",
		);

		// Persist to database
		try {
			const db = getDb(this.runtime);
			await insertTrustEvidence(db, {
				targetEntityId: interaction.targetEntityId,
				sourceEntityId: interaction.sourceEntityId,
				evaluatorId: interaction.context?.evaluatorId || this.runtime.agentId,
				type: interaction.type,
				impact: interaction.impact,
				weight: rateCheck.weight,
				description: interaction.details?.description || "",
				verified: true,
				context: (interaction.context ?? {}) as Record<string, unknown>,
			});
		} catch (err: unknown) {
			logger.warn(
				{ error: err },
				"[TrustEngine] Failed to persist trust evidence to DB",
			);
		}
	}

	/**
	 * Evaluate if an action is allowed based on trust
	 */
	async evaluateTrustDecision(
		entityId: UUID,
		requirements: TrustRequirements,
		context: TrustContext,
	): Promise<TrustDecision> {
		const profile = await this.calculateTrust(entityId, context);

		// Check overall trust
		if (profile.overallTrust < requirements.minimumTrust) {
			return {
				allowed: false,
				trustScore: profile.overallTrust,
				requiredScore: requirements.minimumTrust,
				dimensionsChecked: profile.dimensions,
				reason: `Trust score ${profile.overallTrust} is below required ${requirements.minimumTrust}`,
				suggestions: this.generateTrustBuildingSuggestions(
					profile,
					requirements,
				),
			};
		}

		// Check specific dimensions
		if (requirements.dimensions) {
			for (const [dimension, required] of Object.entries(
				requirements.dimensions,
			)) {
				const actual = profile.dimensions[dimension as keyof TrustDimensions];
				if (actual < required) {
					return {
						allowed: false,
						trustScore: profile.overallTrust,
						requiredScore: requirements.minimumTrust,
						dimensionsChecked: requirements.dimensions,
						reason: `${dimension} score ${actual} is below required ${required}`,
						suggestions: this.generateDimensionSuggestions(
							dimension as keyof TrustDimensions,
						),
					};
				}
			}
		}

		// Check interaction count
		if (
			requirements.minimumInteractions &&
			profile.interactionCount < requirements.minimumInteractions
		) {
			return {
				allowed: false,
				trustScore: profile.overallTrust,
				requiredScore: requirements.minimumTrust,
				dimensionsChecked: profile.dimensions,
				reason: `Insufficient interactions: ${profile.interactionCount} < ${requirements.minimumInteractions}`,
				suggestions: ["Engage in more interactions to build history"],
			};
		}

		// Check confidence
		if (
			requirements.minimumConfidence &&
			profile.confidence < requirements.minimumConfidence
		) {
			return {
				allowed: false,
				trustScore: profile.overallTrust,
				requiredScore: requirements.minimumTrust,
				dimensionsChecked: profile.dimensions,
				reason: `Trust confidence ${profile.confidence} is below required ${requirements.minimumConfidence}`,
				suggestions: [
					"More consistent interactions needed to increase confidence",
				],
			};
		}

		return {
			allowed: true,
			trustScore: profile.overallTrust,
			requiredScore: requirements.minimumTrust,
			dimensionsChecked: profile.dimensions,
			reason: "All trust requirements met",
		};
	}

	/**
	 * Check rate limiting for evidence recording
	 */
	private static readonly DIMINISHING_WEIGHTS = [1.0, 0.75, 0.5, 0.25] as const;

	private checkRateLimit(
		entityId: UUID,
		evidenceType: TrustEvidenceType,
	): { allowed: boolean; weight: number } {
		const now = Date.now();
		const hourMs = 60 * 60 * 1000;

		let entry = this.rateLimits.get(entityId);
		if (!entry) {
			entry = { count: 0, windowStart: now, typeHistory: new Map() };
			this.rateLimits.set(entityId, entry);
		}

		// Reset window if more than 1 hour has passed
		if (now - entry.windowStart > hourMs) {
			entry.count = 0;
			entry.windowStart = now;
			entry.typeHistory.clear();
			// Prune stale entries from other entities while we're here
			for (const [key, val] of this.rateLimits) {
				if (now - val.windowStart > hourMs * 2) this.rateLimits.delete(key);
			}
		}

		if (entry.count >= this.maxEvidencePerHour) {
			return { allowed: false, weight: 0 };
		}

		// Diminishing returns: 1st occurrence = 1.0, 2nd = 0.75, 3rd = 0.5, 4th+ = 0.25
		const typeCount = entry.typeHistory.get(evidenceType) ?? 0;
		const weight =
			TrustEngine.DIMINISHING_WEIGHTS[
				Math.min(typeCount, TrustEngine.DIMINISHING_WEIGHTS.length - 1)
			];

		entry.count++;
		entry.typeHistory.set(evidenceType, typeCount + 1);

		return { allowed: true, weight };
	}

	/**
	 * Calculate trust dimensions from evidence
	 */
	private calculateDimensions(evidence: TrustEvidence[]): TrustDimensions {
		const dimensions: TrustDimensions = {
			reliability: 50,
			competence: 50,
			integrity: 50,
			benevolence: 50,
			transparency: 50,
		};

		for (const ev of evidence) {
			const impact = EVIDENCE_IMPACT_MAP[ev.type];
			if (!impact) continue;

			// Apply age weight
			const ageWeight = this.calculateAgeWeight(ev.timestamp);

			// Apply verification multiplier
			const verificationMultiplier = ev.verified
				? this.trustConfig.verificationMultiplier
				: 1.0;

			// Update dimensions
			for (const [dimension, value] of Object.entries(impact.dimensions)) {
				const adjustedValue =
					value * ev.weight * ageWeight * verificationMultiplier;
				dimensions[dimension as keyof TrustDimensions] = Math.max(
					0,
					Math.min(
						100,
						dimensions[dimension as keyof TrustDimensions] + adjustedValue,
					),
				);
			}
		}

		return dimensions;
	}

	/**
	 * Calculate overall trust score from dimensions
	 */
	private calculateOverallTrust(
		dimensions: TrustDimensions,
		weights: TrustCalculationConfig["dimensionWeights"] = this.trustConfig
			.dimensionWeights,
	): number {
		let weightedSum = 0;
		let totalWeight = 0;

		for (const [dimension, value] of Object.entries(dimensions)) {
			const weight = weights[dimension as keyof TrustDimensions];
			weightedSum += value * weight;
			totalWeight += weight;
		}

		return Math.round(weightedSum / totalWeight);
	}

	/**
	 * Calculate confidence based on evidence quantity and consistency
	 */
	private calculateConfidence(evidence: TrustEvidence[]): number {
		if (evidence.length < this.trustConfig.minimumEvidenceCount) {
			return 0;
		}

		// Base confidence from evidence count
		const countConfidence = Math.min(1, evidence.length / 20);

		// Consistency factor - how consistent is the evidence?
		const positiveCount = evidence.filter((e) => e.impact > 0).length;
		const negativeCount = evidence.filter((e) => e.impact < 0).length;
		const consistency =
			1 - Math.abs(positiveCount - negativeCount) / evidence.length;

		// Recency factor - how recent is the evidence?
		const recentEvidence = evidence.filter(
			(e) => Date.now() - e.timestamp < 7 * 24 * 60 * 60 * 1000, // 7 days
		);
		const recencyFactor = recentEvidence.length / evidence.length;

		return countConfidence * 0.4 + consistency * 0.3 + recencyFactor * 0.3;
	}

	/**
	 * Calculate age weight for evidence based on recency
	 */
	private calculateAgeWeight(timestamp: number): number {
		const ageInDays = (Date.now() - timestamp) / (24 * 60 * 60 * 1000);
		const decayFactor = Math.exp(
			-this.trustConfig.evidenceDecayRate * ageInDays,
		);

		// Blend with recency bias
		return (
			this.trustConfig.recencyBias * decayFactor +
			(1 - this.trustConfig.recencyBias) * 0.5
		);
	}

	/**
	 * Analyze trust trend over time
	 */
	private async analyzeTrend(
		entityId: UUID,
		context: TrustContext,
		currentScore: number,
	): Promise<TrustProfile["trend"]> {
		// Load historical trust scores
		const components = await this.runtime.getComponents(entityId);
		const historicalProfiles = components
			.filter(
				(c) => c.type === "trust_profile" && c.agentId === context.evaluatorId,
			)
			.map((c) => c.data)
			.filter(isTrustProfile)
			.sort((a, b) => b.lastCalculated - a.lastCalculated)
			.slice(0, 10);

		if (historicalProfiles.length < 2) {
			return {
				direction: "stable",
				changeRate: 0,
				lastChangeAt: Date.now(),
			};
		}

		// Calculate trend
		const previousScore = historicalProfiles[0].overallTrust;
		const oldestScore =
			historicalProfiles[historicalProfiles.length - 1].overallTrust;
		const timeSpanDays =
			(Date.now() -
				historicalProfiles[historicalProfiles.length - 1].lastCalculated) /
			(24 * 60 * 60 * 1000);

		const changeRate = (currentScore - oldestScore) / timeSpanDays;

		let direction: "increasing" | "decreasing" | "stable";
		if (Math.abs(changeRate) < 0.5) {
			direction = "stable";
		} else if (changeRate > 0) {
			direction = "increasing";
		} else {
			direction = "decreasing";
		}

		return {
			direction,
			changeRate: Math.round(changeRate * 10) / 10,
			lastChangeAt:
				currentScore !== previousScore
					? Date.now()
					: historicalProfiles[0].trend?.lastChangeAt || Date.now(),
		};
	}

	/**
	 * Load evidence from storage
	 */
	private async loadEvidence(
		entityId: UUID,
		context: TrustContext,
	): Promise<TrustEvidence[]> {
		const components = await this.runtime.getComponents(entityId);

		const evidenceComponents = components.filter(
			(c) =>
				c.type === "trust_evidence" &&
				(!context.worldId || c.worldId === context.worldId) &&
				(!context.roomId || c.roomId === context.roomId),
		);

		const evidence: TrustEvidence[] = [];
		for (const component of evidenceComponents) {
			if (!isTrustEvidence(component.data)) {
				continue;
			}
			const ev = component.data;

			// Apply time window filter
			if (context.timeWindow) {
				if (
					ev.timestamp < context.timeWindow.start ||
					ev.timestamp > context.timeWindow.end
				) {
					continue;
				}
			}

			evidence.push(ev);
		}

		// Also load from DB and merge (deduplicate by timestamp+type)
		try {
			const db = getDb(this.runtime);
			const dbRows = await getTrustEvidence(db, entityId, context.evaluatorId);
			const existingKeys = new Set(
				evidence.map((e) => `${e.timestamp}-${e.type}`),
			);
			for (const row of dbRows) {
				const rowTimestamp =
					row.timestamp instanceof Date
						? row.timestamp.getTime()
						: (row.timestamp as number);
				const key = `${rowTimestamp}-${row.type as string}`;
				if (!existingKeys.has(key)) {
					evidence.push({
						type: row.type as TrustEvidenceType,
						timestamp: rowTimestamp,
						impact: row.impact as number,
						weight: (row.weight as number) ?? 1.0,
						description: (row.description as string) ?? "",
						reportedBy: row.sourceEntityId as UUID,
						targetEntityId: row.targetEntityId as UUID,
						verified: (row.verified as boolean) ?? false,
						context: (row.context as TrustContext) ?? {
							evaluatorId: context.evaluatorId,
						},
						evaluatorId: (row.evaluatorId as UUID) ?? context.evaluatorId,
					});
					existingKeys.add(key);
				}
			}
		} catch (err: unknown) {
			logger.warn(
				{ error: err },
				"[TrustEngine] Failed to load trust evidence from DB",
			);
		}

		return evidence.sort((a, b) => b.timestamp - a.timestamp);
	}

	/**
	 * Save trust profile to storage
	 */
	private async saveTrustProfile(
		profile: TrustProfile,
		context: TrustContext,
	): Promise<void> {
		const componentId = stringToUuid(
			`trust-profile-${profile.entityId}-${context.evaluatorId}`,
		);

		const worldId = context.worldId || stringToUuid("trust-world");
		await this.runtime.ensureWorldExists({
			id: worldId,
			name: "trust-world",
			agentId: this.runtime.agentId,
			messageServerId: stringToUuid("default"),
			metadata: {},
		});

		// Check if component already exists
		const existingComponent = await this.runtime.getComponent(
			profile.entityId,
			"trust_profile",
			worldId,
			context.evaluatorId,
		);

		const component: Component = {
			id: componentId,
			type: "trust_profile",
			agentId: context.evaluatorId,
			entityId: profile.entityId,
			roomId: context.roomId || stringToUuid("trust-global"),
			worldId,
			sourceEntityId: context.evaluatorId,
			data: trustProfileToMetadata(profile),
			createdAt: existingComponent?.createdAt || Date.now(),
		};

		if (existingComponent) {
			// Update existing component
			await this.runtime.updateComponent(component);
		} else {
			// Create new component
			await this.runtime.createComponent(component);
		}
	}

	/**
	 * Generate suggestions for building trust
	 */
	private generateTrustBuildingSuggestions(
		profile: TrustProfile,
		requirements: TrustRequirements,
	): string[] {
		const suggestions: string[] = [];

		// Overall trust suggestions
		if (profile.overallTrust < requirements.minimumTrust) {
			const gap = requirements.minimumTrust - profile.overallTrust;
			suggestions.push(
				`Build ${gap} more trust points through positive interactions`,
			);
		}

		// Dimension-specific suggestions
		const weakestDimension = Object.entries(profile.dimensions).sort(
			([, a], [, b]) => a - b,
		)[0][0];

		suggestions.push(
			...this.generateDimensionSuggestions(
				weakestDimension as keyof TrustDimensions,
			),
		);

		// Interaction count suggestions
		if (profile.interactionCount < 10) {
			suggestions.push("Engage in more conversations and activities");
		}

		return suggestions;
	}

	/**
	 * Generate suggestions for improving specific dimensions
	 */
	private generateDimensionSuggestions(
		dimension: keyof TrustDimensions,
	): string[] {
		const suggestions: Record<keyof TrustDimensions, string[]> = {
			reliability: [
				"Keep your promises and commitments",
				"Be consistent in your actions",
				"Follow through on what you say",
			],
			competence: [
				"Demonstrate your skills through helpful contributions",
				"Share valuable knowledge or resources",
				"Complete tasks successfully",
			],
			integrity: [
				"Be honest and transparent in your communications",
				"Admit mistakes when they happen",
				"Follow community guidelines consistently",
			],
			benevolence: [
				"Help other community members",
				"Show genuine interest in others' wellbeing",
				"Contribute positively to discussions",
			],
			transparency: [
				"Be open about your intentions",
				"Share information freely when appropriate",
				"Verify your identity on multiple platforms",
			],
		};

		return (
			suggestions[dimension] || [
				"Continue building trust through positive interactions",
			]
		);
	}

	/**
	 * Evaluates trust for an entity (simplified API for actions)
	 */
	async evaluateTrust(
		entityId: UUID,
		evaluatorId: UUID,
		context?: Partial<TrustContext>,
	): Promise<TrustProfile> {
		const fullContext: TrustContext = {
			evaluatorId,
			...context,
		};
		return this.calculateTrust(entityId, fullContext);
	}

	/**
	 * Get recent trust interactions for an entity
	 * @param daysBack Number of days to look back (default: 10)
	 */
	async getRecentInteractions(
		entityId: UUID,
		daysBack = 10,
	): Promise<TrustInteraction[]> {
		const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
		return this.interactions.filter(
			(i) =>
				(i.sourceEntityId === entityId || i.targetEntityId === entityId) &&
				i.timestamp > cutoff,
		);
	}
}
