/**
 * Verifies the swarm-coordinator service slot — `SWARM_COORDINATOR_SERVICE_TYPE`,
 * its `ServiceType` registration, and `getSwarmCoordinatorService` resolving
 * through a runtime. Uses a hand-built stub runtime and coordinator; no real
 * service is instantiated.
 */
import { describe, expect, it } from "vitest";
import {
	getSwarmCoordinatorService,
	type ISwarmCoordinatorService,
	ServiceType,
	SWARM_COORDINATOR_SERVICE_TYPE,
	type SwarmEvent,
} from "./index";

describe("swarm coordinator service contract", () => {
	it("keeps the service type in the core registry", () => {
		expect(SWARM_COORDINATOR_SERVICE_TYPE).toBe("SWARM_COORDINATOR");
		expect(ServiceType.SWARM_COORDINATOR).toBe(SWARM_COORDINATOR_SERVICE_TYPE);
	});

	it("resolves the coordinator through the shared service slot", () => {
		const events: SwarmEvent[] = [];
		const coordinator: ISwarmCoordinatorService = {
			subscribe(listener) {
				const event = {
					type: "task_complete",
					sessionId: "session-1",
					timestamp: 1,
					data: { ok: true },
				};
				listener(event);
				events.push(event);
				return () => undefined;
			},
			setChatCallback: () => undefined,
			setWsBroadcast: () => undefined,
			setAgentDecisionCallback: () => undefined,
			setSwarmCompleteCallback: () => undefined,
		};
		const runtime = {
			getService(serviceType: string) {
				return serviceType === SWARM_COORDINATOR_SERVICE_TYPE
					? coordinator
					: null;
			},
		};

		const resolved = getSwarmCoordinatorService(runtime);
		expect(resolved).toBe(coordinator);
		resolved?.subscribe(() => undefined);
		expect(events).toHaveLength(1);
	});
});
