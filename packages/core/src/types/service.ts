/**
 * Service abstraction: the `ServiceTypeRegistry` (extended by plugins via module
 * augmentation) and the long-lived-singleton `Service` base contract. Services are
 * clients/schedulers/connectors the runtime starts once and shares across the
 * message loop.
 */
import type { Metadata } from "./primitives";
import type { IAgentRuntime } from "./runtime";

type CoreServiceTypeRegistry = typeof ServiceType;

/**
 * Core service type registry that can be extended by plugins via module augmentation.
 * Plugins can extend this interface to add their own service types:
 *
 * @example
 * ```typescript
 * declare module '@elizaos/core' {
 * interface ServiceTypeRegistry {
 * MY_CUSTOM_SERVICE: 'my_custom_service';
 * }
 * }
 * ```
 */
export interface ServiceTypeRegistry extends CoreServiceTypeRegistry {}

/**
 * Type for service names that includes both core services and any plugin-registered services
 */
export type ServiceTypeName = ServiceTypeRegistry[keyof ServiceTypeRegistry];

/**
 * Enumerates the recognized types of services that can be registered and used by the agent runtime.
 * Services provide specialized functionalities like audio transcription, video processing,
 * web browsing, PDF handling, file storage (e.g., AWS S3), web search, email integration,
 * secure execution via TEE (Trusted Execution Environment), and task management.
 * This constant is used in `AgentRuntime` for service registration and retrieval (e.g., `getService`).
 * Each service typically implements the `Service` abstract class or a more specific interface like `IVideoService`.
 */
export const ServiceType = {
	TRANSCRIPTION: "transcription",
	VIDEO: "video",
	BROWSER: "browser",
	PDF: "pdf",
	REMOTE_FILES: "aws_s3",
	TUNNEL: "tunnel",
	WEB_SEARCH: "web_search",
	EMAIL: "email",
	TEE: "tee",
	TASK: "task",
	APPROVAL: "approval",
	WALLET: "wallet",
	LP_POOL: "lp_pool",
	TOKEN_DATA: "token_data",
	MESSAGE_SERVICE: "message_service",
	MESSAGE: "message",
	POST: "post",
	HOOKS: "hooks",
	PAIRING: "pairing",
	CONNECTOR_ACCOUNT: "connector_account",
	CONNECTOR_ACCOUNT_STORAGE: "connector_account_storage",
	AGENT_EVENT: "agent_event",
	CONTROL_TRANSPORT: "control_transport",
	NOTIFICATION: "notification",
	MEDIA_GENERATION: "media_generation",
	VOICE_CACHE: "voice_cache",
	OPTIMIZED_PROMPT: "optimized_prompt",
	CHANNEL_TOPICS: "channel_topics",
	COMMANDS: "commands",
	MOBILE_DEVICE_BRIDGE: "mobile_device_bridge",
	SCREEN_CAPTURE: "screen_capture",
	DOCUMENTS: "documents",
	RELATIONSHIPS: "relationships",
	PRINCIPAL: "principal",
	MEMBERSHIP: "membership",
	FOLLOW_UP: "follow_up",
	TRAJECTORIES: "trajectories",
	SWARM_COORDINATOR: "SWARM_COORDINATOR",
	UNKNOWN: "unknown",
} as const;

/**
 * Client instance
 */
export abstract class Service {
	/** Runtime instance */
	protected runtime!: IAgentRuntime;

	constructor(runtime?: IAgentRuntime) {
		if (runtime) {
			this.runtime = runtime;
		}
	}

	abstract stop(): Promise<void>;

	/**
	 * Optional synchronous shutdown-admission hook. Runtime invokes this for all
	 * services before awaiting any drain, so connectors can reject new inbound
	 * work while allowing already-admitted work to settle.
	 */
	prepareStop?(_reason: string): void;

	/** Service type */
	static serviceType: string;

	/** True when multiple implementations may intentionally share this service type. */
	static allowsMultiple?: boolean;

	/** Service name */
	abstract capabilityDescription: string;

	/** Service configuration */
	config?: Metadata;

	/** Start service connection - subclasses must override this */
	static async start(_runtime: IAgentRuntime): Promise<Service> {
		throw new Error("Service.start() must be implemented by subclass");
	}

	/** Stop service connection - optional, subclasses may override this */
	static stopRuntime?(_runtime: IAgentRuntime): Promise<void>;

	/** Optional static method to register send handlers */
	static registerSendHandlers?(runtime: IAgentRuntime, service: Service): void;
}
