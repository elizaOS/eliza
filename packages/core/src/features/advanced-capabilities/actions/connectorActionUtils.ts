import { logger } from "../../../logger.ts";
import type {
	Action,
	ActionParameter,
	ActionResult,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	MessageConnector,
	MessageConnectorQueryContext,
	MessageConnectorTarget,
	PostConnector,
	PostConnectorQueryContext,
	State,
	TargetInfo,
	UUID,
} from "../../../types/index.ts";
import { getActiveRoutingContextsForTurn } from "../../../utils/context-routing.ts";

export type ParamRecord = Record<string, unknown>;

export function paramsFromOptions(
	options: HandlerOptions | undefined,
): ParamRecord {
	return ((options as HandlerOptions | undefined)?.parameters ??
		{}) as ParamRecord;
}

export function textParam(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

export function boolParam(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["true", "yes", "1", "on"].includes(normalized)) return true;
	if (["false", "no", "0", "off"].includes(normalized)) return false;
	return undefined;
}

export function numberParam(
	value: unknown,
	fallback?: number,
): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

export function sourceParam(params: ParamRecord): string | undefined {
	return textParam(params.source) ?? textParam(params.platform);
}

export function limitParam(params: ParamRecord, fallback = 20): number {
	const limit = numberParam(params.limit, fallback) ?? fallback;
	return Math.max(1, Math.min(100, Math.floor(limit)));
}

export function isUuidLike(value: string | undefined): value is UUID {
	return Boolean(
		value &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
				value,
			),
	);
}

export function buildMessageQueryContext(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	source: string | undefined,
	target?: TargetInfo,
): MessageConnectorQueryContext {
	return {
		runtime,
		roomId: message.roomId,
		entityId: message.entityId,
		source,
		target,
		contexts: getActiveRoutingContextsForTurn(state, message),
		metadata: {
			messageText: message.content?.text,
		},
	};
}

export function buildPostQueryContext(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	source: string | undefined,
): PostConnectorQueryContext {
	return {
		runtime,
		roomId: message.roomId,
		entityId: message.entityId,
		source,
		contexts: getActiveRoutingContextsForTurn(state, message),
		metadata: {
			messageText: message.content?.text,
		},
	};
}

export function getMessageConnectorsWithHook<K extends keyof MessageConnector>(
	runtime: IAgentRuntime,
	hook: K,
): MessageConnector[] {
	const getConnectors = (
		runtime as IAgentRuntime & {
			getMessageConnectors?: () => MessageConnector[];
		}
	).getMessageConnectors;
	if (typeof getConnectors !== "function") return [];
	return getConnectors
		.call(runtime)
		.filter((connector) => typeof connector[hook] === "function");
}

export function getPostConnectorsWithHook<K extends keyof PostConnector>(
	runtime: IAgentRuntime,
	hook: K,
): PostConnector[] {
	const getConnectors = (
		runtime as IAgentRuntime & {
			getPostConnectors?: () => PostConnector[];
		}
	).getPostConnectors;
	if (typeof getConnectors !== "function") return [];
	return getConnectors
		.call(runtime)
		.filter((connector) => typeof connector[hook] === "function");
}

function messageConnectorSummary(
	connector: MessageConnector,
	connectorOnly: boolean,
): string {
	const kinds =
		connector.supportedTargetKinds.length > 0
			? connector.supportedTargetKinds.join("|")
			: "any";
	const caps =
		connector.capabilities.length > 0
			? connector.capabilities.join("|")
			: "send_message";
	const tag = connectorOnly ? ",<connector only>" : "";
	return `${connector.source}{label:${connector.label},kinds:${kinds},capabilities:${caps}${tag}}`;
}

function postConnectorSummary(
	connector: PostConnector,
	connectorOnly: boolean,
): string {
	const caps =
		connector.capabilities.length > 0
			? connector.capabilities.join("|")
			: "post";
	const tag = connectorOnly ? ",<connector only>" : "";
	return `${connector.source}{label:${connector.label},capabilities:${caps}${tag}}`;
}

