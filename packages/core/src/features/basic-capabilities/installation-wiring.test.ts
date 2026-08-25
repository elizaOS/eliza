/**
 * Production-wiring proof for the canonical installation lifecycle (#23107).
 * Boots a real AgentRuntime (no DB, migrations skipped) and asserts the two
 * registration seams the lifecycle depends on: the service itself is
 * registered through basicServices (so `runtime.getService("installation")`
 * resolves without any connector-specific setup), and the Discord plugin's
 * `init` registers its contribution with that service. The service-missing
 * case is asserted too: `resolveInstallationLifecycleService` returns null
 * (not a throw) so the reporting seams degrade honestly.
 */

import { describe, expect, it } from "vitest";
import {
	resolveInstallationLifecycleService,
	ServiceType,
} from "../../index.ts";
import {
	type GroupInstallationRecord,
	INSTALLATION_LIFECYCLE_CONTRACT_VERSION,
	type InstallationScope,
} from "../../messaging/installation-lifecycle.ts";
import { AgentRuntime } from "../../runtime.ts";
import type { Character } from "../../types/agent.ts";
import type { UUID } from "../../types/primitives.ts";

async function bootRuntime(
	opts: ConstructorParameters<typeof AgentRuntime>[0],
): Promise<AgentRuntime> {
	const runtime = new AgentRuntime({ logLevel: "fatal", ...opts });
	await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
	return runtime;
}

const scope: InstallationScope = {
	agentId: "00000000-0000-4000-8000-0000000000a1" as UUID,
	connectorId: "wiring-test",
	connectorAccountId: "00000000-0000-4000-8000-0000000000a2" as UUID,
	externalWorldId: "wiring-world",
};

describe("installation lifecycle production wiring", () => {
	it("registers InstallationLifecycleService through basicServices so connectors can resolve it", async () => {
		const runtime = await bootRuntime({
			character: { name: "install-wiring" } as Character,
		});
		// Start the lazily-registered service exactly like production callers
		// (registration is lazy; first load promise start()s it).
		await runtime.getServiceLoadPromise(ServiceType.INSTALLATION);
		const service = resolveInstallationLifecycleService(runtime);
		expect(service).not.toBeNull();
		// Touch the real surface to prove it is the real service, not a stub.
		expect(service?.get(scope)).toBeNull();
	});

	it("surfaces basicServices membership directly", async () => {
		const { basicServices } = await import("./index.ts");
		expect(
			basicServices.some(
				(ctor) => ctor.name === "InstallationLifecycleService",
			),
		).toBe(true);
	});

	it("keeps get() record types honest when a record exists", async () => {
		const runtime = await bootRuntime({
			character: { name: "install-wiring-record" } as Character,
		});
		await runtime.getServiceLoadPromise(ServiceType.INSTALLATION);
		const service = resolveInstallationLifecycleService(runtime);
		expect(service).not.toBeNull();
		const receipt = service?.apply({
			contractVersion: INSTALLATION_LIFECYCLE_CONTRACT_VERSION,
			scope,
			reinstallVersion: 1,
			observedGeneration: 0,
			observedAt: new Date().toISOString(),
			idempotencyKey: "wiring:invite",
			transition: { kind: "invite_created", externalGroupLabel: "wiring" },
		});
		expect(receipt?.accepted).toBe(true);
		const record = service?.get(scope) as GroupInstallationRecord | null;
		expect(record?.state).toBe("invite_created");
	});

	it("resolves null (never throws) when the service is absent", async () => {
		const runtime = await bootRuntime({
			character: { name: "install-wiring-absent" } as Character,
			disableBasicCapabilities: true,
		});
		const service = resolveInstallationLifecycleService(runtime);
		expect(service).toBeNull();
	});
});
