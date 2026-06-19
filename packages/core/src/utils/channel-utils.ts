/**
 * Channel Utilities for elizaOS
 *
 * Generic cross-platform utilities for messaging channels.
 * These utilities are platform-agnostic and can be used by any channel plugin.
 *
 * @module utils/channel-utils
 */

// ============================================================================
// Chat Type Normalization
// ============================================================================

/**
 * Normalized chat type - the canonical representation of chat types across platforms.
 */
export type NormalizedChatType = "direct" | "group" | "channel";

/**
 * Normalize a raw chat type string to a canonical form.
 * Handles various platform-specific naming conventions.
 *
 * @param raw - The raw chat type string from the platform
 * @returns Normalized chat type
 */
export function normalizeChatType(raw?: string): NormalizedChatType {
	const lower = raw?.toLowerCase().trim();
	if (!lower) {
		return "direct";
	}
	if (lower === "direct" || lower === "dm" || lower === "private") {
		return "direct";
	}
	if (lower === "group" || lower === "supergroup" || lower === "room") {
		return "group";
	}
	if (lower === "channel" || lower === "feed" || lower === "broadcast") {
		return "channel";
	}
	return "direct";
}

// ============================================================================
// Mention Gating
// ============================================================================

/**
 * Parameters for resolving mention gating.
 */
export type MentionGateParams = {
	/** Whether the agent requires an @mention to respond */
	requireMention: boolean;
	/** Whether the platform can detect mentions */
	canDetectMention: boolean;
	/** Whether the agent was explicitly mentioned */
	wasMentioned: boolean;
	/** Whether there's an implicit mention (e.g., reply to agent) */
	implicitMention?: boolean;
	/** Whether to bypass mention requirements */
	shouldBypassMention?: boolean;
};

/**
 * Result of mention gating resolution.
 */
export type MentionGateResult = {
	/** Whether the agent should consider itself mentioned */
	effectiveWasMentioned: boolean;
	/** Whether to skip processing this message */
	shouldSkip: boolean;
};

/**
 * Extended parameters for mention gating with bypass logic.
 */
export type MentionGateWithBypassParams = {
	isGroup: boolean;
	requireMention: boolean;
	canDetectMention: boolean;
	wasMentioned: boolean;
	implicitMention?: boolean;
	hasAnyMention?: boolean;
	allowTextCommands: boolean;
	hasControlCommand: boolean;
	commandAuthorized: boolean;
};

/**
 * Extended result with bypass information.
 */
export type MentionGateWithBypassResult = MentionGateResult & {
	shouldBypassMention: boolean;
};

/**
 * Resolve whether to process a message based on mention requirements.
 *
 * @param params - Mention gating parameters
 * @returns Gating result indicating if message should be processed
 */
export function resolveMentionGating(
	params: MentionGateParams,
): MentionGateResult {
	const implicit = params.implicitMention === true;
	const bypass = params.shouldBypassMention === true;
	const effectiveWasMentioned = params.wasMentioned || implicit || bypass;
	const shouldSkip =
		params.requireMention && params.canDetectMention && !effectiveWasMentioned;
	return { effectiveWasMentioned, shouldSkip };
}

/**
 * Resolve mention gating with command bypass logic.
 * Allows authorized control commands to bypass mention requirements.
 *
 * @param params - Extended mention gating parameters
 * @returns Extended gating result with bypass information
 */
export function resolveMentionGatingWithBypass(
	params: MentionGateWithBypassParams,
): MentionGateWithBypassResult {
	const shouldBypassMention =
		params.isGroup &&
		params.requireMention &&
		!params.wasMentioned &&
		!(params.hasAnyMention ?? false) &&
		params.allowTextCommands &&
		params.commandAuthorized &&
		params.hasControlCommand;
	return {
		...resolveMentionGating({
			requireMention: params.requireMention,
			canDetectMention: params.canDetectMention,
			wasMentioned: params.wasMentioned,
			implicitMention: params.implicitMention,
			shouldBypassMention,
		}),
		shouldBypassMention,
	};
}

// ============================================================================
// Typing Indicators
// ============================================================================

/**
 * Callbacks for managing typing indicators.
 */
export type TypingCallbacks = {
	/** Called when a reply starts (show typing indicator) */
	onReplyStart: () => Promise<void>;
	/** Called when idle (hide typing indicator) */
	onIdle?: () => void;
};

/**
 * Parameters for creating typing callbacks.
 */
export type TypingCallbackParams = {
	/** Function to start typing indicator */
	start: () => Promise<void>;
	/** Function to stop typing indicator */
	stop?: () => Promise<void>;
	/** Error handler for start failures */
	onStartError: (err: unknown) => void;
	/** Error handler for stop failures */
	onStopError?: (err: unknown) => void;
};

/**
 * Create typing indicator callbacks with error handling.
 *
 * @param params - Typing callback parameters
 * @returns Callbacks for managing typing state
 */