export function refreshMessageConnectorActionDescription(
	action: Action,
	runtime: IAgentRuntime,
	options: {
		baseDescription: string;
		baseCompressed: string;
		hook?: keyof MessageConnector;
		connectorOnly?: boolean;
	},
): void {
	const connectors = options.hook
		? getMessageConnectorsWithHook(runtime, options.hook)
		: ((runtime as IAgentRuntime & {
				getMessageConnectors?: () => MessageConnector[];
			}).getMessageConnectors?.call(runtime) ?? []);
	const visible = connectors
		.slice(0, 12)
		.map((connector) =>
			messageConnectorSummary(connector, Boolean(options.connectorOnly)),
		);
	const suffix =
		connectors.length > visible.length
			? `; +${connectors.length - visible.length} more`
			: "";
	const connectorText =
		connectors.length === 0
			? "connectors[0]: none_registered"
			: `connectors[${connectors.length}]: ${visible.join("; ")}${suffix}`;
	action.description = `${options.baseDescription}\n${connectorText}`;
	action.descriptionCompressed = `${options.baseCompressed} ${connectorText}`;
}

export function refreshPostConnectorActionDescription(
	action: Action,
	runtime: IAgentRuntime,
	options: {
		baseDescription: string;
		baseCompressed: string;
		hook: keyof PostConnector;
		connectorOnly?: boolean;
	},
): void {
	const connectors = getPostConnectorsWithHook(runtime, options.hook);
	const visible = connectors
		.slice(0, 12)
		.map((connector) =>
			postConnectorSummary(connector, Boolean(options.connectorOnly)),
		);
	const suffix =
		connectors.length > visible.length
			? `; +${connectors.length - visible.length} more`
			: "";
	const connectorText =
		connectors.length === 0
			? "connectors[0]: none_registered"
			: `connectors[${connectors.length}]: ${visible.join("; ")}${suffix}`;
	action.description = `${options.baseDescription}\n${connectorText}`;
	action.descriptionCompressed = `${options.baseCompressed} ${connectorText}`;
}

export function connectorSelectionFailure(
	actionName: string,
	connectors: Array<{ source: string; label: string; metadata?: unknown }>,
	source: string | undefined,
): ActionResult | null {
	if (connectors.length === 0) {
		return {
			success: false,
			text: `${actionName} has no registered connectors for this operation.`,
			values: { success: false, error: "NO_CONNECTORS_REGISTERED" },
			data: { actionName, error: "NO_CONNECTORS_REGISTERED" },
		};
	}
	if (source && !connectors.some((connector) => connectorMatchesSource(connector, source))) {
		return {
			success: false,
			text: `No connector for source "${source}" supports ${actionName}. Available sources: ${connectors.map((connector) => connector.source).join(", ")}.`,
			values: { success: false, error: "SOURCE_CONNECTOR_NOT_FOUND" },
			data: { actionName, source, error: "SOURCE_CONNECTOR_NOT_FOUND" },
		};
	}
	if (!source && connectors.length > 1) {
		return {
			success: false,
			text:
				`${actionName} needs a source. Choose one of: ` +
				connectors.map((connector) => connector.source).join(", "),
			values: { success: false, error: "SOURCE_AMBIGUOUS" },
			data: {
				actionName,
				error: "SOURCE_AMBIGUOUS",
				candidates: connectors.map((connector) => ({
					source: connector.source,
					label: connector.label,
				})),
			},
		};
	}
	return null;
}

