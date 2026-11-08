/** Coordinates service start deduplication and stop-during-start settlement using the original runtime and its shared registries. */

import { ElizaError } from "../errors";
import { EventType } from "../types/events";
import type { ServiceClass } from "../types/plugin.js";
import type { IAgentRuntime } from "../types/runtime.js";
import type { Service, ServiceTypeName } from "../types/service.js";
import type { RuntimeRetirement } from "./retirement.js";

export type ServiceResolver = (service: Service) => void;

export type ServiceRejecter = (reason: Error | string) => void;

export type ServicePromiseHandler = {
	resolve: ServiceResolver;
	reject: ServiceRejecter;
};

export interface RuntimeServiceLifecycleHost {
	stopRequested(): boolean;
	initializationFailed(): boolean;
	resolveServiceTypeAlias(serviceType: ServiceTypeName | string): string;
	initResolver(): ((value?: void | PromiseLike<void>) => void) | undefined;
	serviceTypes(): Map<ServiceTypeName, ServiceClass[]>;
	serviceInstancesByClass(): Map<ServiceClass, Service>;
	startingServiceClasses(): Map<ServiceClass, Promise<Service>>;
	failedServiceClasses(): Set<ServiceClass>;
	startingServices(): Map<string, Promise<Service | null>>;
	serviceRegistrationStatus(): Map<
		ServiceTypeName,
		"pending" | "registering" | "registered" | "failed"
	>;
	servicePromiseHandlers(): Map<string, ServicePromiseHandler>;
	servicePromises(): Map<string, Promise<Service>>;
	stopped(): boolean;
	/** Runs one start through the runtime, so plugin-lifecycle can attribute
	 * what start() registers to the service's plugin. */
	runServiceStart(
		key: ServiceTypeName,
		serviceType: string,
		serviceClass: ServiceClass,
	): Promise<Service | null>;
}

/** Backoff between eager service-start attempts after a failed boot-time start. */
const EAGER_SERVICE_START_RETRY_DELAYS_MS: readonly number[] = [
	2_000, 5_000, 10_000,
];

export class RuntimeServiceLifecycle {
	/** Retries eager startup after transient failures; shutdown terminates retries. */
	async startServiceEagerly(
		serviceType: ServiceTypeName | string,
		pluginName: string,
	): Promise<void> {
		for (let attempt = 0; ; attempt += 1) {
			try {
				await this._ensureServiceStarted(serviceType);
				return;
			} catch (err) {
				// error-policy:J5 eager startup is fire-and-forget; _runServiceStart
				// reports each failure and service-load callers observe the rejection.
				const delayMs = EAGER_SERVICE_START_RETRY_DELAYS_MS[attempt];
				const willRetry =
					delayMs !== undefined &&
					!this.host.stopRequested() &&
					!this.host.stopped();
				this.runtime.logger.error(
					{
						src: "agent",
						agentId: this.runtime.agentId,
						plugin: pluginName,
						serviceType,
						attempt: attempt + 1,
						willRetry,
						error: err instanceof Error ? err.message : String(err),
					},
					willRetry ? "Service start failed; retrying" : "Service start failed",
				);
				if (!willRetry) return;
				await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
				if (this.host.stopRequested() || this.host.stopped()) return;
			}
		}
	}

	constructor(
		private readonly runtime: IAgentRuntime,
		private readonly host: RuntimeServiceLifecycleHost,
		private readonly retirement: RuntimeRetirement,
	) {}

	private readonly stopOperations = new WeakMap<Service, Promise<void>>();

	/** One stop() per instance, shared by runtime shutdown and plugin unload;
	 * rejects with the stop() failure. */
	stopServiceOnce(serviceType: string, service: Service): Promise<void> {
		let operation = this.stopOperations.get(service);
		if (!operation) {
			// Defer hook invocation until its single-flight identity is published.
			operation = this.retirement.run(() =>
				Promise.resolve()
					.then(() => service.stop())
					.catch((error) => {
						// error-policy:J2 retain the original failure before this operation settles.
						this.retirement.recordFailure(`stop:${serviceType}`, error);
						throw error;
					}),
			);
			this.stopOperations.set(service, operation);
		}
		return operation;
	}

