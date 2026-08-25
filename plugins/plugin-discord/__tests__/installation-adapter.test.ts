/**
 * Tests for the Discord installation-lifecycle adapter: contribution shape
 * (canonical permission catalog, tiered invite URL activation), event
 * normalization (guildCreate/guildDelete only, unknown shapes refused), and
 * the honest non-linear evidence prefix reported at the guildCreate seam.
 * Deterministic harness against the in-memory core service; no Discord
 * credentials, no network.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { InstallationLifecycleService, stringToUuid } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	buildDiscordInstallationContribution,
	DISCORD_INSTALLATION_SCOPE_REQUIREMENTS,
	discordInstallationAllowsTraffic,
	registerDiscordInstallationContribution,
	reportDiscordGuildJoined,
	reportDiscordGuildRemoved,
} from "./installation-adapter";

const agentId = stringToUuid("agent");

function makeRuntime(service: InstallationLifecycleService): IAgentRuntime {
	return {
		agentId,
		getService: () => service,
	} as unknown as IAgentRuntime;
}

describe("discord installation contribution", () => {
	it("maps every required BASIC-tier permission bit to a neutral capability", () => {
		const ids = DISCORD_INSTALLATION_SCOPE_REQUIREMENTS.map(
			(r) => r.providerScopeId,
		);
		expect(ids).toContain("ViewChannel");
		expect(ids).toContain("SendMessages");
		expect(ids).toContain("UseApplicationCommands");
		const required = DISCORD_INSTALLATION_SCOPE_REQUIREMENTS.filter(
			(r) => r.required,
		);
		expect(required.map((r) => r.capability).sort()).toEqual([
			"interactions",
			"receive",
			"send",
		]);
	});

	it("builds an oauth activation with the tiered invite URL when application id is known", () => {
		const contribution =
			buildDiscordInstallationContribution("123456789012345678");
		expect(contribution.activation.kind).toBe("oauth_install_url");
		expect(contribution.activation.installUrl).toContain(
			"discord.com/api/oauth2/authorize",
		);
		expect(contribution.activation.installUrl).toContain("123456789012345678");
		expect(contribution.activation.steps.length).toBeGreaterThan(0);
	});

	it("contribution without application id still validates (steps remain truthful)", () => {
		const contribution = buildDiscordInstallationContribution(null);
		expect(contribution.activation.installUrl).toBeUndefined();
		const service = new InstallationLifecycleService();
		expect(() => service.registerContribution(contribution)).not.toThrow();
	});

	it("normalizeEvent accepts guildCreate/guildDelete and refuses unknown shapes", () => {
		const contribution = buildDiscordInstallationContribution(null);
		const joined = contribution.normalizeEvent({
			type: "guildCreate",
			guildId: "g1",
			worldId: stringToUuid("w1"),
			generation: 1,
			observedAt: "2026-08-25T12:00:00Z",
			eventId: "e1",
		});
		expect(joined.ok).toBe(true);
		if (joined.ok) {
			expect(joined.transition.kind).toBe("agent_joined");
			expect(joined.idempotencyKey).toBe("discord:guildCreate:e1");
		}
		const removed = contribution.normalizeEvent({
			type: "guildDelete",
			guildId: "g1",
			generation: 3,
			observedAt: "2026-08-25T12:00:00Z",
			eventId: "e2",
		});
		expect(removed.ok).toBe(true);
		const unknown = contribution.normalizeEvent({
			type: "inviteCreate",
			guildId: "g1",
		});
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) {
			expect(unknown.reason).toContain("unsupported provider event");
		}
	});
});

describe("discord installation reporting", () => {
	it("guildCreate reports the honest non-linear evidence prefix and lands in permissions_verifying", async () => {
		const service = new InstallationLifecycleService();
		const runtime = makeRuntime(service);
		const state = await reportDiscordGuildJoined(runtime, {
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "123456789012345678",
			guildName: "Test Guild",
			worldId: stringToUuid("world"),
		});
		expect(state).toBe("permissions_verifying");
		const record = service.get({
			agentId,
			connectorId: "discord",
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "123456789012345678",
		});
		expect(record).not.toBeNull();
		expect(record?.state).toBe("permissions_verifying");
		expect(record?.worldId).toBe(stringToUuid("world"));
		expect(record?.externalGroupLabel).toBe("Test Guild");
		// the required capability catalog came from the contribution constants
		expect(record?.requiredCapabilities.sort()).toEqual([
			"interactions",
			"receive",
			"send",
		]);
	});

	it("guildCreate is idempotent per guild (replay does not advance generation)", async () => {
		const service = new InstallationLifecycleService();
		const runtime = makeRuntime(service);
		await reportDiscordGuildJoined(runtime, {
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "g1",
			guildName: "G1",
			worldId: stringToUuid("w1"),
		});
		const first = service.get({
			agentId,
			connectorId: "discord",
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "g1",
		});
		await reportDiscordGuildJoined(runtime, {
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "g1",
			guildName: "G1",
			worldId: stringToUuid("w1"),
		});
		const second = service.get({
			agentId,
			connectorId: "discord",
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "g1",
		});
		expect(second?.generation).toBe(first?.generation);
		expect(second?.state).toBe(first?.state);
	});

	it("guildDelete removes the installation and fences a late guildCreate replay", async () => {
		const service = new InstallationLifecycleService();
		const runtime = makeRuntime(service);
		await reportDiscordGuildJoined(runtime, {
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "g1",
			guildName: "G1",
			worldId: stringToUuid("w1"),
		});
		const removed = await reportDiscordGuildRemoved(runtime, {
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "g1",
		});
		expect(removed).toBe(true);
		const record = service.get({
			agentId,
			connectorId: "discord",
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "g1",
		});
		expect(record?.state).toBe("removed");
		expect(record?.removedAt).not.toBeNull();
		// a stale join replay (observedGeneration 1 < removed record's generation) is fenced
		const stale = service.apply({
			contractVersion: 1,
			scope: {
				agentId,
				connectorId: "discord",
				connectorAccountId: stringToUuid("acct"),
				externalWorldId: "g1",
			},
			// Same epoch as the live record so the epoch guards pass and the
			// STALE_GENERATION verdict comes from the generation fence itself
			// (an undefined reinstallVersion would be rejected by the integer
			// check instead — a false positive, not the fence under test).
			reinstallVersion: 1,
			observedGeneration: 1,
			observedAt: "2026-08-25T13:00:00Z",
			idempotencyKey: "discord:g1:late-replay-join",
			transition: { kind: "agent_joined", worldId: stringToUuid("w1") },
		});
		expect(stale.accepted).toBe(false);
		expect(stale.rejection?.code).toBe("STALE_GENERATION");
	});

	it("rejoining after removal re-creates the installation with a bumped reinstallVersion", async () => {
		const service = new InstallationLifecycleService();
		const runtime = makeRuntime(service);
		await reportDiscordGuildJoined(runtime, {
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "g1",
			guildName: "G1",
			worldId: stringToUuid("w1"),
		});
		await reportDiscordGuildRemoved(runtime, {
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "g1",
		});
		await reportDiscordGuildJoined(runtime, {
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "g1",
			guildName: "G1",
			worldId: stringToUuid("w1"),
		});
		const record = service.get({
			agentId,
			connectorId: "discord",
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "g1",
		});
		expect(record?.reinstallVersion).toBe(2);
		expect(record?.state).toBe("permissions_verifying");
	});

	it("a second removal after rejoin lands on the new record, not a cached receipt (round-1)", async () => {
		const service = new InstallationLifecycleService();
		const runtime = makeRuntime(service);
		const scopeFor = (worldId: string) => ({
			agentId,
			connectorId: "discord",
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: worldId,
		});
		await reportDiscordGuildJoined(runtime, {
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "g2",
			guildName: "G2",
			worldId: stringToUuid("w2"),
		});
		expect(
			await reportDiscordGuildRemoved(runtime, {
				connectorAccountId: stringToUuid("acct"),
				externalWorldId: "g2",
			}),
		).toBe(true);
		// Rejoin recreates at reinstallVersion 2.
		await reportDiscordGuildJoined(runtime, {
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "g2",
			guildName: "G2",
			worldId: stringToUuid("w2"),
		});
		expect(service.get(scopeFor("g2"))?.reinstallVersion).toBe(2);
		expect(service.get(scopeFor("g2"))?.state).toBe("permissions_verifying");
		// The SECOND removal must actually remove the epoch-2 record.
		const secondRemoval = await reportDiscordGuildRemoved(runtime, {
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "g2",
		});
		expect(secondRemoval).toBe(true);
		expect(service.get(scopeFor("g2"))?.state).toBe("removed");
		expect(service.get(scopeFor("g2"))?.reinstallVersion).toBe(2);
	});

	it("guildDelete for a never-installed guild returns false instead of throwing (round-1)", async () => {
		const service = new InstallationLifecycleService();
		const runtime = makeRuntime(service);
		const result = await reportDiscordGuildRemoved(runtime, {
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "never-installed",
		});
		expect(result).toBe(false);
	});

	it("guildCreate replay after a restart-wiped service is connector_observed evidence, never oauth_verified (round-1)", async () => {
		const service = new InstallationLifecycleService();
		const runtime = makeRuntime(service);
		await reportDiscordGuildJoined(runtime, {
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "g3",
			guildName: "G3",
			worldId: stringToUuid("w3"),
		});
		const record = service.get({
			agentId,
			connectorId: "discord",
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "g3",
		});
		expect(record?.providerAuthorizationEvidence).toBe("connector_observed");
	});

	it("without the installation service the reporting degrades to rejected/false, never throws", async () => {
		const runtime = {
			agentId,
			getService: () => null,
		} as unknown as IAgentRuntime;
		const state = await reportDiscordGuildJoined(runtime, {
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "g1",
			guildName: "G1",
			worldId: stringToUuid("w1"),
		});
		expect(state).toBe("rejected");
		const removed = await reportDiscordGuildRemoved(runtime, {
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "g1",
		});
		expect(removed).toBe(false);
	});

	it("registerDiscordInstallationContribution is idempotent", () => {
		const service = new InstallationLifecycleService();
		const runtime = makeRuntime(service);
		registerDiscordInstallationContribution(runtime, "123");
		registerDiscordInstallationContribution(runtime, "123");
		expect(service.listConnectorIds()).toEqual(["discord"]);
		expect(service.getContribution("discord")?.activation.installUrl).toContain(
			"123",
		);
	});
});

describe("discord installation traffic gate", () => {
	it("a terminal installation record stops outbound traffic", async () => {
		const service = new InstallationLifecycleService();
		const runtime = makeRuntime(service);
		const input = {
			connectorAccountId: stringToUuid("acct"),
			externalWorldId: "g1",
		};
		// Before any record: grandfathered, traffic flows.
		expect(discordInstallationAllowsTraffic(runtime, input)).toBe(true);
		await reportDiscordGuildJoined(runtime, {
			...input,
			guildName: "G1",
			worldId: stringToUuid("w1"),
		});
		// Non-terminal, non-ready record: onboarding traffic continues (the
		// strict ready gate is the next tranche's boundary).
		expect(discordInstallationAllowsTraffic(runtime, input)).toBe(true);
		await reportDiscordGuildRemoved(runtime, input);
		// THE ROUND-1 DEFECT: removal was recorded but traffic kept flowing —
		// the lifecycle was observational only. A terminal record must gate.
		expect(discordInstallationAllowsTraffic(runtime, input)).toBe(false);
	});

	it("a guild with no installation record (grandfathered) never gates", () => {
		const service = new InstallationLifecycleService();
		const runtime = makeRuntime(service);
		expect(
			discordInstallationAllowsTraffic(runtime, {
				connectorAccountId: stringToUuid("acct"),
				externalWorldId: "never-seen",
			}),
		).toBe(true);
	});

	it("a missing installation service never gates (connector keeps running)", () => {
		const runtime = makeRuntime(new InstallationLifecycleService());
		// Simulate the service being absent: getService returns undefined.
		const bareRuntime = {
			...runtime,
			getService: () => undefined,
		} as unknown as typeof runtime;
		expect(
			discordInstallationAllowsTraffic(bareRuntime, {
				connectorAccountId: stringToUuid("acct"),
				externalWorldId: "g1",
			}),
		).toBe(true);
	});
});
