/**
 * Verifies TRUST action availability against the real runtime service registry,
 * including exact service-name matching and registration transitions.
 */

import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime } from "../../../runtime.ts";
import type { IAgentRuntime } from "../../../types/index.ts";
import { Service } from "../../../types/service.ts";
import { hasTrustEngine } from "./hasTrustEngine.ts";

class CoreTrustEngineService extends Service {
	static override serviceType = "trust-engine:core";
	capabilityDescription = "core trust engine test service";

	static override async start(
		runtime: IAgentRuntime,
	): Promise<CoreTrustEngineService> {
		return new CoreTrustEngineService(runtime);
	}

	async stop(): Promise<void> {}
}

class TrustEngineService extends Service {
	static override serviceType = "trust-engine";
	capabilityDescription = "trust engine test service";

	static override async start(
		runtime: IAgentRuntime,
	): Promise<TrustEngineService> {
		return new TrustEngineService(runtime);
	}

	async stop(): Promise<void> {}
}

const activeRuntimes: AgentRuntime[] = [];

async function makeRuntime(): Promise<AgentRuntime> {
	const runtime = new AgentRuntime({ logLevel: "fatal" });
	await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
	activeRuntimes.push(runtime);
	return runtime;
}

describe("hasTrustEngine", () => {
	afterEach(async () => {
		await Promise.all(
			activeRuntimes.splice(0).map((runtime) => runtime.stop()),
		);
	});

	it("returns false when the trust-engine service is not registered", async () => {
		const runtime = await makeRuntime();

		expect(hasTrustEngine(runtime)).toBe(false);
	});

	it("requires the exact trust-engine service name", async () => {
		const runtime = await makeRuntime();
		await runtime.registerService(CoreTrustEngineService);
		await runtime.getServiceLoadPromise(CoreTrustEngineService.serviceType);

		expect(hasTrustEngine(runtime)).toBe(false);
	});

	it("returns true after the trust-engine service is registered", async () => {
		const runtime = await makeRuntime();
		await runtime.registerService(TrustEngineService);
		await runtime.getServiceLoadPromise(TrustEngineService.serviceType);

		expect(hasTrustEngine(runtime)).toBe(true);
	});
});