	async _stopServiceInstance(
		serviceType: string,
		service: Service | null | undefined,
		reason: string,
	): Promise<void> {
		if (!service) {
			this.retirement.recordFailure(
				`stop:${serviceType}`,
				new Error("Null service instance"),
			);
			this.runtime.logger.warn(
				{ src: "agent", agentId: this.runtime.agentId, serviceType, reason },
				"Null service instance during stop; skipping",
			);
			return;
		}
		// Plugin service objects are untyped at runtime; stop() may be absent.
		if (typeof service.stop !== "function") {
			this.retirement.recordFailure(
				`stop:${serviceType}`,
				new Error("Service is missing stop()"),
			);
			this.runtime.logger.warn(
				{ src: "agent", agentId: this.runtime.agentId, serviceType, reason },
				"Service instance is missing stop(); skipping",
			);
			return;
		}
		try {
			await this.stopServiceOnce(serviceType, service);
		} catch (err) {
			// error-policy:J6 Service shutdown is best-effort so every
			// registered service receives its teardown opportunity.
			this.runtime.logger.warn(
				{
					src: "agent",
					agentId: this.runtime.agentId,
					serviceType,
					reason,
					error: err instanceof Error ? err.message : String(err),
				},
				"Service stop() threw; continuing",
			);
		}
	}

	/** Starts every pending implementation in parallel and waits for the full set. */
	async _ensureServiceStarted(
		serviceType: ServiceTypeName | string,
	): Promise<Service | null> {
		if (this.host.stopRequested()) return null;
		const key = this.host.resolveServiceTypeAlias(
			serviceType,
		) as ServiceTypeName;
		// Fast path: a service that is already registered and running is returned
		// immediately WITHOUT awaiting initPromise. Callers inside initialize()
		// (plugin init -> getService) would otherwise deadlock on the
		// still-unresolved init barrier even though the instance is already up.
		const alreadyRunning = this.runtime.services.get(key)?.[0];
		if (alreadyRunning && this.host.initResolver()) return alreadyRunning;
		await this.runtime.initPromise;
		// A failed initialize() releases initPromise only so waiters settle.
		if (this.host.stopRequested() || this.host.initializationFailed()) {
			return null;
		}
		const classes = this.host.serviceTypes().get(key);
		if (!classes || classes.length === 0) {
			return null;
		}
		const instances = this.host.serviceInstancesByClass();
		const startedClass = classes.find((serviceClass) =>
			instances.has(serviceClass),
		);
		const startedImplementation = startedClass && instances.get(startedClass);
		const starts = classes.map((serviceClass) => {
			const started = this.host.serviceInstancesByClass().get(serviceClass);
			if (started) return Promise.resolve(started);
			const pending = this.host.startingServiceClasses().get(serviceClass);
			if (pending) return pending;
			if (
				startedImplementation &&
				this.host.failedServiceClasses().has(serviceClass)
			) {
				return Promise.resolve(startedImplementation);
			}

			const start = this.host
				.runServiceStart(key, serviceType, serviceClass)
				.then(
					(service) => {
						if (!service) {
							throw new Error(
								`Service implementation ${serviceClass.name || "<anonymous>"} did not start`,
							);
						}
						this.host.failedServiceClasses().delete(serviceClass);
						return service;
					},
					(error) => {
						this.host.failedServiceClasses().add(serviceClass);
						throw error;
					},
				);
			this.host.startingServiceClasses().set(serviceClass, start);
			void start.then(
				() => this.host.startingServiceClasses().delete(serviceClass),
				() => this.host.startingServiceClasses().delete(serviceClass),
			);
			return start;
		});

		const settlement = Promise.allSettled(starts);
		const allStarts = settlement.then((results) => {
			const firstSuccessful = results.find(
				(result): result is PromiseFulfilledResult<Service> =>
					result.status === "fulfilled",
			)?.value;
			return firstSuccessful ?? null;
		});
		this.host.startingServices().set(key, allStarts);
		void allStarts.then(() => {
			if (this.host.startingServices().get(key) === allStarts) {
				this.host.startingServices().delete(key);
			}
		});

		const settled = await settlement;
		const first = this.runtime.services.get(key)?.[0] ?? null;
		if (first) {
			this.host.serviceRegistrationStatus().set(key, "registered");
			const handler = this.host.servicePromiseHandlers().get(key);
			if (handler) {
				handler.resolve(first);
				this.host.servicePromiseHandlers().delete(key);
			}
			return first;
		}

		const cause = new AggregateError(
			settled.flatMap((result) =>
				result.status === "rejected" ? [result.reason] : [],
			),
			`All implementations of service ${serviceType} failed`,
		);
		const startupError = new ElizaError(
			`Service ${serviceType} not found or failed to start`,
			{
				code: "SERVICE_START_FAILED",
				context: {
					serviceType,
					implementationCount: classes.length,
				},
				cause,
			},
		);
		const handler = this.host.servicePromiseHandlers().get(key);
		if (handler) {
			handler.reject(startupError);
			this.host.servicePromiseHandlers().delete(key);
			this.host.servicePromises().delete(key);
		}
		// A plugin unload may have withdrawn every class of this type while
		// these starts ran; a type with no classes keeps no status
		// (quint/ServiceLifecycle.qnt, NoStatusWithoutClasses).
		if (this.host.serviceTypes().get(key)?.length) {
			this.host.serviceRegistrationStatus().set(key, "failed");
		} else {
			this.host.serviceRegistrationStatus().delete(key);
		}
		throw startupError;
	}

