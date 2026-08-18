/**
 * Per-user profile context (timezone + location) stored on the sender's
 * Entity metadata under `metadata.userProfile`.
 *
 * Why this exists: the CURRENT_TIME provider previously fell back to the
 * runtime HOST timezone whenever the turn carried no device hint
 * (`uiTimeZone`) and no agent-level TIMEZONE setting. On a UTC server that
 * rendered UTC wall-clock as "the" time, and the model improvised timezone
 * arithmetic in chat ("8:35pm in brooklyn" when the user's local time was
 * 4:35pm EDT). The user's timezone is a property of the USER, not of the
 * host the agent happens to run on — so it needs a durable, deterministic
 * per-user home that the prompt path can read on every turn.
 *
 * Storage shape (Entity.metadata.userProfile):
 *   {
 *     timezone?: string;          // IANA zone, validated on write and read
 *     timezoneSource?: "explicit" | "learned";
 *     location?: string;          // free-text, e.g. "Brooklyn, NYC"
 *     locationSource?: "explicit" | "learned";
 *     updatedAt?: string;         // ISO
 *   }
 *
 * Precedence: an "explicit" value (set by the owner/operator, or legacy flat
 * `metadata.timezone` / `metadata.location` which are treated as explicit)
 * is never overwritten by a "learned" value. Learned values come from the
 * post-turn fact extractor's `structured_fields` on identity-category facts
 * about the sender ("I live in Brooklyn now"), so the newest learned claim
 * replaces the previous learned one — same slot semantics as
 * fact-supersession's location/timezone slot groups.
 */
import type {
	Entity,
	IAgentRuntime,
	Memory,
	MetadataValue,
	UUID,
} from "../../types/index.ts";

export type UserProfileSource = "explicit" | "learned";

export interface UserProfileContext {
	timezone?: string;
	timezoneSource?: UserProfileSource;
	location?: string;
	locationSource?: UserProfileSource;
	updatedAt?: string;
}

/** Structured-field keys that name the user's timezone (mirrors the
 * fact-supersession slot alias group). */
const TIMEZONE_FIELD_KEYS = ["timezone", "timeZone", "ianaTimezone"] as const;

/** Structured-field keys that name the user's location (mirrors the
 * fact-supersession slot alias group). */
const LOCATION_FIELD_KEYS = [
	"location",
	"city",
	"homeCity",
	"home_location",
] as const;

/**
 * Validate an IANA timezone identifier. Returns the trimmed zone name or
 * null. Never throws: profile metadata and extractor output are both
 * untrusted inputs for the prompt path.
 */
