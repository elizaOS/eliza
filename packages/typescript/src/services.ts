import type { IAgentRuntime, ServiceTypeName } from "./types";
import { Service } from "./types";

// ServiceClass is exported from ./types/plugin.ts - don't re-define here
// to avoid duplicate export errors. The generic version is defined below.

/**
 * Type for the service class returned by the builder.
 * This provides the expected interface for dynamically created service classes.
 * This is a more specific generic version of the base ServiceClass from types/plugin.ts
 */
export interface TypedServiceBuilder<TService extends Service = Service> {
  new (runtime?: IAgentRuntime): TService;
  serviceType: ServiceTypeName;
  start(runtime: IAgentRuntime): Promise<TService>;
}

/**
 * Service builder class that provides type-safe service creation
 * with automatic type inference
 */
export class ServiceBuilder<TService extends Service = Service> {
  protected serviceType: ServiceTypeName | string;
  protected startFn!: (runtime: IAgentRuntime) => Promise<TService>;
  protected stopFn?: () => Promise<void>;
  protected description: string;

  constructor(serviceType: ServiceTypeName | string) {
    this.serviceType = serviceType;
    this.description = "";
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
   * Build the service class with all configured properties.
   * Returns a properly typed service class constructor.
   */
  build(): TypedServiceBuilder<TService> {
    const serviceType = this.serviceType;
    const description = this.description;
    const startFn = this.startFn;
    const stopFn = this.stopFn;

    // Build the service class using Object.assign to properly set static properties
    // This avoids the need for 'as unknown as' by structuring the class correctly
    const ServiceClassImpl = class extends Service {
      capabilityDescription = description;

      async stop(): Promise<void> {
        if (stopFn) {
          await stopFn();
        }
      }
    };

    // Define static properties on the class
    Object.defineProperty(ServiceClassImpl, "serviceType", {
      value: serviceType,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    // Define the static start method that returns the correct type
    const startMethod = async (runtime: IAgentRuntime): Promise<TService> => {
      if (!startFn) {
        throw new Error(
          `Start function not defined for service ${serviceType}`,
        );
      }
      return startFn(runtime);
    };

    Object.defineProperty(ServiceClassImpl, "start", {
      value: startMethod,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    // The class now conforms to TypedServiceBuilder<TService> interface
    // We use a type assertion here that is safe because we've explicitly
    // set up the class to match the interface requirements
    return ServiceClassImpl as TypedServiceBuilder<TService>;
  }
}

/**
 * Create a type-safe service builder
 * @param serviceType - The service type name
 * @returns A new ServiceBuilder instance
 */
export function createService<TService extends Service = Service>(
  serviceType: ServiceTypeName | string,
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
 * Define a service with type safety.
 * Returns a TypedServiceBuilder that can be instantiated and started.
 */
export function defineService<T extends Service = Service>(
  definition: ServiceDefinition<T>,
): TypedServiceBuilder<T> {
  return createService<T>(definition.serviceType)
    .withDescription(definition.description)
    .withStart(definition.start)
    .withStop(definition.stop || (() => Promise.resolve()))
    .build();
}
