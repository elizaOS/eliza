/**
 * Discord pilot adapter for the canonical group installation lifecycle
 * (core `installation-lifecycle.ts` / `installation-contribution.ts`). Owns
 * the connector contribution catalog entry (group types, permission-tier
 * scope requirements from permissions.ts, tiered invite-URL activation) and
 * the reporting helpers DiscordService calls at the guild-join and
 * guild-removal seams. Evidence is reported honestly: Discord delivers
 * guildCreate without a preceding recorded invite, so the adapter synthesizes
 * the invite_created + provider_authorized + agent_joined prefix explicitly
 * labeled as connector-observed (non-linear evidence), never fabricating an
 * OAuth milestone.
 */

import type {
	IAgentRuntime,
	InstallationScopeRequirement,
	UUID,
} from "@elizaos/core";
import {
	type ConnectorInstallationContribution,
	createUniqueUuid,
	type GroupInstallationRecord,
	INSTALLATION_CONTRIBUTION_VERSION,
	INSTALLATION_LIFECYCLE_CONTRACT_VERSION,
	type InstallationCapabilityReadiness,
	type InstallationLifecycleService,
	type InstallationScope,
	type InstallationTransitionEvent,
	isInstallationLifecycleService,
} from "@elizaos/core";
import { generateInviteUrl } from "./permissions";

/**
 * Canonical Discord scope requirements: one row per provider permission bit
 * the BASIC text tier demands, mapped onto the neutral capability set. This
 * single catalog is what URLs, UI, and diagnostics should read.
 */
export const DISCORD_INSTALLATION_SCOPE_REQUIREMENTS: readonly InstallationScopeRequirement[] =
	[
		{ providerScopeId: "ViewChannel", capability: "receive", required: true },
		{ providerScopeId: "SendMessages", capability: "send", required: true },
		{
			providerScopeId: "AttachFiles",
			capability: "attachments",
			required: false,
		},
		{
			providerScopeId: "ReadMessageHistory",
			capability: "history",
			required: false,
		},
		{
			providerScopeId: "SendMessagesInThreads",
			capability: "threads",
			required: false,
		},
		{
			providerScopeId: "UseApplicationCommands",
			capability: "interactions",
			required: true,
		},
	];

const REQUIRED_CAPABILITIES = DISCORD_INSTALLATION_SCOPE_REQUIREMENTS.filter(
	(r) => r.required,
).map((r) => r.capability);
const OPTIONAL_CAPABILITIES = DISCORD_INSTALLATION_SCOPE_REQUIREMENTS.filter(
	(r) => !r.required,
).map((r) => r.capability);

/** Build the Discord contribution for one application id (invite URL is tier-derived). */
export function buildDiscordInstallationContribution(
	applicationId: string | null,
): ConnectorInstallationContribution {
	// Without a known application id we cannot offer an honest install URL, so
	// the activation degrades to truthful manual steps instead.
	const activation = applicationId
		? ({
				kind: "oauth_install_url",
				installUrl: generateInviteUrl(applicationId, "BASIC"),
				steps: [
					{
						instruction:
							"Open the invite link, pick your server, and approve the listed permissions. The agent joins once the install completes.",
					},
				],
			} as const)
		: ({
				kind: "manual_admin_steps",
				steps: [
					{
						instruction:
							"Discord application id is not configured; generate a bot invite from the Discord Developer Portal (OAuth2 → URL Generator, scopes bot + applications.commands) and add the agent to your server.",
					},
				],
			} as const);
	return {
		contributionVersion: INSTALLATION_CONTRIBUTION_VERSION,
		connectorId: "discord",
		groupTypes: ["server"],
		scopeRequirements: DISCORD_INSTALLATION_SCOPE_REQUIREMENTS,
		activation,
		normalizeEvent: (providerEvent) => {
			const evt = providerEvent as {
				type?: string;
				guildId?: string;
				worldId?: string;
				generation?: number;
				observedAt?: string;
				eventId?: string;
			};
			if (evt?.type === "guildCreate" && evt.guildId && evt.worldId) {
				return {
					ok: true as const,
					transition: {
						kind: "agent_joined" as const,
						worldId: evt.worldId as UUID,
					},
					observedGeneration: evt.generation ?? 1,
					observedAt: evt.observedAt ?? new Date().toISOString(),
					idempotencyKey: `discord:guildCreate:${evt.eventId ?? evt.guildId}`,
				};
			}
			if (evt?.type === "guildDelete" && evt.guildId) {
				return {
					ok: true as const,
					transition: { kind: "removal" as const, reason: "kicked" as const },
					observedGeneration: evt.generation ?? 1,
					observedAt: evt.observedAt ?? new Date().toISOString(),
					idempotencyKey: `discord:guildDelete:${evt.eventId ?? evt.guildId}`,
				};
			}
			return {
				ok: false as const,
				reason: `unsupported provider event: ${evt?.type ?? "unknown"}`,
			};
		},
		describeReadiness: (
			readiness: readonly InstallationCapabilityReadiness[],
		) => ({
			connector: "discord",
			proven: readiness
				.filter((r) => r.verifiedAt !== null)
				.map((r) => r.capability),
			unproven: readiness
				.filter((r) => r.verifiedAt === null)
				.map((r) => r.capability),
		}),
	};
}