	/** Runs one service start under retirement ownership; _ensureServiceStarted dedupes callers. */
	_runServiceStart(
		key: ServiceTypeName,
		serviceType: string,
		serviceDef: ServiceClass,
	): Promise<Service | null> {
		return this.retirement.run(async () => {
			if ((this.runtime.services.get(key)?.length ?? 0) === 0) {
				this.host.serviceRegistrationStatus().set(key, "registering");
			}
			if (typeof serviceDef.start !== "function") {
				throw new ElizaError("Service class has no static start method", {
					code: "SERVICE_START_METHOD_MISSING",
					context: { serviceType },
				});
			}
			try {
				if (this.host.stopped() || this.host.stopRequested()) {
					throw new Error(
						`Runtime stop requested before service ${serviceType} could start`,
					);
				}
				const serviceInstance = await serviceDef.start(this.runtime);
				if (!serviceInstance) {
					throw new ElizaError("Service start returned no instance", {
						code: "SERVICE_START_RESULT_INVALID",
						context: { serviceType },
					});
				}
				if (this.host.stopped() || this.host.stopRequested()) {
					await this._stopServiceInstance(
						key,
						serviceInstance,
						"late service start after runtime stop",
					);
					throw new Error(
						`Runtime stop requested while service ${serviceType} was starting`,
					);
				}
				// Plugin unload withdraws the class before it awaits the start.
				if (!this.host.serviceTypes().get(key)?.includes(serviceDef)) {
					await this._stopServiceInstance(
						key,
						serviceInstance,
						"late service start after plugin unload",
					);
					throw new Error(
						`Service ${serviceType} was unregistered while it was starting`,
					);
				}
				this.host.serviceInstancesByClass().set(serviceDef, serviceInstance);
				const orderedInstances = (
					this.host.serviceTypes().get(key) ?? []
				).flatMap((serviceClass) => {
					const instance = this.host
						.serviceInstancesByClass()
						.get(serviceClass);
					return instance ? [instance] : [];
				});
				this.runtime.services.set(key, orderedInstances);
				this.host.serviceRegistrationStatus().set(key, "registered");
				if (serviceDef.registerSendHandlers) {
					serviceDef.registerSendHandlers(this.runtime, serviceInstance);
				}
				// Hosts can attach transports to services loaded after API startup.
				// Observers must use getService(), not await the startup promise.
				try {
					await this.runtime.emitEvent(EventType.SERVICE_STARTED, {
						runtime: this.runtime,
						source: "runtime",
						serviceType,
					});
				} catch (error) {
					// error-policy:J7 observer failure must not invalidate a running service
					this.runtime.reportError(
						"AgentRuntime.serviceStartedObserver",
						error,
						{
							serviceType,
						},
					);
				}
				return serviceInstance;
			} catch (error) {
				// error-policy:J2 service startup adds service identity and preserves the cause
				this.runtime.reportError("AgentRuntime.serviceStart", error, {
					serviceType,
				});
				// The type settles in _ensureServiceStarted: a sibling may still start.
				throw new ElizaError(`Service ${serviceType} failed to start`, {
					code: "SERVICE_START_FAILED",
					cause: error,
					context: { serviceType },
				});
			}
		});
	}
}
