import { ChannelType } from "./types/primitives";

export type SensitiveRequestKind =
	| "secret"
	| "payment"
	| "oauth"
	| "private_info";

export type SensitiveRequestStatus =
	| "pending"
	| "fulfilled"
	| "failed"
	| "canceled"
	| "expired";

export type SensitiveRequestPaymentContext = "verified_payer" | "any_payer";

export type SensitiveRequestActorPolicy =
	| "owner_or_linked_identity"
	| "organization_admin"
	| "verified_payer"
	| "any_payer";

export type SensitiveRequestSourceContext =
	| "owner_app_private"
	| "dm"
	| "public"
	| "api"
	| "unknown";

export type SensitiveRequestDeliveryMode =
	| "inline_owner_app"
	| "private_dm"
	| "cloud_authenticated_link"
	| "tunnel_authenticated_link"
	| "public_link"
	| "dm_or_owner_app_instruction";

export interface SensitiveRequestEnvironment {
	cloud?: {
		available: boolean;
		baseUrl?: string;
	};
	tunnel?: {
		available: boolean;
		url?: string;
		/**
		 * Tunnel reachability is not an auth boundary. This must be true only when
		 * the tunneled sensitive-request route enforces owner/session auth.
		 */
		authenticated: boolean;
	};
	dm?: {
		available: boolean;
	};
	ownerApp?: {
		privateChat: boolean;
	};
}

export interface SensitiveRequestPolicyInput {
	kind: SensitiveRequestKind;
	channelType?: string;
	source?: SensitiveRequestSourceContext;
	paymentContext?: SensitiveRequestPaymentContext;
	environment?: SensitiveRequestEnvironment;
}

export interface SensitiveRequestPolicy {
	actor: SensitiveRequestActorPolicy;
	requirePrivateDelivery: boolean;
	requireAuthenticatedLink: boolean;
	allowInlineOwnerAppEntry: boolean;
	allowPublicLink: boolean;
	allowDmFallback: boolean;
	allowTunnelLink: boolean;
	allowCloudLink: boolean;
}

export interface SensitiveRequestSecretTarget {
	kind: "secret";
	key: string;
	scope?: "organization" | "app" | "agent" | "global" | (string & {});
	appId?: string;
	validation?: Record<string, unknown>;
}

export interface SensitiveRequestPrivateInfoField {
	name: string;
	label?: string;
	required?: boolean;
	classification?: string;
}

export interface SensitiveRequestPrivateInfoTarget {
	kind: "private_info";
	fields: SensitiveRequestPrivateInfoField[];
	storage?: {
		kind: string;
		key?: string;
	};
}

export interface SensitiveRequestPaymentTarget {
	kind: "payment";
	[key: string]: unknown;
}

export interface SensitiveRequestOauthTarget {
	kind: "oauth";
	[key: string]: unknown;
}

export type SensitiveRequestTarget =
	| SensitiveRequestSecretTarget
	| SensitiveRequestPrivateInfoTarget
	| SensitiveRequestPaymentTarget
	| SensitiveRequestOauthTarget;

export interface SensitiveRequestCallback {
	kind?: string;
	url?: string;
	roomId?: string;
	channelId?: string;
	[key: string]: unknown;
}

export interface SensitiveRequest {
	id: string;
	kind: SensitiveRequestKind;
	status: SensitiveRequestStatus;
	agentId: string;
	organizationId?: string | null;
	ownerEntityId?: string | null;
	requesterEntityId?: string | null;
	sourceRoomId?: string | null;
	sourceChannelType?: string | null;
	sourcePlatform?: string | null;
	target: SensitiveRequestTarget;
	policy: SensitiveRequestPolicy;
	delivery: SensitiveRequestDeliveryPlan;
	callback?: SensitiveRequestCallback;
	expiresAt: string;
	fulfilledAt?: string | null;
	canceledAt?: string | null;
	expiredAt?: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface SensitiveRequestEvent {
	kind: string;
	requestId: string;
	[key: string]: unknown;
}

export interface SensitiveRequestDeliveryPlan {
	kind: SensitiveRequestKind;
	source: SensitiveRequestSourceContext;
	mode: SensitiveRequestDeliveryMode;
	policy: SensitiveRequestPolicy;
	privateRouteRequired: boolean;
	publicLinkAllowed: boolean;
	authenticated: boolean;
	canCollectValueInCurrentChannel: boolean;
	linkBaseUrl?: string;
	reason: string;
	instruction: string;
}

const SENSITIVE_REQUEST_METADATA_KEY_RE =
	/(^|[_-])(authorization|bearer|credential|jwt|password|private|secret|signature|token)([_-]|$)|api[_-]?key/i;

export function redactSensitiveRequestMetadata(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => redactSensitiveRequestMetadata(item));
	}

	if (!value || typeof value !== "object") {
		return value;
	}

	const redacted: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(
		value as Record<string, unknown>,
	)) {
		redacted[key] = SENSITIVE_REQUEST_METADATA_KEY_RE.test(key)
			? "[redacted]"
			: redactSensitiveRequestMetadata(item);
	}
	return redacted;
}

