import {
  createService as coreCreateService,
  ServiceBuilder as coreServiceBuilder,
  ServiceDefinition as coreServiceDefinition,
} from '../../services';

import { Service, type IAgentRuntime, type ServiceTypeName } from './types';

import { Service as coreService, type IAgentRuntime as coreIAgentRuntime } from '../../types';

/**
 * Service builder class that provides type-safe service creation
 * with automatic type inference
 */
export class ServiceBuilder<TService extends Service = Service> extends coreServiceBuilder {
  constructor(serviceType: ServiceTypeName | string) {
    super(serviceType);
    //this.serviceType = serviceType;
    this.description = '';
  }
}

/**
 * Create a type-safe service builder
 * @param serviceType - The service type name
 * @returns A new ServiceBuilder instance
 */
export function createService<TService extends coreService = coreService>(
  serviceType: ServiceTypeName | string
): coreServiceBuilder<TService> {
  return coreCreateService<TService>(serviceType);
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
export function defineService<T extends coreService = coreService>(
  definition: coreServiceDefinition<T>
): new (runtime?: coreIAgentRuntime) => T {
  return coreCreateService<T>(definition.serviceType)
    .withDescription(definition.description)
    .withStart(definition.start)
    .withStop(definition.stop || (() => Promise.resolve()))
    .build();
}
