import { IAgentRuntime, Service, type ServiceTypeName } from '@elizaos/core';

/**
 * Core Runtime Extensions
 *
 * This module provides extensions to the core runtime for plugin management.
 * Since we cannot modify the core runtime directly, we extend it with additional
 * methods needed for proper plugin lifecycle management.
 */

/**
 * Extended runtime interface with plugin management methods.
 * Cast via unknown when assigning from IAgentRuntime.
 * Note: events on the runtime may be RuntimeEventStorage; unregisterEvent uses internal storage.
 */
export interface ExtendedRuntime extends Omit<IAgentRuntime, 'events'> {
  unregisterEvent?: (event: string, handler: (params: Record<string, unknown>) => Promise<void>) => void;
  unregisterAction?: (actionName: string) => void;
  unregisterProvider?: (providerName: string) => void;
  unregisterEvaluator?: (evaluatorName: string) => void;
  unregisterService?: (serviceType: string) => Promise<void>;
}

/**
 * Extends the runtime with an unregisterEvent method
 * This allows plugins to remove their event handlers when unloaded
 */
export function extendRuntimeWithEventUnregistration(runtime: IAgentRuntime): void {
  const extendedRuntime = runtime as unknown as ExtendedRuntime;

  // Add unregisterEvent method if it doesn't exist (uses internal events storage)
  if (!extendedRuntime.unregisterEvent) {
    extendedRuntime.unregisterEvent = function (
      event: string,
      handler: (params: Record<string, unknown>) => Promise<void>
    ) {
      const eventsStorage = (this as any).events;
      if (eventsStorage?.get) {
        const handlers = eventsStorage.get(event);
        if (handlers) {
          const filteredHandlers = handlers.filter((h: unknown) => h !== handler);
          if (filteredHandlers.length > 0) {
            eventsStorage.set(event, filteredHandlers);
          } else {
            eventsStorage.delete(event);
          }
        }
      }
    };
  }
}

/**
 * Extends the runtime with component unregistration methods
 * These are needed for proper plugin unloading
 */
export function extendRuntimeWithComponentUnregistration(runtime: IAgentRuntime): void {
  const extendedRuntime = runtime as unknown as ExtendedRuntime;

  // Add unregisterAction method if it doesn't exist
  if (!extendedRuntime.unregisterAction) {
    extendedRuntime.unregisterAction = function (actionName: string) {
      const index = this.actions.findIndex((a) => a.name === actionName);
      if (index !== -1) {
        this.actions.splice(index, 1);
      }
    };
  }

  // Add unregisterProvider method if it doesn't exist
  if (!extendedRuntime.unregisterProvider) {
    extendedRuntime.unregisterProvider = function (providerName: string) {
      const index = this.providers.findIndex((p) => p.name === providerName);
      if (index !== -1) {
        this.providers.splice(index, 1);
      }
    };
  }

  // Add unregisterEvaluator method if it doesn't exist
  if (!extendedRuntime.unregisterEvaluator) {
    extendedRuntime.unregisterEvaluator = function (evaluatorName: string) {
      const index = this.evaluators.findIndex((e) => e.name === evaluatorName);
      if (index !== -1) {
        this.evaluators.splice(index, 1);
      }
    };
  }

  // Add unregisterService method if it doesn't exist
  if (!extendedRuntime.unregisterService) {
    extendedRuntime.unregisterService = async function (serviceType: string) {
      const services = this.getServicesByType(serviceType as ServiceTypeName);
      if (services && services.length > 0) {
        for (const service of services) {
          await service.stop();
        }
        // Remove from the services map via the runtime's service map
        const allServices = this.getAllServices();
        allServices.delete(serviceType as ServiceTypeName);
      }
    };
  }
}

/**
 * Apply all runtime extensions
 */
export function applyRuntimeExtensions(runtime: IAgentRuntime): void {
  extendRuntimeWithEventUnregistration(runtime);
  extendRuntimeWithComponentUnregistration(runtime);
}
