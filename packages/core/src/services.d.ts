import { Service } from './types';
import type { IAgentRuntime, ServiceTypeName } from './types';
/**
 * Service builder class that provides type-safe service creation
 * with automatic type inference
 */
export declare class ServiceBuilder<TService extends Service = Service> {
    protected serviceType: ServiceTypeName | string;
    protected startFn: (runtime: IAgentRuntime) => Promise<TService>;
    protected stopFn?: () => Promise<void>;
    protected description: string;
    constructor(serviceType: ServiceTypeName | string);
    /**
     * Set the service description
     */
    withDescription(description: string): this;
    /**
     * Set the start function for the service
     */
    withStart(startFn: (runtime: IAgentRuntime) => Promise<TService>): this;
    /**
     * Set the stop function for the service
     */
    withStop(stopFn: () => Promise<void>): this;
    /**
     * Build the service class with all configured properties
     */
    build(): new (runtime?: IAgentRuntime) => TService;
}
/**
 * Create a type-safe service builder
 * @param serviceType - The service type name
 * @returns A new ServiceBuilder instance
 */
export declare function createService<TService extends Service = Service>(serviceType: ServiceTypeName | string): ServiceBuilder<TService>;
/**
 * Type-safe service definition helper
 */
export interface ServiceDefinition<T extends Service = Service> {
    serviceType: ServiceTypeName;
    description: string;
    start: (runtime: IAgentRuntime) => Promise<T>;
    stop?: () => Promise<void>;
}
/**
 * Define a service with type safety
 */
export declare function defineService<T extends Service = Service>(definition: ServiceDefinition<T>): new (runtime?: IAgentRuntime) => T;
//# sourceMappingURL=services.d.ts.map