function resolveService(
	runtime: IAgentRuntime,
): InstallationLifecycleService | null {
	const service = runtime.getService("installation");
	return isInstallationLifecycleService(service) ? service : null;
}

/**
 * Traffic gate for a guild scope: returns true when Discord traffic may flow.
 * Installs that never reached the lifecycle service (service missing, or no
 * record — e.g. a guild joined before this feature shipped, or a record
 * wiped by restart) run in grandfathered observability mode and traffic
 * continues. The enforced boundary in this tranche is the issue's removal
 * criterion: a terminal record (removed/revoked/failed) stops all outbound
 * traffic. Strict ready-gating (state === "ready") activates when the
 * claim-issuance and capability-proof minting seams land in the next
 * tranche — enforcing it today would silence every onboarding guild because
 * nothing drives a record to ready yet.
 */
export function discordInstallationAllowsTraffic(
	runtime: IAgentRuntime,
	input: {
		connectorAccountId: UUID;
		externalWorldId: string;
	},
): boolean {
	const service = resolveService(runtime);
	if (!service) return true;
	const scope: InstallationScope = {
		agentId: runtime.agentId,
		connectorId: "discord",
		connectorAccountId: input.connectorAccountId,
		externalWorldId: input.externalWorldId,
	};
	const record = service.get(scope);
	if (!record) return true;
	if (
		record.state === "removed" ||
		record.state === "revoked" ||
		record.state === "failed"
	) {
		return false;
	}
	return true;
}

/**
 * Report the agent joining a guild (guildCreate seam). Synthesizes the
 * honest evidence prefix (invite_created + provider_authorized are
 * connector-observed, not OAuth-proven) then the join itself, and enqueues
 * the permissions-verifying stage with the canonical Discord capability
 * catalog. Returns the resulting record's state for logging.
 */
