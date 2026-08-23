/**
 * Drives the trajectories services barrel against its live implementations:
 * the public class/route surface it publishes, the SQL-service resolution
 * helpers consumers rely on, and the lifecycle gating branches (ownership,
 * disablement, synchronous step routing with diagnostic-only rollback) that
 * are reachable without a database.
 */

import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { ElizaError } from "../errors";
import type { IAgentRuntime } from "../types";
import { Service } from "../types/service";
import {
	TrajectoriesService,
	tryHandleTrajectoryReadRoutes,
} from "./trajectories";

function makeRuntime(
	overrides: {
		agentId?: string;
		getService?: (type: string) => unknown;
		getServicesByType?: (type: string) => unknown[];
	} = {},
): IAgentRuntime {
	return {
		agentId: overrides.agentId ?? "agent-under-test",
		getService: overrides.getService ?? (() => null),
		getServicesByType: overrides.getServicesByType ?? (() => []),
		reportError: vi.fn(),
	} as unknown as IAgentRuntime;
}

function makeService(agentId?: string) {
	const runtime = makeRuntime({ agentId });
	return new TrajectoriesService(runtime);
}

describe("services/trajectories public surface", () => {
	it("publishes the SQL-backed trajectories service under its registered type", () => {
		expect(TrajectoriesService.serviceType).toBe("trajectories");
		expect(TrajectoriesService.allowsMultiple).toBe(true);
		expect(TrajectoriesService).toBeTypeOf("function");
	});

	it("produces Service instances carrying the trajectory capability", () => {
		const service = makeService();
		expect(service).toBeInstanceOf(TrajectoriesService);
		expect(service).toBeInstanceOf(Service);
		expect(service.capabilityDescription).toContain("trajector");
		expect(service.serviceType).toBe("trajectories");
		expect(service.isEnabled()).toBe(true);
	});

	it("exposes the trajectory read-route handler through the barrel", () => {
		expect(tryHandleTrajectoryReadRoutes).toBeTypeOf("function");
	});
});

describe("services/trajectories route fall-through", () => {
	it.each([
		["POST", "/api/trajectories"],
		["GET", "/api/messages"],
	] as const)(
		"falls through (%s %s) without touching the response",
		async (method, pathname) => {
			const res = {} as ServerResponse;
			await expect(
				tryHandleTrajectoryReadRoutes({
					pathname,
					method,
					url: new URL(`http://localhost${pathname}`),
					runtime: makeRuntime(),
					res,
				}),
			).resolves.toBe(false);
		},
	);

	it("claims GET /api/trajectories routes and answers on the response", async () => {
		const res = {
			setHeader: vi.fn(),
			end: vi.fn(),
		} as unknown as ServerResponse;
		await expect(
			tryHandleTrajectoryReadRoutes({
				pathname: "/api/trajectories",
				method: "GET",
				url: new URL("http://localhost/api/trajectories"),
				runtime: null,
				res,
			}),
		).resolves.toBe(true);
		expect(res.setHeader).toHaveBeenCalledOnce();
		expect(res.end).toHaveBeenCalledOnce();
	});
});

describe("TrajectoriesService.resolveFromRuntime", () => {
	it("returns the real service when getService already yields it", () => {
		const service = makeService();
		const runtime = makeRuntime({ getService: () => service });
		expect(TrajectoriesService.resolveFromRuntime(runtime)).toBe(service);
	});

	it("scans past the lightweight fallback to find the real service", () => {
		const service = makeService();
		const fallback = {};
		const runtime = makeRuntime({
			getService: () => fallback,
			getServicesByType: () => [fallback, service],
		});
		expect(TrajectoriesService.resolveFromRuntime(runtime)).toBe(service);
	});

	it("returns null when no real service is registered", () => {
		const fallback = {};
		const runtime = makeRuntime({
			getService: () => fallback,
			getServicesByType: () => [fallback],
		});
		expect(TrajectoriesService.resolveFromRuntime(runtime)).toBeNull();
	});

	it("tolerates runtimes without getServicesByType", () => {
		const runtime = {
			agentId: "agent-under-test",
			getService: () => null,
			reportError: vi.fn(),
		} as unknown as IAgentRuntime;
		expect(TrajectoriesService.resolveFromRuntime(runtime)).toBeNull();
	});
});

describe("TrajectoriesService.waitForService", () => {
	it("resolves promptly once the real service is registered", async () => {
		const service = makeService();
		const runtime = makeRuntime({
			getService: () => null,
			getServicesByType: () => [service],
		});
		await expect(
			TrajectoriesService.waitForService(runtime, 1_000),
		).resolves.toBe(service);
	});

	it("gives up with null when the service never registers", async () => {
		const runtime = makeRuntime();
		await expect(
			TrajectoriesService.waitForService(runtime, 120),
		).resolves.toBeNull();
	});
});

describe("TrajectoriesService lifecycle gating", () => {
	it("rejects a foreign agent before any database work", async () => {
		const service = makeService("agent-under-test");
		await expect(
			service.startTrajectory("agent-somewhere-else"),
		).rejects.toMatchObject({
			code: "TRAJECTORY_AGENT_OWNERSHIP_CONFLICT",
			context: expect.objectContaining({
				runtimeAgentId: "agent-under-test",
				requestedAgentId: "agent-somewhere-else",
			}),
		});
	});

	it("mints unpersisted ids for every call once disabled, skipping ownership checks", async () => {
		const service = makeService("agent-under-test");
		service.setEnabled(false);
		expect(service.isEnabled()).toBe(false);

		const first = await service.startTrajectory("agent-somewhere-else");
		const second = await service.startTrajectory("agent-under-test");
		for (const id of [first, second]) {
			expect(id).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
			);
		}
		expect(first).not.toBe(second);
	});

	it("registers the current step synchronously, then rolls routing back when persistence fails diagnostically", async () => {
		const runtime = makeRuntime() as IAgentRuntime & {
			reportError: ReturnType<typeof vi.fn>;
		};
		const service = new TrajectoriesService(runtime);
		const trajectoryId = "traj-rollback";
		const stepId = service.startStep(trajectoryId, { timestamp: 1_000 });

		expect(stepId).toMatch(/^[0-9a-f-]{36}$/i);
		expect(service.getCurrentStepId(trajectoryId)).toBe(stepId);

		await expect(service.flushWriteQueue(trajectoryId)).rejects.toMatchObject({
			code: "TRAJECTORY_TRANSACTION_UNAVAILABLE",
		});

		expect(service.getCurrentStepId(trajectoryId)).toBeNull();
		expect(runtime.reportError).toHaveBeenCalledWith(
			"TrajectoriesService.detachedWrite",
			expect.any(ElizaError),
			expect.objectContaining({
				trajectoryId,
				stepId,
				diagnosticOnly: true,
			}),
		);
	});

	it("stops cleanly even when it was never initialized", async () => {
		const service = makeService();
		service.setEnabled(false);
		await expect(service.stop()).resolves.toBeUndefined();
	});
});