export function validIanaTimeZone(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const timeZone = value.trim();
	try {
		new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
		return timeZone;
	} catch {
		// error-policy:J3 profile/extractor data crosses a trust boundary; an
		// invalid IANA zone is rejected so it can never poison time rendering.
		return null;
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function readSource(value: unknown): UserProfileSource | undefined {
	return value === "explicit" || value === "learned" ? value : undefined;
}

/**
 * Read the user-profile context from an entity. Merges the canonical
 * `metadata.userProfile` object with legacy flat `metadata.timezone` /
 * `metadata.location` keys — flat keys were only ever set by hand, so they
 * count as explicit and win over stored learned values.
 */
export function readUserProfile(
	entity: Entity | null | undefined,
): UserProfileContext {
	const metadata = asRecord(entity?.metadata);
	if (!metadata) return {};
	const raw = asRecord(metadata.userProfile) ?? {};
	const profile: UserProfileContext = {};

	const storedTz = validIanaTimeZone(raw.timezone);
	if (storedTz) {
		profile.timezone = storedTz;
		profile.timezoneSource = readSource(raw.timezoneSource) ?? "explicit";
	}
	const storedLocation = readNonEmptyString(raw.location);
	if (storedLocation) {
		profile.location = storedLocation;
		profile.locationSource = readSource(raw.locationSource) ?? "explicit";
	}
	const updatedAt = readNonEmptyString(raw.updatedAt);
	if (updatedAt) profile.updatedAt = updatedAt;

	// Legacy flat keys: hand-set, therefore explicit, therefore they win.
	const flatTz = validIanaTimeZone(metadata.timezone);
	if (flatTz) {
		profile.timezone = flatTz;
		profile.timezoneSource = "explicit";
	}
	const flatLocation = readNonEmptyString(metadata.location);
	if (flatLocation) {
		profile.location = flatLocation;
		profile.locationSource = "explicit";
	}
	return profile;
}

/**
 * Load the sending user's profile context for a message. Returns null when
 * the runtime cannot resolve entities or the sender has no entity row —
 * callers must treat null as "profile unknown", never as UTC.
 */
export async function getSenderUserProfile(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<UserProfileContext | null> {
	const entityId = message.entityId;
	if (!entityId) return null;
	if (typeof runtime.getEntityById !== "function") return null;
	try {
		const entity = await runtime.getEntityById(entityId);
		if (!entity) return null;
		const profile = readUserProfile(entity);
		return Object.keys(profile).length > 0 ? profile : null;
	} catch {
		// error-policy:J3 a failed entity lookup degrades to "profile unknown";
		// time rendering must stay available on every turn.
		return null;
	}
}

function firstTimezoneField(
	fields: Record<string, unknown>,
): string | null {
	for (const key of TIMEZONE_FIELD_KEYS) {
		const candidate = validIanaTimeZone(fields[key]);
		if (candidate) return candidate;
	}
	return null;
}

function firstLocationField(fields: Record<string, unknown>): string | null {
	for (const key of LOCATION_FIELD_KEYS) {
		const candidate = readNonEmptyString(fields[key]);
		if (candidate) return candidate;
	}
	return null;
}

/**
 * Persist timezone/location learned from an identity fact's structured
 * fields onto the sender's entity profile.
 *
 * Rules:
 *  - explicit values are never overwritten by learned ones
 *  - a new learned value replaces the previous learned value (latest wins,
 *    matching fact-supersession slot semantics)
 *  - invalid timezones are dropped, never stored
 *  - never throws; returns whether anything was written
 */
export async function learnUserProfileFromStructuredFields(
	runtime: IAgentRuntime,
	entityId: UUID,
	structuredFields: Record<string, unknown> | undefined,
): Promise<boolean> {
	const fields = asRecord(structuredFields);
	if (!fields) return false;
	if (
		typeof runtime.getEntityById !== "function" ||
		typeof runtime.updateEntity !== "function"
	) {
		return false;
	}
	const learnedTz = firstTimezoneField(fields);
	const learnedLocation = firstLocationField(fields);
	if (!learnedTz && !learnedLocation) return false;

	try {
		const entity = await runtime.getEntityById(entityId);
		if (!entity) return false;
		const metadata = asRecord(entity.metadata) ?? {};
		const existing = readUserProfile(entity);
		const rawProfile = asRecord(metadata.userProfile) ?? {};
		const next: Record<string, unknown> = { ...rawProfile };
		let changed = false;

		if (
			learnedTz &&
			existing.timezoneSource !== "explicit" &&
			existing.timezone !== learnedTz
		) {
			next.timezone = learnedTz;
			next.timezoneSource = "learned";
			changed = true;
		}
		if (
			learnedLocation &&
			existing.locationSource !== "explicit" &&
			existing.location !== learnedLocation
		) {
			next.location = learnedLocation;
			next.locationSource = "learned";
			changed = true;
		}
		if (!changed) return false;

		next.updatedAt = new Date().toISOString();
		await runtime.updateEntity({
			...entity,
			metadata: { ...metadata, userProfile: next as MetadataValue },
		});
		return true;
	} catch {
		// error-policy:J3 the fact write already succeeded; profile learning is
		// a best-effort secondary index and must not fail the evaluator turn.
		return false;
	}
}
