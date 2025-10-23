import type { Metadata } from './primitives';
import type { IAgentRuntime } from './runtime';
/**
 * Core service type registry that can be extended by plugins via module augmentation.
 * Plugins can extend this interface to add their own service types:
 *
 * @example
 * ```typescript
 * declare module '@elizaos/core' {
 *   interface ServiceTypeRegistry {
 *     MY_CUSTOM_SERVICE: 'my_custom_service';
 *   }
 * }
 * ```
 */
export interface ServiceTypeRegistry {
    TRANSCRIPTION: 'transcription';
    VIDEO: 'video';
    BROWSER: 'browser';
    PDF: 'pdf';
    REMOTE_FILES: 'aws_s3';
    WEB_SEARCH: 'web_search';
    EMAIL: 'email';
    TEE: 'tee';
    TASK: 'task';
    WALLET: 'wallet';
    LP_POOL: 'lp_pool';
    TOKEN_DATA: 'token_data';
    MESSAGE_SERVICE: 'message_service';
    MESSAGE: 'message';
    POST: 'post';
    UNKNOWN: 'unknown';
}
/**
 * Type for service names that includes both core services and any plugin-registered services
 */
export type ServiceTypeName = ServiceTypeRegistry[keyof ServiceTypeRegistry];
/**
 * Helper type to extract service type values from the registry
 */
export type ServiceTypeValue<K extends keyof ServiceTypeRegistry> = ServiceTypeRegistry[K];
/**
 * Helper type to check if a service type exists in the registry
 */
export type IsValidServiceType<T extends string> = T extends ServiceTypeName ? true : false;
/**
 * Type-safe service class definition
 */
export type TypedServiceClass<T extends ServiceTypeName> = {
    new (runtime?: IAgentRuntime): Service;
    serviceType: T;
    start(runtime: IAgentRuntime): Promise<Service>;
};
/**
 * Map of service type names to their implementation classes
 */
export interface ServiceClassMap {
}
/**
 * Helper to infer service instance type from service type name
 */
export type ServiceInstance<T extends ServiceTypeName> = T extends keyof ServiceClassMap ? InstanceType<ServiceClassMap[T]> : Service;
/**
 * Runtime service registry type
 */
export type ServiceRegistry<T extends ServiceTypeName = ServiceTypeName> = Map<T, Service>;
/**
 * Enumerates the recognized types of services that can be registered and used by the agent runtime.
 * Services provide specialized functionalities like audio transcription, video processing,
 * web browsing, PDF handling, file storage (e.g., AWS S3), web search, email integration,
 * secure execution via TEE (Trusted Execution Environment), and task management.
 * This constant is used in `AgentRuntime` for service registration and retrieval (e.g., `getService`).
 * Each service typically implements the `Service` abstract class or a more specific interface like `IVideoService`.
 */
export declare const ServiceType: {
    readonly TRANSCRIPTION: "transcription";
    readonly VIDEO: "video";
    readonly BROWSER: "browser";
    readonly PDF: "pdf";
    readonly REMOTE_FILES: "aws_s3";
    readonly WEB_SEARCH: "web_search";
    readonly EMAIL: "email";
    readonly TEE: "tee";
    readonly TASK: "task";
    readonly WALLET: "wallet";
    readonly LP_POOL: "lp_pool";
    readonly TOKEN_DATA: "token_data";
    readonly MESSAGE_SERVICE: "message_service";
    readonly MESSAGE: "message";
    readonly POST: "post";
    readonly UNKNOWN: "unknown";
};
/**
 * Client instance
 */
export declare abstract class Service {
    /** Runtime instance */
    protected runtime: IAgentRuntime;
    constructor(runtime?: IAgentRuntime);
    abstract stop(): Promise<void>;
    /** Service type */
    static serviceType: string;
    /** Service name */
    abstract capabilityDescription: string;
    /** Service configuration */
    config?: Metadata;
    /** Start service connection */
    static start(_runtime: IAgentRuntime): Promise<Service>;
    /** Stop service connection */
    static stop(_runtime: IAgentRuntime): Promise<unknown>;
}
/**
 * Generic service interface that provides better type checking for services
 * @template ConfigType The configuration type for this service
 * @template ResultType The result type returned by the service operations
 */
export interface TypedService<ConfigType extends Metadata = Metadata, ResultType = unknown> extends Service {
    /**
     * The configuration for this service instance
     */
    config?: ConfigType;
    /**
     * Process an input with this service
     * @param input The input to process
     * @returns A promise resolving to the result
     */
    process(input: unknown): Promise<ResultType>;
}
/**
 * Generic factory function to create a typed service instance
 * @param runtime The agent runtime
 * @param serviceType The type of service to get
 * @returns The service instance or null if not available
 */
export declare function getTypedService<T extends TypedService<any, any>>(runtime: IAgentRuntime, serviceType: ServiceTypeName): T | null;
/**
 * Standardized service error type for consistent error handling
 */
export interface ServiceError {
    code: string;
    message: string;
    details?: unknown;
    cause?: Error;
}
/**
 * Safely create a ServiceError from any caught error
 */
export declare function createServiceError(error: unknown, code?: string): ServiceError;
//# sourceMappingURL=service.d.ts.map