import type { ServiceTypeRegistry } from "../../../types/service.ts";

declare module "../../../types/service.ts" {
	interface ServiceTypeRegistry {
		CHARACTER_MANAGEMENT: "CHARACTER_MANAGEMENT";
	}
}

// Export service type constant
export const PersonalityServiceType = {
	CHARACTER_MANAGEMENT: "CHARACTER_MANAGEMENT" as const,
} satisfies Partial<ServiceTypeRegistry>;

/** Memory table for per-user interaction preferences. */
export const USER_PREFS_TABLE = "user_personality_preferences";

/** Maximum number of interaction preferences a single user can store. */
export const MAX_PREFS_PER_USER = 10;
