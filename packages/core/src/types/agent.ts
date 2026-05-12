import type { DocumentSourceItem } from "./documents";
import type { Content, JsonObject, JsonValue } from "./primitives";
import type { State } from "./state";

export type TemplateType =
	| string
	| ((params: {
			state:
				| State
				| Record<string, string | number | boolean | null | undefined>
				| object;
	  }) => string);

/**
 * Example message for demonstration
 */
export interface MessageExample {
	name: string;
	content: Content;
}

export interface MessageExampleGroup {
	examples: MessageExample[];
}

/**
 * Character settings (well-known keys with expected types).
 */
export interface CharacterSettings {
	shouldRespondModel?: string;
	useMultiStep?: boolean;
	maxMultistepIterations?: number;
	basicCapabilitiesDefllmoff?: boolean;
	basicCapabilitiesKeepResp?: boolean;
	providersTotalTimeoutMs?: number;
	maxWorkingMemoryEntries?: number;
	alwaysRespondChannels?: string;
	alwaysRespondSources?: string;
	defaultTemperature?: number;
	defaultMaxTokens?: number;
	defaultFrequencyPenalty?: number;
	defaultPresencePenalty?: number;
	disableBasicCapabilities?: boolean;
	enableExtendedCapabilities?: boolean;
	extra?: JsonObject;
	enableRelationships?: boolean;
	enableTrajectories?: boolean;
	ENABLE_AUTONOMY?: boolean | string;
	DISABLE_BASIC_CAPABILITIES?: boolean | string;
	ENABLE_EXTENDED_CAPABILITIES?: boolean | string;
	ADVANCED_CAPABILITIES?: boolean | string;
	ENABLE_TRUST?: boolean | string;
	ENABLE_SECRETS_MANAGER?: boolean | string;
	ENABLE_PLUGIN_MANAGER?: boolean | string;
	ENABLE_DOCUMENTS?: boolean | string;
	ENABLE_RELATIONSHIPS?: boolean | string;
	ENABLE_TRAJECTORIES?: boolean | string;
	secrets?: Record<string, string | boolean | number>;
	[key: string]: JsonValue | undefined;
}

export interface Character {
	id?: string;
	name?: string;
	username?: string;
	system?: string;
	templates?: { [key: string]: string };
	bio?: string[];
	postExamples?: string[];
	topics?: string[];
	adjectives?: string[];
	plugins?: string[];
	settings?: CharacterSettings;
	secrets?: Record<string, string | number | boolean>;
	messageExamples?: MessageExampleGroup[];
	documents?: DocumentSourceItem[];
	knowledge?: DocumentSourceItem[];
	style?: { all?: string[]; chat?: string[]; post?: string[] };
	/** Enable advanced planning capabilities for this character */
	advancedPlanning?: boolean;
	/** Enable advanced memory capabilities for this character */
	advancedMemory?: boolean;
}

export enum AgentStatus {
	ACTIVE = "active",
	INACTIVE = "inactive",
}

/**
 * Represents an operational agent, extending the `Character` definition with runtime status and timestamps.
 */
export interface Agent extends Character {
	enabled?: boolean;
	status?: AgentStatus;
	createdAt: number | bigint;
	updatedAt: number | bigint;
	/** Arbitrary metadata persisted alongside the agent record. */
	metadata?: Record<string, unknown>;
}
