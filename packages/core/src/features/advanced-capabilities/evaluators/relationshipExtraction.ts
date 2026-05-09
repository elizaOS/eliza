import { logger } from "../../../logger.ts";
import type { RelationshipsService } from "../../../services/relationships.ts";
import type {
	Action,
	ActionResult,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import { ActionMode } from "../../../types/index.ts";

interface PlatformIdentity {
	platform: string;
	handle: string;
	verified: boolean;
	confidence: number;
	source?: UUID;
	timestamp: number;
}

const relationshipExtractionValidate = async (
	_runtime: IAgentRuntime,
	message: Memory,
	_state?: State,
): Promise<boolean> => {
	return !!(message.content?.text && message.content.text.length > 0);
};

const relationshipExtractionHandler = async (
	runtime: IAgentRuntime,
	message: Memory,
	_state?: State,
): Promise<ActionResult | undefined> => {
	const relationshipsService = runtime.getService(
		"relationships",
	) as RelationshipsService;
	if (!relationshipsService) {
		logger.warn("[RelationshipExtraction] RelationshipsService not available");
		return;
	}

	if (!message.content?.text) {
		return;
	}

	const identities = extractPlatformIdentities(message.content.text);
	if (identities.length > 0) {
		await storePlatformIdentities(runtime, message.entityId, identities);
		await upsertEntityIdentities(
			relationshipsService,
			message.entityId,
			identities,
			message.id ? [message.id] : [],
		);
	}

	logger.info(
		{
			src: "plugin:advanced-capabilities:evaluator:relationship_extraction",
			agentId: runtime.agentId,
			messageId: message.id,
			identitiesFound: identities.length,
		},
		"Completed identity scrape for message",
	);

	return {
		success: true,
		values: {
			identitiesFound: identities.length,
		},
		data: {
			identitiesCount: identities.length,
		},
		text: `Extracted ${identities.length} platform identities.`,
	};
};

/**
 * Pre-message regex scrape for platform identity handles
 * (twitter / github / telegram / discord) mentioned by the speaker. Records
 * any new identities to the entity_identities table via RelationshipsService.
 *
 * Semantic relationship analysis (sentiment, dispute / privacy detection,
 * mentioned-people inference, admin updates, trust scoring) was folded into
 * the consolidated post-response REFLECTION action, where one LLM call
 * handles all of it. Only deterministic regex identity extraction remains
 * here.
 */
export const relationshipExtractionAction: Action = {
	name: "RELATIONSHIP_EXTRACTION",
	description:
		"Pre-message regex scrape for platform identity handles (twitter/github/telegram/discord) mentioned by the speaker. Records new identities to the entity_identities table via RelationshipsService.",
	similes: ["IDENTITY_SCRAPE", "PLATFORM_HANDLE_EXTRACTOR"],
	mode: ActionMode.ALWAYS_BEFORE,
	modePriority: 50,
	examples: [],
	validate: relationshipExtractionValidate as Action["validate"],
	handler: relationshipExtractionHandler as Action["handler"],
};

function extractPlatformIdentities(text: string): PlatformIdentity[] {
	const now = Date.now();
	const identities = new Map<string, PlatformIdentity>();
	const addIdentity = (
		platform: string,
		handle: string | undefined,
		confidence: number,
	) => {
		const normalizedHandle = handle?.trim();
		if (!normalizedHandle) {
			return;
		}
		const key = `${platform}:${normalizedHandle.toLowerCase()}`;
		const existing = identities.get(key);
		if (existing && existing.confidence >= confidence) {
			return;
		}
		identities.set(key, {
			platform,
			handle: normalizedHandle,
			verified: false,
			confidence,
			timestamp: now,
		});
	};

	const collectMatches = (
		pattern: RegExp,
		platform: string,
		confidence: number,
	) => {
		let match = pattern.exec(text);
		while (match !== null) {
			addIdentity(platform, match[1] ?? match[2], confidence);
			match = pattern.exec(text);
		}
	};

	collectMatches(
		/(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})|(?:\bon\s+(?:x|twitter)\b|\bmy\s+(?:x|twitter)\s+is\b|\b(?:x|twitter)(?:\s+(?:username|handle))?\s*(?:[:=-]|is)\b)\s*@?([A-Za-z0-9_]{1,15})/gi,
		"twitter",
		0.8,
	);
	collectMatches(
		/(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)|(?:\bmy\s+github\s+is\b|\bgithub(?:\s+(?:username|handle))?\s*(?:[:=-]|is)\b)\s*@?([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)/gi,
		"github",
		0.85,
	);
	collectMatches(
		/(?:\bmy\s+telegram\s+is\b|\btelegram(?:\s+(?:username|handle))?\s*(?:[:=-]|is)\b)\s*(@[A-Za-z][A-Za-z0-9_]{3,31})/gi,
		"telegram",
		0.8,
	);
	collectMatches(
		/(?:\bmy\s+discord\s+is\b|\bdiscord(?:\s+(?:username|handle|tag))?\s*(?:[:=-]|is)\b)\s*([A-Za-z0-9_.]{2,32}(?:#\d{4})?)/gi,
		"discord",
		0.8,
	);

	return Array.from(identities.values());
}

async function storePlatformIdentities(
	runtime: IAgentRuntime,
	entityId: UUID,
	identities: PlatformIdentity[],
) {
	const entity = await runtime.getEntityById(entityId);
	if (!entity) return;

	const metadata = entity.metadata || {};
	const rawIdentities = metadata.platformIdentities;
	const platformIdentities = (
		Array.isArray(rawIdentities) ? rawIdentities : []
	) as Array<Record<string, unknown>>;
	const existingByKey = new Map<string, Record<string, unknown>>();
	for (const identity of platformIdentities) {
		const key = `${identity.platform ?? ""}|${identity.handle ?? ""}`;
		if (key !== "|") {
			existingByKey.set(key, identity);
		}
	}

	for (const identity of identities) {
		const identityRecord: Record<string, unknown> = {
			platform: identity.platform,
			handle: identity.handle,
			verified: identity.verified,
			confidence: identity.confidence,
			source: entityId,
			timestamp: identity.timestamp,
		};

		const identityKey = `${identity.platform}|${identity.handle}`;
		const existing = existingByKey.get(identityKey);

		if (!existing) {
			existingByKey.set(identityKey, identityRecord);
			platformIdentities.push(identityRecord);
		} else if ((existing.confidence as number) < identity.confidence) {
			Object.assign(existing, identityRecord);
		}
	}

	metadata.platformIdentities = platformIdentities as Array<{
		[key: string]: string | number | boolean | null | undefined;
	}>;
	await runtime.updateEntity({ ...entity, metadata });
}

/**
 * Persist extracted platform identities to the strengthened
 * `entity_identities` table via RelationshipsService. Each call records
 * provenance (the message id that triggered the observation) so we can
 * rebuild an evidence trail later.
 */
async function upsertEntityIdentities(
	relationshipsService: RelationshipsService,
	entityId: UUID,
	identities: PlatformIdentity[],
	evidenceMessageIds: UUID[],
): Promise<void> {
	if (typeof relationshipsService.upsertIdentity !== "function") {
		return;
	}
	for (const identity of identities) {
		await relationshipsService.upsertIdentity(
			entityId,
			{
				platform: identity.platform,
				handle: identity.handle,
				verified: identity.verified,
				confidence: identity.confidence,
				source: "relationship_extraction",
			},
			evidenceMessageIds,
		);
	}
}
