/**
 * Fluent, type-safe builder for defining `Service` subclasses at runtime.
 * `createService(type)` / `defineService(spec)` turn a start/stop/description
 * spec into a `TypedServiceBuilder` — a constructor carrying the static
 * `serviceType` and `start(runtime)` members the plugin loader expects — so a
 * plugin can register a service without hand-authoring a class. Static members
 * are pinned via `Object.defineProperty` to match the base `ServiceClass` shape
 * from `types/plugin.ts`, which stays the canonical definition.
 */
import type { IAgentRuntime } from "./types/runtime.js";
import type { ServiceTypeName } from "./types/service.js";
import { Service } from "./types/service.js";

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
	protected startFn?: (runtime: IAgentRuntime) => Promise<TService>;
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

		const ServiceClassImpl = class extends Service {
			capabilityDescription = description;

			async stop(): Promise<void> {
				if (stopFn) {
					await stopFn();
				}
			}
		};

		Object.defineProperty(ServiceClassImpl, "serviceType", {
			value: serviceType,
			writable: false,
			enumerable: true,
			configurable: false,
		});

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

		// Safe: the static `serviceType` and `start` members were defined above.
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
	const builder = createService<T>(definition.serviceType)
		.withDescription(definition.description)
		.withStart(definition.start);
	if (definition.stop) builder.withStop(definition.stop);
	return builder.build();
}