export function createTypingCallbacks(
	params: TypingCallbackParams,
): TypingCallbacks {
	const stop = params.stop;
	const onReplyStart = async () => {
		try {
			await params.start();
		} catch (err) {
			params.onStartError(err);
		}
	};

	const onIdle = stop
		? () => {
				void stop().catch((err) =>
					(params.onStopError ?? params.onStartError)(err),
				);
			}
		: undefined;

	return { onReplyStart, onIdle };
}

// ============================================================================
// Acknowledgment Reactions
// ============================================================================

/**
 * Scope for acknowledgment reactions (e.g., "👀" seen indicators).
 */
export type AckReactionScope =
	| "all"
	| "direct"
	| "group-all"
	| "group-mentions"
	| "off"
	| "none";

/**
 * WhatsApp-specific acknowledgment reaction mode.
 */
export type WhatsAppAckReactionMode = "always" | "mentions" | "never";

/**
 * Parameters for determining if an ack reaction should be sent.
 */
export type AckReactionGateParams = {
	scope: AckReactionScope | undefined;
	isDirect: boolean;
	isGroup: boolean;
	isMentionableGroup: boolean;
	requireMention: boolean;
	canDetectMention: boolean;
	effectiveWasMentioned: boolean;
	shouldBypassMention?: boolean;
};

/**
 * Determine if an acknowledgment reaction should be sent.
 *
 * @param params - Ack reaction parameters
 * @returns Whether to send the ack reaction
 */
export function shouldAckReaction(params: AckReactionGateParams): boolean {
	const scope = params.scope ?? "group-mentions";
	if (scope === "off" || scope === "none") {
		return false;
	}
	if (scope === "all") {
		return true;
	}
	if (scope === "direct") {
		return params.isDirect;
	}
	if (scope === "group-all") {
		return params.isGroup;
	}
	if (scope === "group-mentions") {
		if (!params.isMentionableGroup) {
			return false;
		}
		if (!params.requireMention) {
			return false;
		}
		if (!params.canDetectMention) {
			return false;
		}
		return params.effectiveWasMentioned || params.shouldBypassMention === true;
	}
	return false;
}

/**
 * WhatsApp-specific ack reaction logic.
 *
 * @param params - WhatsApp ack reaction parameters
 * @returns Whether to send the ack reaction
 */
export function shouldAckReactionForWhatsApp(params: {
	emoji: string;
	isDirect: boolean;
	isGroup: boolean;
	directEnabled: boolean;
	groupMode: WhatsAppAckReactionMode;
	wasMentioned: boolean;
	groupActivated: boolean;
}): boolean {
	if (!params.emoji) {
		return false;
	}
	if (params.isDirect) {
		return params.directEnabled;
	}
	if (!params.isGroup) {
		return false;
	}
	if (params.groupMode === "never") {
		return false;
	}
	if (params.groupMode === "always") {
		return true;
	}
	return shouldAckReaction({
		scope: "group-mentions",
		isDirect: false,
		isGroup: true,
		isMentionableGroup: true,
		requireMention: true,
		canDetectMention: true,
		effectiveWasMentioned: params.wasMentioned,
		shouldBypassMention: params.groupActivated,
	});
}

/**
 * Parameters for removing ack reaction after reply.
 */
export type RemoveAckReactionParams = {
	removeAfterReply: boolean;
	ackReactionPromise: Promise<boolean> | null;
	ackReactionValue: string | null;
	remove: () => Promise<void>;
	onError?: (err: unknown) => void;
};

/**
 * Remove acknowledgment reaction after reply is sent.
 *
 * @param params - Parameters for removal
 */
export function removeAckReactionAfterReply(
	params: RemoveAckReactionParams,
): void {
	if (!params.removeAfterReply) {
		return;
	}
	if (!params.ackReactionPromise) {
		return;
	}
	if (!params.ackReactionValue) {
		return;
	}
	void params.ackReactionPromise.then((didAck) => {
		if (!didAck) {
			return;
		}
		params.remove().catch((err) => params.onError?.(err));
	});
}

// ============================================================================
// Sender Labels
// ============================================================================

/**
 * Parameters for resolving a sender's display label.
 */
export type SenderLabelParams = {
	name?: string;
	username?: string;
	tag?: string;
	e164?: string;
	id?: string;
};

function normalizeLabel(value?: string): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

type NormalizedSenderParts = {
	name?: string;
	username?: string;
	tag?: string;
	e164?: string;
	id?: string;
	display: string;
	idPart: string;
};

function getNormalizedSenderParts(
	params: SenderLabelParams,
): NormalizedSenderParts {
	const name = normalizeLabel(params.name);
	const username = normalizeLabel(params.username);
	const tag = normalizeLabel(params.tag);
	const e164 = normalizeLabel(params.e164);
	const id = normalizeLabel(params.id);
	const display = name ?? username ?? tag ?? "";
	const idPart = e164 ?? id ?? "";

	return {
		name,
		username,
		tag,
		e164,
		id,
		display,
		idPart,
	};
}

/**
 * Resolve a display label for a message sender.
 * Prefers name, then username, then tag, with ID appended if different.
 *
 * @param params - Sender identification parameters
 * @returns Display label or null if no information available
 */
