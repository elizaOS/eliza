import { Service } from './types';
import type { IAgentRuntime, ServiceTypeName } from './types';

/**
 * Service builder class that provides type-safe service creation
 * with automatic type inference
 */
export class ServiceBuilder<TService extends Service = Service> {
  protected serviceType: ServiceTypeName | string;
  protected startFn: (runtime: IAgentRuntime) => Promise<TService>;
  protected stopFn?: () => Promise<void>;
  protected description: string;

  constructor(serviceType: ServiceTypeName | string) {
    this.serviceType = serviceType;
    this.description = '';
  }

  /**
   * Set the service description
   */
  withDescription(description: string): this {
    this.description = description;
    return this;
  }

  /**
   * Set the start function for the service
   */
  withStart(startFn: (runtime: IAgentRuntime) => Promise<TService>): this {
    this.startFn = startFn;
    return this;
  }

  /**
   * Set the stop function for the service
   */
  withStop(stopFn: () => Promise<void>): this {
    this.stopFn = stopFn;
    return this;
  }

  /**
   * Build the service class with all configured properties
   */
  build(): new (runtime?: IAgentRuntime) => TService {
    const serviceType = this.serviceType;
    const description = this.description;
    const startFn = this.startFn;
    const stopFn = this.stopFn;

    // Create a dynamic class with the configured properties
    return class extends (Service as any) {
      static serviceType = serviceType;
      capabilityDescription = description;

      static async start(runtime: IAgentRuntime): Promise<Service> {
        if (!startFn) {
          throw new Error(`Start function not defined for service ${serviceType}`);
        }
        return startFn(runtime);
      }

      async stop(): Promise<void> {
        if (stopFn) {
          await stopFn();
        }
      }
    } as any;
  }
}

/**
 * Create a type-safe service builder
 * @param serviceType - The service type name
 * @returns A new ServiceBuilder instance
 */
export function createService<TService extends Service = Service>(
  serviceType: ServiceTypeName | string
): ServiceBuilder<TService> {
  return new ServiceBuilder<TService>(serviceType);
}

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
export function defineService<T extends Service = Service>(
  definition: ServiceDefinition<T>
): new (runtime?: IAgentRuntime) => T {
  return createService<T>(definition.serviceType)
    .withDescription(definition.description)
    .withStart(definition.start)
    .withStop(definition.stop || (() => Promise.resolve()))
    .build();
}