function isTruthy(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return false;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function classifySensitiveRequestSource(input: {
	channelType?: string;
	source?: SensitiveRequestSourceContext;
	ownerAppPrivateChat?: boolean;
}): SensitiveRequestSourceContext {
	if (input.source) return input.source;
	if (input.ownerAppPrivateChat) return "owner_app_private";

	switch (input.channelType) {
		case ChannelType.DM:
		case ChannelType.VOICE_DM:
		case ChannelType.SELF:
			return "dm";
		case ChannelType.API:
			return "api";
		case ChannelType.GROUP:
		case ChannelType.VOICE_GROUP:
		case ChannelType.FEED:
		case ChannelType.THREAD:
		case ChannelType.WORLD:
		case ChannelType.FORUM:
			return "public";
		default:
			return "unknown";
	}
}

export function defaultSensitiveRequestPolicy(
	kind: SensitiveRequestKind,
	paymentContext: SensitiveRequestPaymentContext = "verified_payer",
): SensitiveRequestPolicy {
	if (kind === "payment" && paymentContext === "any_payer") {
		return {
			actor: "any_payer",
			requirePrivateDelivery: false,
			requireAuthenticatedLink: false,
			allowInlineOwnerAppEntry: true,
			allowPublicLink: true,
			allowDmFallback: true,
			allowTunnelLink: true,
			allowCloudLink: true,
		};
	}

	if (kind === "payment") {
		return {
			actor: "verified_payer",
			requirePrivateDelivery: false,
			requireAuthenticatedLink: true,
			allowInlineOwnerAppEntry: true,
			allowPublicLink: true,
			allowDmFallback: true,
			allowTunnelLink: true,
			allowCloudLink: true,
		};
	}

	if (kind === "oauth") {
		return {
			actor: "owner_or_linked_identity",
			requirePrivateDelivery: false,
			requireAuthenticatedLink: true,
			allowInlineOwnerAppEntry: true,
			allowPublicLink: true,
			allowDmFallback: true,
			allowTunnelLink: true,
			allowCloudLink: true,
		};
	}

	return {
		actor: "owner_or_linked_identity",
		requirePrivateDelivery: true,
		requireAuthenticatedLink: true,
		allowInlineOwnerAppEntry: true,
		allowPublicLink: false,
		allowDmFallback: true,
		allowTunnelLink: true,
		allowCloudLink: true,
	};
}

function instructionForMode(
	kind: SensitiveRequestKind,
	mode: SensitiveRequestDeliveryMode,
): string {
	const noun =
		kind === "secret"
			? "secret"
			: kind === "payment"
				? "payment"
				: kind === "oauth"
					? "account connection"
					: "private information";

	switch (mode) {
		case "inline_owner_app":
			return `Collect the ${noun} with an owner-only inline app form and show status in chat.`;
		case "private_dm":
			return `Collect the ${noun} only in a private DM or owner-only chat.`;
		case "cloud_authenticated_link":
			return `Send an Eliza Cloud authenticated link for the ${noun}.`;
		case "tunnel_authenticated_link":
			return `Send an authenticated tunnel link for the ${noun}.`;
		case "public_link":
			return `A public link is allowed for this ${noun} request.`;
		case "dm_or_owner_app_instruction":
			return `Do not collect the ${noun} here. Ask the owner to use a DM or the owner app.`;
	}
}

export function resolveSensitiveRequestDelivery(
	input: SensitiveRequestPolicyInput,
): SensitiveRequestDeliveryPlan {
	const env = input.environment ?? {};
	const source = classifySensitiveRequestSource({
		channelType: input.channelType,
		source: input.source,
		ownerAppPrivateChat: env.ownerApp?.privateChat,
	});
	const policy = defaultSensitiveRequestPolicy(
		input.kind,
		input.paymentContext,
	);

	const cloudBaseUrl = nonEmpty(env.cloud?.baseUrl);
	const tunnelUrl = nonEmpty(env.tunnel?.url);
	const cloudAvailable = Boolean(env.cloud?.available);
	const tunnelAvailable = Boolean(env.tunnel?.available && tunnelUrl);
	const tunnelAuthenticated = Boolean(
		env.tunnel?.available && env.tunnel?.authenticated && tunnelUrl,
	);
	const dmAvailable = env.dm?.available !== false;

	let mode: SensitiveRequestDeliveryMode;
	let authenticated = false;
	let publicLinkAllowed = false;
	let linkBaseUrl: string | undefined;
	let reason: string;

	if (source === "owner_app_private" && policy.allowInlineOwnerAppEntry) {
		mode = "inline_owner_app";
		authenticated = true;
		reason = "owner is already in a private app chat";
	} else if (input.kind === "payment" && input.paymentContext === "any_payer") {
		if (cloudAvailable && cloudBaseUrl) {
			mode = source === "public" ? "public_link" : "cloud_authenticated_link";
			publicLinkAllowed = true;
			linkBaseUrl = cloudBaseUrl;
			reason = "payment context allows any payer and cloud is available";
		} else if (tunnelAvailable && tunnelUrl) {
			mode = source === "public" ? "public_link" : "tunnel_authenticated_link";
			publicLinkAllowed = true;
			linkBaseUrl = tunnelUrl;
			reason = "payment context allows any payer and tunnel is available";
		} else if (dmAvailable && source === "dm") {
			mode = "private_dm";
			reason = "payment can be coordinated in the current private chat";
		} else {
			mode = "dm_or_owner_app_instruction";
			reason = "no cloud or tunnel payment surface is available";
		}
	} else if (cloudAvailable && cloudBaseUrl && policy.allowCloudLink) {
		mode = "cloud_authenticated_link";
		authenticated = true;
		publicLinkAllowed = source === "public" && policy.allowPublicLink;
		linkBaseUrl = cloudBaseUrl;
		reason = "cloud authenticated link is available";
	} else if (tunnelAuthenticated && policy.allowTunnelLink) {
		mode = "tunnel_authenticated_link";
		authenticated = true;
		publicLinkAllowed = source === "public" && policy.allowPublicLink;
		linkBaseUrl = tunnelUrl;
		reason = "authenticated tunnel link is available";
	} else if (source === "dm" && dmAvailable) {
		mode = "private_dm";
		authenticated = false;
		reason =
			"current channel is private but no authenticated link is available";
	} else {
		mode = "dm_or_owner_app_instruction";
		reason =
			tunnelAvailable && !env.tunnel?.authenticated
				? "tunnel is available but not authorized for sensitive request entry"
				: "no private or authenticated delivery route is available";
	}

	const canCollectValueInCurrentChannel =
		mode === "inline_owner_app" || (source === "dm" && mode === "private_dm");

	return {
		kind: input.kind,
		source,
		mode,
		policy,
		privateRouteRequired: policy.requirePrivateDelivery,
		publicLinkAllowed,
		authenticated,
		canCollectValueInCurrentChannel,
		linkBaseUrl,
		reason,
		instruction: instructionForMode(input.kind, mode),
	};
}

export function sensitiveRequestEnvironmentFromSettings(settings: {
	cloudApiKey?: unknown;
	cloudEnabled?: unknown;
	cloudBaseUrl?: unknown;
	tunnelUrl?: unknown;
	tunnelActive?: unknown;
	tunnelAuthenticated?: unknown;
	dmAvailable?: unknown;
	ownerAppPrivateChat?: unknown;
}): SensitiveRequestEnvironment {
	const cloudApiKey = nonEmpty(settings.cloudApiKey);
	const cloudBaseUrl = nonEmpty(settings.cloudBaseUrl);
	const tunnelUrl = nonEmpty(settings.tunnelUrl);

	return {
		cloud: {
			available:
				Boolean(cloudApiKey) &&
				(settings.cloudEnabled === undefined ||
					isTruthy(settings.cloudEnabled)),
			baseUrl: cloudBaseUrl,
		},
		tunnel: {
			available: isTruthy(settings.tunnelActive) && Boolean(tunnelUrl),
			url: tunnelUrl,
			authenticated: isTruthy(settings.tunnelAuthenticated),
		},
		dm: {
			available:
				settings.dmAvailable === undefined || isTruthy(settings.dmAvailable),
		},
		ownerApp: {
			privateChat: isTruthy(settings.ownerAppPrivateChat),
		},
	};
}
