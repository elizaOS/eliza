/**
 * Production-wiring proof for the Discord side of the canonical installation
 * lifecycle (#23107, round-1 F6): the plugin's `init` must register the
 * Discord contribution even though the core lifecycle service starts
 * asynchronously. Boots a real AgentRuntime with the real Discord plugin and
 * awaits its init, then asserts the contribution is present on the real
 * service instance. No mocks stand in for the system under test: the plugin,
 * the service, and the runtime registration path are all real.
 */

import type { Character } from "@elizaos/core";
import {
	AgentRuntime,
	type InstallationLifecycleService,
	ServiceType,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import discordPlugin from "../index";

async function bootRuntime(
	character: Partial<Character>,
	disableBasic = false,
): Promise<AgentRuntime> {
	const runtime = new AgentRuntime({
		logLevel: "fatal",
		character: character as Character,
		disableBasicCapabilities: disableBasic,
		plugins: [discordPlugin as never],
	});
	await runtime.initialize({
		allowNoDatabase: true,
		skipMigrations: true,
	});
	return runtime;
}

describe("discord plugin registers its installation contribution at init", () => {
	it("awaits the lifecycle service and registers the discord contribution", async () => {
		const runtime = await bootRuntime({
			name: "discord-install-wiring",
			settings: { DISCORD_APPLICATION_ID: "123456789012345678" },
		});
		// The plugin registers via a fire-and-forget load-promise callback
		// (awaiting it inside init would deadlock the boot barrier). The
		// callback lands on the service-start microtask chain; vi.waitFor
		// polls it deterministically instead of racing it.
		await vi.waitFor(async () => {
			await runtime.getServiceLoadPromise(ServiceType.INSTALLATION);
			expect(
				runtime
					.getService<InstallationLifecycleService>(ServiceType.INSTALLATION)
					?.getContribution("discord"),
			).not.toBeNull();
		});
		// init awaited getServiceLoadPromise(INSTALLATION); the real service
		// instance must now carry the discord contribution.
		const service = runtime.getService<InstallationLifecycleService>(
			ServiceType.INSTALLATION,
		);
		expect(service).not.toBeNull();
		const contribution = service?.getContribution("discord");
		expect(contribution).not.toBeNull();
		expect(contribution?.connectorId).toBe("discord");
		expect(contribution?.groupTypes).toContain("server");
		// The tiered invite URL activation is built from DISCORD_APPLICATION_ID.
		expect(contribution?.activation.kind).toBe("oauth_install_url");
	});

	it("still boots cleanly when the lifecycle service is disabled (degrades, no throw)", async () => {
		const runtime = await bootRuntime(
			{
				name: "discord-install-absent",
				settings: { DISCORD_APPLICATION_ID: "123456789012345678" },
			},
			true,
		);
		expect(runtime.getService(ServiceType.INSTALLATION)).toBeNull();
	});
});