function normalizeConnectorAlias(value: string | undefined): string {
	return String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/^[@#]+/, "")
		.replace(/\s+/g, " ");
}

function connectorAliases(connector: {
	source: string;
	label: string;
	accountId?: string;
	account?: { accountId?: string; label?: string; name?: string };
	metadata?: unknown;
}): string[] {
	const aliases = [connector.source, connector.label];
	if (connector.accountId) aliases.push(connector.accountId);
	if (connector.account?.accountId) aliases.push(connector.account.accountId);
	if (connector.account?.label) aliases.push(connector.account.label);
	if (connector.account?.name) aliases.push(connector.account.name);
	const metadata = connector.metadata;
	if (metadata && typeof metadata === "object") {
		const metadataAliases = (metadata as { aliases?: unknown }).aliases;
		if (Array.isArray(metadataAliases)) {
			for (const alias of metadataAliases) {
				if (typeof alias === "string" && alias.trim()) {
					aliases.push(alias);
				}
			}
		}
	}
	return aliases;
}

function connectorMatchesSource(
	connector: {
		source: string;
		label: string;
		accountId?: string;
		account?: { accountId?: string; label?: string; name?: string };
		metadata?: unknown;
	},
	source: string | undefined,
): boolean {
	const normalized = normalizeConnectorAlias(source);
	return (
		normalized.length > 0 &&
		connectorAliases(connector).some(
			(alias) => normalizeConnectorAlias(alias) === normalized,
		)
	);
}

type SelectableConnector = {
	source: string;
	label: string;
	accountId?: string;
	account?: { accountId?: string; label?: string; name?: string };
	metadata?: unknown;
};

function connectorMatchesAccount(
	connector: SelectableConnector,
	accountId: string | undefined,
): boolean {
	if (!accountId) return true;
	const normalized = normalizeConnectorAlias(accountId);
	return connectorAliases(connector).some(
		(alias) => normalizeConnectorAlias(alias) === normalized,
	);
}

export function selectConnector<T extends SelectableConnector>(
	actionName: string,
	connectors: T[],
	source: string | undefined,
	currentSource?: string,
	accountId?: string,
): { connector: T } | { result: ActionResult } {
	const effectiveSource =
		source ??
		(currentSource &&
		connectors.some((connector) =>
			connectorMatchesSource(connector, currentSource),
		)
			? currentSource
			: undefined);
	const sourceScoped = effectiveSource
		? connectors.filter((connector) =>
				connectorMatchesSource(connector, effectiveSource),
			)
		: connectors;
	if (connectors.length === 0) {
		return {
			result: {
				success: false,
				text: `${actionName} has no registered connectors for this operation.`,
				values: { success: false, error: "NO_CONNECTORS_REGISTERED" },
				data: { actionName, error: "NO_CONNECTORS_REGISTERED" },
			},
		};
	}
	if (effectiveSource && sourceScoped.length === 0) {
		return {
			result: {
				success: false,
				text: `No connector for source "${effectiveSource}" supports ${actionName}. Available sources: ${connectors.map((connector) => connector.source).join(", ")}.`,
				values: { success: false, error: "SOURCE_CONNECTOR_NOT_FOUND" },
				data: {
					actionName,
					source: effectiveSource,
					error: "SOURCE_CONNECTOR_NOT_FOUND",
				},
			},
		};
	}
	const accountScoped = sourceScoped.filter((connector) =>
		connectorMatchesAccount(connector, accountId),
	);
	if (accountId && accountScoped.length === 0) {
		return {
			result: {
				success: false,
				text: `${actionName} has no connector for account "${accountId}"${effectiveSource ? ` on ${effectiveSource}` : ""}.`,
				values: { success: false, error: "ACCOUNT_CONNECTOR_NOT_FOUND" },
				data: {
					actionName,
					source: effectiveSource,
					accountId,
					error: "ACCOUNT_CONNECTOR_NOT_FOUND",
				},
			},
		};
	}
	if (accountScoped.length > 1) {
		return {
			result: {
				success: false,
				text:
					`${actionName} needs a ${effectiveSource ? "connector account" : "source"}. Choose one of: ` +
					accountScoped
						.map((connector) =>
							connector.accountId
								? `${connector.source}:${connector.accountId}`
								: connector.source,
						)
						.join(", "),
				values: { success: false, error: "SOURCE_AMBIGUOUS" },
				data: {
					actionName,
					error: "SOURCE_AMBIGUOUS",
					candidates: accountScoped.map((connector) => ({
						source: connector.source,
						accountId: connector.accountId,
						label: connector.label,
					})),
				},
			},
		};
	}
	const connector = accountScoped[0];
	if (!connector) {
		return {
			result: {
				success: false,
				text: `${actionName} has no connector selected.`,
				values: { success: false, error: "NO_CONNECTOR_SELECTED" },
				data: { actionName, error: "NO_CONNECTOR_SELECTED" },
			},
		};
	}
	return { connector };
}

export function targetLabel(target: TargetInfo): string {
	return (
		target.channelId ??
		target.roomId ??
		target.entityId ??
		target.threadId ??
		target.serverId ??
		target.source
	);
}

export function explicitTargetFromParams(
	source: string,
	params: ParamRecord,
): { target?: TargetInfo; query?: string } {
	const targetText =
		textParam(params.target) ??
		textParam(params.channel) ??
		textParam(params.channelName) ??
		textParam(params.room) ??
		textParam(params.user) ??
		textParam(params.username) ??
		textParam(params.handle);
	const roomId = textParam(params.roomId);
	const channelId =
		textParam(params.channelId) ??
		textParam(params.channel) ??
		(!roomId && targetText && !isUuidLike(targetText) ? targetText : undefined);
	const entityId =
		textParam(params.entityId) ??
		textParam(params.userId) ??
		(targetText && isUuidLike(targetText) ? targetText : undefined);
	const serverId = textParam(params.serverId) ?? textParam(params.server);
	const threadId = textParam(params.threadId) ?? textParam(params.thread);

	if (
		!targetText &&
		!roomId &&
		!channelId &&
		!entityId &&
		!serverId &&
		!threadId
	) {
		return {};
	}

	return {
		query: targetText,
		target: {
			source,
			roomId: roomId as UUID | undefined,
			channelId,
			serverId,
			entityId: entityId as UUID | undefined,
			threadId,
		},
	};
}

export async function resolveTargetForConnector(
	connector: MessageConnector,
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	params: ParamRecord,
): Promise<{ target?: TargetInfo; result?: ActionResult }> {
	const explicit = explicitTargetFromParams(connector.source, params);
	const context = buildMessageQueryContext(
		runtime,
		message,
		state,
		connector.source,
		explicit.target,
	);

	if (explicit.query && connector.resolveTargets) {
		try {
			const matches = await connector.resolveTargets(explicit.query, context);
			if (matches.length === 1) {
				return { target: matches[0].target };
			}
			if (matches.length > 1) {
				const sorted = [...matches].sort(
					(a, b) => (b.score ?? 0) - (a.score ?? 0),
				);
				const [top, second] = sorted;
				if ((top.score ?? 0) > (second.score ?? 0) + 0.12) {
					return { target: top.target };
				}
				return {
					result: {
						success: false,
						text:
							`Target is ambiguous for ${connector.label}. Choose one of:\n` +
							sorted
								.slice(0, 8)
								.map(
									(target, index) =>
										`${index + 1}. ${target.label ?? targetLabel(target.target)} (${target.kind ?? "target"})`,
								)
								.join("\n"),
						values: { success: false, error: "TARGET_AMBIGUOUS" },
						data: {
							error: "TARGET_AMBIGUOUS",
							source: connector.source,
							candidates: sorted.slice(0, 8),
						},
					},
				};
			}
		} catch (error) {
			logger.warn(
				`[CONNECTOR_ACTION] resolveTargets failed for ${connector.source}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return { target: explicit.target };
}

export function targetPreviews(targets: MessageConnectorTarget[]): Array<{
	label?: string;
	kind?: string;
	target: TargetInfo;
}> {
	return targets.map((target) => ({
		label: target.label,
		kind: target.kind,
		target: target.target,
	}));
}

export const LOOSE_TARGET_PARAMETERS: ActionParameter[] = [
	{
		name: "source",
		description:
			"Connector source such as discord, slack, signal, x, bluesky, nostr, or telegram.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "target",
		description:
			"Loose target reference: channel, room, user, handle, ID, or platform-specific label.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "serverId",
		description: "Optional server, guild, workspace, or team ID.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "channelId",
		description: "Optional channel, room, chat, or conversation ID.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "userId",
		description: "Optional user, entity, or account ID.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "thread",
		description: "Optional thread or parent message identifier.",
		required: false,
		schema: { type: "string" },
	},
];

export const PAGINATION_PARAMETERS: ActionParameter[] = [
	{
		name: "limit",
		description: "Maximum number of items to return.",
		required: false,
		schema: { type: "number" },
	},
	{
		name: "cursor",
		description: "Opaque connector-defined pagination cursor.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "before",
		description:
			"Optional platform timestamp or message/post ID before which to read.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "after",
		description:
			"Optional platform timestamp or message/post ID after which to read.",
		required: false,
		schema: { type: "string" },
	},
];
