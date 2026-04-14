import type { IAgentRuntime } from "../../types/runtime.ts";
import type { ServiceTypeName } from "../../types/service.ts";

/**
 * Core Runtime Extensions
 *
 * This module provides extensions to the core runtime for plugin management.
 * Since we cannot modify the core runtime directly, we extend it with additional
 * methods needed for proper plugin lifecycle management.
 */

/**
 * Extended runtime interface with plugin management methods.
 * Only adds optional unregistration helpers that don't conflict with IAgentRuntime.
 */
export interface ExtendedRuntime extends IAgentRuntime {
	unregisterEvent?: (
		event: string,
		handler: (params: Record<string, unknown>) => Promise<void>,
	) => void;
	unregisterAction?: (actionName: string) => void;
	unregisterProvider?: (providerName: string) => void;
	unregisterEvaluator?: (evaluatorName: string) => void;
	unregisterService?: (serviceType: string) => Promise<void>;
}

/**
 * Extends the runtime with an unregisterEvent method
 * This allows plugins to remove their event handlers when unloaded
 */
export function extendRuntimeWithEventUnregistration(
	runtime: IAgentRuntime,
): void {
	const extendedRuntime = runtime as ExtendedRuntime;

	// Add unregisterEvent method if it doesn't exist
	if (!extendedRuntime.unregisterEvent) {
		extendedRuntime.unregisterEvent = function (
			event: string,
			handler: (params: Record<string, unknown>) => Promise<void>,
		) {
			const handlers = this.events?.[event];
			if (handlers) {
				const filteredHandlers = handlers.filter(
					(h) => h !== (handler as unknown as typeof h),
				);
				if (filteredHandlers.length > 0) {
					this.events[event] = filteredHandlers;
				} else {
					delete this.events[event];
				}
			}
		};
	}
}

/**
 * Extends the runtime with component unregistration methods
 * These are needed for proper plugin unloading
 */
export function extendRuntimeWithComponentUnregistration(
	runtime: IAgentRuntime,
): void {
	const extendedRuntime = runtime as ExtendedRuntime;

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