export function resolveSenderLabel(params: SenderLabelParams): string | null {
	const { display, idPart } = getNormalizedSenderParts(params);
	if (display && idPart && display !== idPart) {
		return `${display} (${idPart})`;
	}
	return display || idPart || null;
}

/**
 * List all possible sender label candidates.
 *
 * @param params - Sender identification parameters
 * @returns Array of possible labels
 */
export function listSenderLabelCandidates(params: SenderLabelParams): string[] {
	const candidates = new Set<string>();
	const { name, username, tag, e164, id } = getNormalizedSenderParts(params);

	if (name) {
		candidates.add(name);
	}
	if (username) {
		candidates.add(username);
	}
	if (tag) {
		candidates.add(tag);
	}
	if (e164) {
		candidates.add(e164);
	}
	if (id) {
		candidates.add(id);
	}
	const resolved = resolveSenderLabel(params);
	if (resolved) {
		candidates.add(resolved);
	}
	return Array.from(candidates);
}

// ============================================================================
// Location Utilities
// ============================================================================

/**
 * Source type for location data.
 */
export type LocationSource = "pin" | "place" | "live";

/**
 * Normalized location data structure.
 */
export type NormalizedLocation = {
	latitude: number;
	longitude: number;
	accuracy?: number;
	name?: string;
	address?: string;
	isLive?: boolean;
	source?: LocationSource;
	caption?: string;
};

type ResolvedLocation = NormalizedLocation & {
	source: LocationSource;
	isLive: boolean;
};

function resolveLocation(location: NormalizedLocation): ResolvedLocation {
	const source =
		location.source ??
		(location.isLive
			? "live"
			: location.name || location.address
				? "place"
				: "pin");
	const isLive = Boolean(location.isLive ?? source === "live");
	return { ...location, source, isLive };
}

function formatAccuracy(accuracy?: number): string {
	if (!Number.isFinite(accuracy)) {
		return "";
	}
	return ` ±${Math.round(accuracy ?? 0)}m`;
}

function formatCoords(latitude: number, longitude: number): string {
	return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}

/**
 * Format a location as human-readable text with emoji indicators.
 *
 * @param location - Normalized location data
 * @returns Formatted location string
 */
export function formatLocationText(location: NormalizedLocation): string {
	const resolved = resolveLocation(location);
	const coords = formatCoords(resolved.latitude, resolved.longitude);
	const accuracy = formatAccuracy(resolved.accuracy);
	const caption = resolved.caption?.trim();
	let header = "";

	if (resolved.source === "live" || resolved.isLive) {
		header = `🛰 Live location: ${coords}${accuracy}`;
	} else if (resolved.name || resolved.address) {
		const label = [resolved.name, resolved.address].filter(Boolean).join(" — ");
		header = `📍 ${label} (${coords}${accuracy})`;
	} else {
		header = `📍 ${coords}${accuracy}`;
	}

	return caption ? `${header}\n${caption}` : header;
}

/**
 * Location context fields for message processing.
 */
export type LocationContext = {
	LocationLat: number;
	LocationLon: number;
	LocationAccuracy?: number;
	LocationName?: string;
	LocationAddress?: string;
	LocationSource: LocationSource;
	LocationIsLive: boolean;
};

/**
 * Convert a normalized location to context fields.
 *
 * @param location - Normalized location data
 * @returns Location context fields
 */
export function toLocationContext(
	location: NormalizedLocation,
): LocationContext {
	const resolved = resolveLocation(location);
	return {
		LocationLat: resolved.latitude,
		LocationLon: resolved.longitude,
		LocationAccuracy: resolved.accuracy,
		LocationName: resolved.name,
		LocationAddress: resolved.address,
		LocationSource: resolved.source,
		LocationIsLive: resolved.isLive,
	};
}

// ============================================================================
// Channel Logging Utilities
// ============================================================================

/**
 * Log function signature.
 */
export type LogFn = (message: string) => void;

function formatTargetSuffix(target?: string): string {
	return target ? ` target=${target}` : "";
}

/**
 * Log when an inbound message is dropped.
 *
 * @param params - Log parameters
 */
export function logInboundDrop(params: {
	log: LogFn;
	channel: string;
	reason: string;
	target?: string;
}): void {
	params.log(
		`${params.channel}: drop ${params.reason}${formatTargetSuffix(params.target)}`,
	);
}

/**
 * Log a typing indicator failure.
 *
 * @param params - Log parameters
 */
export function logTypingFailure(params: {
	log: LogFn;
	channel: string;
	target?: string;
	action?: "start" | "stop";
	error: unknown;
}): void {
	const action = params.action ? ` action=${params.action}` : "";
	params.log(
		`${params.channel} typing${action} failed${formatTargetSuffix(params.target)}: ${String(params.error)}`,
	);
}

/**
 * Log an acknowledgment cleanup failure.
 *
 * @param params - Log parameters
 */
export function logAckFailure(params: {
	log: LogFn;
	channel: string;
	target?: string;
	error: unknown;
}): void {
	params.log(
		`${params.channel} ack cleanup failed${formatTargetSuffix(params.target)}: ${String(params.error)}`,
	);
}