export async function reportDiscordGuildJoined(
	runtime: IAgentRuntime,
	input: {
		connectorAccountId: UUID;
		externalWorldId: string;
		guildName: string;
		worldId: UUID;
		/**
		 * Provider-observed join timestamp (guild.joinedAt — when the bot
		 * actually joined, per Discord). Used as observedAt for the
		 * recreate-critical invite_created so a delayed re-delivery of an
		 * OLD guildCreate (processed after a removal) carries the OLD join
		 * time and is fenced by the removal-ordering check; a genuine
		 * re-invite carries a fresh joinedAt. Falls back to now only when
		 * Discord does not supply one (rare; at that point ordering falls
		 * back to local observation honesty).
		 */
		joinedAt?: string | null;
	},
): Promise<"ready" | "degraded" | "permissions_verifying" | "rejected"> {
	const service = resolveService(runtime);
	if (!service) return "rejected";
	const scope: InstallationScope = {
		agentId: runtime.agentId,
		connectorId: "discord",
		connectorAccountId: input.connectorAccountId,
		externalWorldId: input.externalWorldId,
	};
	const observedAt = new Date().toISOString();
	// Provider ordering token: the invite that (re)creates the installation
	// is observed at the provider's join time, not local clock time, so the
	// reducer's removal-ordering fence can distinguish a genuine re-invite
	// (joinedAt after the removal) from a delayed old guildCreate redelivery
	// (joinedAt before the removal).
	const inviteObservedAt =
		typeof input.joinedAt === "string" &&
		!Number.isNaN(Date.parse(input.joinedAt))
			? input.joinedAt
			: observedAt;
	// Live reads per event: the record advances with every accepted apply,
	// and the reducer's dual fence (epoch + generation) rejects events whose
	// numbers are behind OR ahead of the live record, so each event must
	// observe the record as it stands when that event is minted.
	const live = (): GroupInstallationRecord | null => service.get(scope);
	const currentGeneration = (): number => {
		const record = live();
		// A terminal record from a PRIOR installation is about to be recreated
		// by this flow's invite_created; the recreated record resets its
		// generation counter, so the prefix events must observe epoch+1/gen 1.
		if (
			record &&
			(record.state === "removed" ||
				record.state === "revoked" ||
				record.state === "failed")
		) {
			return 1;
		}
		return record?.generation ?? 1;
	};
	const currentEpoch = (): number => {
		const record = live();
		if (
			record &&
			(record.state === "removed" ||
				record.state === "revoked" ||
				record.state === "failed")
		) {
			return record.reinstallVersion + 1;
		}
		// A scope with no record yet starts at epoch 1 (the reducer's initial
		// creation epoch), NOT 0: an epoch-0 event against the freshly created
		// epoch-1 record would be fenced as a stale epoch and the whole join
		// prefix would silently reject.
		return record?.reinstallVersion ?? 1;
	};
	// Stable per-guild keys per reinstall epoch: a discord.js guildCreate replay
	// (reconnect) hits the idempotency log and is a no-op, while a genuine
	// re-invite after removal is uncached by the service's cross-epoch replay
	// guard and runs at reinstallVersion + 1 with fresh state.
	const mk = (
		idempotencyKey: string,
		transition: InstallationTransitionEvent["transition"],
		observedAtOverride?: string,
	): InstallationTransitionEvent => ({
		contractVersion: INSTALLATION_LIFECYCLE_CONTRACT_VERSION,
		scope,
		reinstallVersion: currentEpoch(),
		observedGeneration: currentGeneration(),
		observedAt: observedAtOverride ?? observedAt,
		idempotencyKey: `discord:${input.externalWorldId}:v${currentEpoch()}:${idempotencyKey}`,
		transition,
	});
	// Honest non-linear evidence prefix: guildCreate is connector-
	// observed, so provider_authorized carries evidence: "connector_observed"
	// — a downstream consumer can distinguish it from an OAuth-verified
	// authorization milestone instead of trusting a comment.
	service.apply(
		mk(
			`guildCreate:${input.externalWorldId}:invite`,
			{ kind: "invite_created", externalGroupLabel: input.guildName },
			inviteObservedAt,
		),
	);
	service.apply(
		mk(`guildCreate:${input.externalWorldId}:authorized`, {
			kind: "provider_authorized",
			evidence: "connector_observed",
		}),
	);
	service.apply(
		mk(`guildCreate:${input.externalWorldId}:joined`, {
			kind: "agent_joined",
			worldId: input.worldId,
		}),
	);
	const verifying = service.apply(
		mk(`guildCreate:${input.externalWorldId}:verifying`, {
			kind: "permissions_verifying",
			requiredCapabilities: REQUIRED_CAPABILITIES,
			optionalCapabilities: OPTIONAL_CAPABILITIES,
		}),
	);
	if (!verifying.accepted) return "rejected";
	return verifying.record.state as
		| "permissions_verifying"
		| "ready"
		| "degraded";
}

/**
 * Report guild removal (guildDelete seam). Uses the current record
 * generation as observedGeneration so a live removal always lands; the
 * stale-event guard then fences any late event from the dead installation.
 */
export async function reportDiscordGuildRemoved(
	runtime: IAgentRuntime,
	input: {
		connectorAccountId: UUID;
		externalWorldId: string;
	},
): Promise<boolean> {
	const service = resolveService(runtime);
	if (!service) return false;
	const scope: InstallationScope = {
		agentId: runtime.agentId,
		connectorId: "discord",
		connectorAccountId: input.connectorAccountId,
		externalWorldId: input.externalWorldId,
	};
	const existing = service.get(scope);
	// No record for this guild (never installed, or wiped by a restart):
	// report honest absence instead of letting the reducer throw on a
	// removal-without-record.
	if (!existing) return false;
	const receipt = service.apply({
		contractVersion: INSTALLATION_LIFECYCLE_CONTRACT_VERSION,
		scope,
		reinstallVersion: existing.reinstallVersion,
		observedGeneration: existing.generation,
		observedAt: new Date().toISOString(),
		idempotencyKey: `discord:${input.externalWorldId}:v${existing.reinstallVersion}:guildDelete`,
		transition: { kind: "removal", reason: "kicked" },
	});
	return receipt.accepted;
}

/**
 * Register the Discord contribution once at service start (idempotent).
 * Accepts the service instance directly so load-promise callers — which
 * receive the started instance — can register without a second sync lookup
 * racing the service map write.
 */
export function registerDiscordInstallationContribution(
	runtime: IAgentRuntime,
	applicationId: string | null,
	service?: InstallationLifecycleService,
): void {
	const resolved = service ?? resolveService(runtime);
	if (!resolved) return;
	if (resolved.getContribution("discord")) return;
	resolved.registerContribution(
		buildDiscordInstallationContribution(applicationId),
	);
}

export type { InstallationLifecycleService };
export { createUniqueUuid };
