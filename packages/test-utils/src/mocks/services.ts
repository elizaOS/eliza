/**
 * @fileoverview Mock implementations for Service and related interfaces
 *
 * This module provides comprehensive mock implementations for services,
 * supporting both unit and integration testing scenarios.
 */

import { mock } from './mockUtils';
import type { Service } from '@elizaos/core';
import { ServiceType, ServiceTypeName } from '@elizaos/core';
/**
 * Type representing overrides for Service mock creation
 */
export type MockServiceOverrides = Partial<Service>;

/**
 * Create a comprehensive mock Service with intelligent defaults
 *
 * This function provides a fully-featured service mock that implements
 * the Service interface with sensible defaults and proper lifecycle methods.
 *
 * @param serviceType - Type/category of the service
 * @param overrides - Partial object to override specific methods or properties
 * @returns Complete mock Service implementation
 *
 * @example
 * ```typescript
 * import { createMockService } from '@elizaos/core/test-utils';
 * import { mock } from 'bun:test';
 *
 * const mockService = createMockService(ServiceType.UNKNOWN, {
 *   someMethod: mock().mockResolvedValue('custom result')
 * });
 * ```
 */
export function createMockService(
  serviceType: ServiceTypeName = ServiceType.UNKNOWN,
  overrides: MockServiceOverrides = {}
): Service {
  const baseService = {
    // Static properties (would be on the class)
    serviceType,

    // Instance properties
    capabilityDescription: `Mock service for testing`,
    config: {
      enabled: true,
      mockData: true,
      ...overrides.config,
    },

    // Core lifecycle methods
    stop: mock().mockResolvedValue(undefined),

    // Common service methods that might be implemented
    start: mock().mockResolvedValue(undefined),
    initialize: mock().mockResolvedValue(undefined),
    isReady: mock().mockReturnValue(true),
    getStatus: mock().mockReturnValue('active'),
    restart: mock().mockResolvedValue(undefined),

    // Runtime property (protected in Service class, but needed for mocks)
    runtime: null,

    // Apply overrides
    ...overrides,
  };

  return baseService as unknown as Service;
}

/**
 * Create a mock database service
 *
 * @param overrides - Service-specific overrides
 * @returns Mock database service
 */
export function createMockDatabaseService(overrides: MockServiceOverrides = {}): Service {
  return createMockService(ServiceType.UNKNOWN, {
    capabilityDescription: 'Provides database connectivity and operations',
    ...overrides,
  });
}

/**
 * Create a mock cache service
 *
 * @param overrides - Service-specific overrides
 * @returns Mock cache service
 */
export function createMockCacheService(overrides: MockServiceOverrides = {}): Service {
  const cache = new Map();

  return createMockService(ServiceType.UNKNOWN, {
    capabilityDescription: 'Provides in-memory caching capabilities',
    ...overrides,
  });
}

/**
 * Create a mock HTTP service
 *
 * @param overrides - Service-specific overrides
 * @returns Mock HTTP service
 */
export function createMockHttpService(overrides: MockServiceOverrides = {}): Service {
  return createMockService(ServiceType.UNKNOWN, {
    capabilityDescription: 'Provides HTTP client capabilities',
    ...overrides,
  });
}

/**
 * Create a mock blockchain service
 *
 * @param overrides - Service-specific overrides
 * @returns Mock blockchain service
 */
export function createMockBlockchainService(overrides: MockServiceOverrides = {}): Service {
  return createMockService('WALLET' as ServiceTypeName, {
    capabilityDescription: 'Provides blockchain wallet and transaction capabilities',
    ...overrides,
  });
}

/**
 * Create a mock AI model service
 *
 * @param overrides - Service-specific overrides
 * @returns Mock AI model service
 */
export function createMockModelService(overrides: MockServiceOverrides = {}): Service {
  return createMockService(ServiceType.UNKNOWN, {
    capabilityDescription: 'Provides AI model inference capabilities',
    ...overrides,
  });
}

/**
 * Create a mock messaging service
 *
 * @param overrides - Service-specific overrides
 * @returns Mock messaging service
 */
export function createMockMessagingService(overrides: MockServiceOverrides = {}): Service {
  return createMockService(ServiceType.UNKNOWN, {
    capabilityDescription: 'Provides messaging platform integration',
    ...overrides,
  });
}

/**
 * Create a service map with multiple mock services
 *
 * @param services - Array of service configurations
 * @returns Map of service names to mock services
 */
export function createMockServiceMap(
  services: Array<{
    name: string;
    type?: ServiceTypeName;
    overrides?: MockServiceOverrides;
  }> = []
): Map<string, Service> {
  const serviceMap = new Map<string, Service>();

  // Default services if none provided
  if (services.length === 0) {
    services = [
      { name: 'database', type: ServiceType.UNKNOWN },
      { name: 'cache', type: ServiceType.UNKNOWN },
      { name: 'http', type: ServiceType.UNKNOWN },
    ];
  }

  services.forEach(({ name, type = ServiceType.UNKNOWN, overrides = {} }) => {
    const service = createMockService(type, overrides);
    serviceMap.set(name, service);
  });

  return serviceMap;
}

/**
 * Create a mock service registry for runtime
 *
 * @param runtime - Mock runtime instance
 * @param services - Services to register
 * @returns Updated runtime with registered services
 */
export function registerMockServices(
  runtime: any,
  services: Array<{
    name: string;
    type?: ServiceTypeName;
    overrides?: MockServiceOverrides;
  }> = []
): any {
  const serviceMap = createMockServiceMap(services);

  // Update runtime's getService method to return from the service map
  runtime.getService = mock().mockImplementation((serviceName: string) => {
    return serviceMap.get(serviceName) || null;
  });

  runtime.services = serviceMap;

  return runtime;
}
