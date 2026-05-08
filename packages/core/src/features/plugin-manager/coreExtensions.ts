import type { IAgentRuntime } from "../../types/runtime.ts";
import type { ServiceTypeName } from "../../types/service.ts";

/**
 * Core Runtime Extensions
 *
 * This module provides extensions to the core runtime for plugin management.
 * `unregisterEvent` is now a first-class method on `AgentRuntime` / `IAgentRuntime`,
 * so this file only retains component unregistration helpers (action/provider/
 * evaluator/service) that are not yet part of the runtime contract.
 */

/**
 * Extended runtime interface with optional component unregistration helpers.
 */
export interface ExtendedRuntime extends IAgentRuntime {
	unregisterAction: (actionName: string) => boolean;
	unregisterProvider?: (providerName: string) => void;
	unregisterEvaluator?: (evaluatorName: string) => void;
	unregisterService?: (serviceType: string) => Promise<void>;
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
				return true;
			}
			return false;
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
	extendRuntimeWithComponentUnregistration(runtime);
}
