/**
 * Connector installation contribution contract: the provider-specific surface
 * each group-capable connector registers against the canonical installation
 * lifecycle (installation-lifecycle.ts). One catalog instance per connector
 * describes what "installed" means for its provider — group types, capability
 * scopes, install/deep links, and provider-specific activation steps — so
 * URLs, UI, and diagnostics all read from this one source instead of
 * duplicated per-connector permission semantics.
 */

import type {
	GroupInstallationRecord,
	InstallationCapability,
	InstallationCapabilityReadiness,
	InstallationScope,
} from "./installation-lifecycle";

export const INSTALLATION_CONTRIBUTION_VERSION = 1 as const;

/** Group archetypes a provider can install the agent into. */
export const INSTALLATION_GROUP_TYPES = [
	"server",
	"channel_group",
	"dm",
	"topic",
] as const;
export type InstallationGroupType = (typeof INSTALLATION_GROUP_TYPES)[number];

/** How a provider honestly onboards: real invite links vs. manual activation steps. */
export const INSTALLATION_ACTIVATION_KINDS = [
	"oauth_install_url",
	"deep_link",
	"manual_admin_steps",
] as const;
export type InstallationActivationKind =
	(typeof INSTALLATION_ACTIVATION_KINDS)[number];

export interface InstallationActivationStep {
	/** Plain-language step shown in UI/diagnostics (e.g. "Open Discord Server Settings → Integrations"). */
	instruction: string;
	/** Optional deep link the step can navigate to. */
	url?: string;
}

export interface InstallationActivation {
	kind: InstallationActivationKind;
	/** Install URL template for oauth_install_url providers (bot scope/permissions already encoded). */
	installUrl?: string;
	/** Truthful manual steps for providers that cannot offer a universal invite button. */
	steps: readonly InstallationActivationStep[];
}

/** A provider permission scope demanded by one capability. */
export interface InstallationScopeRequirement {
	/** Provider-native scope identifier (e.g. a Discord permission bit name). */
	providerScopeId: string;
	capability: InstallationCapability;
	required: boolean;
}

export interface InstallationCapabilityProbe {
	capability: InstallationCapability;
	/**
	 * Connector-side proof check against the live provider state. Returns a
	 * JsonObject receipt (never a token) plus verifiedAt, or null when the
	 * capability cannot currently be proven.
	 */
	probe: (scope: InstallationScope) => Promise<{
		proof: import("../types/primitives").JsonObject;
		verifiedAt: string;
	} | null>;
}

export interface ConnectorInstallationContribution {
	contributionVersion: typeof INSTALLATION_CONTRIBUTION_VERSION;
	/** Stable connector id matching InstallationScope.connectorId (e.g. "discord"). */
	connectorId: string;
	/** Group types this provider supports for group installation. */
	groupTypes: readonly InstallationGroupType[];
	/** Canonical permission catalog: every capability this provider demands and its provider scope ids. */
	scopeRequirements: readonly InstallationScopeRequirement[];
	/** Provider-honest activation surfaces. */
	activation: InstallationActivation;
	/**
	 * Normalize a signed provider callback/event into an installation
	 * transition input. The connector has already authenticated the payload;
	 * this maps it onto the canonical machine (and refuses unknown shapes).
	 */
	normalizeEvent: (authenticatedProviderEvent: unknown) =>
		| {
				ok: true;
				transition: import("./installation-lifecycle").InstallationTransitionInput;
				observedGeneration: number;
				observedAt: string;
				idempotencyKey: string;
		  }
		| { ok: false; reason: string };
	/** Optional live capability probes for readiness verification. */
	capabilityProbes?: readonly InstallationCapabilityProbe[];
	/** Readiness evidence for diagnostics: which capabilities this provider can prove right now. */
	describeReadiness: (
		readiness: readonly InstallationCapabilityReadiness[],
	) => Record<string, unknown>;
}

/** Registry contract: the runtime-side catalog connectors register into. */
export interface InstallationContributionRegistry {
	registerContribution(contribution: ConnectorInstallationContribution): void;
	getContribution(
		connectorId: string,
	): ConnectorInstallationContribution | null;
	listConnectorIds(): readonly string[];
}

/**
 * Validate a contribution at registration time so malformed connector
 * registrations fail loudly instead of poisoning the catalog.
 */
export function validateInstallationContribution(
	contribution: ConnectorInstallationContribution,
): string[] {
	const problems: string[] = [];
	if (contribution.contributionVersion !== INSTALLATION_CONTRIBUTION_VERSION) {
		problems.push(
			`contributionVersion must be ${INSTALLATION_CONTRIBUTION_VERSION}`,
		);
	}
	if (!contribution.connectorId) {
		problems.push("connectorId is required");
	}
	if (contribution.groupTypes.length === 0) {
		problems.push("at least one group type is required");
	}
	for (const requirement of contribution.scopeRequirements) {
		if (!requirement.providerScopeId) {
			problems.push("scopeRequirements entry missing providerScopeId");
		}
		if (contribution.groupTypes.length > 0 && !requirement.capability) {
			problems.push("scopeRequirements entry missing capability");
		}
	}
	if (
		contribution.activation.kind === "oauth_install_url" &&
		!contribution.activation.installUrl
	) {
		problems.push("oauth_install_url activation requires installUrl");
	}
	if (contribution.activation.steps.length === 0) {
		problems.push("activation must carry at least one truthful step");
	}
	return problems;
}

export type { GroupInstallationRecord };
