/** Validates connector registrations, normalizes account routing keys, and copies public connector descriptors. */
import type {
	ConnectorAccountRef,
	MessageConnector,
	MessageConnectorMetadata,
	PostConnector,
	PostConnectorMetadata,
} from "../types";

export function labelFromMessageConnectorSource(source: string): string {
	const label = source
		.replace(/[_-]+/g, " ")
		.trim()
		.replace(/\b\w/g, (char) => char.toUpperCase());
	return label || "Message Connector";
}

export const CONNECTOR_ACCOUNT_KEY_SEPARATOR = "\u0000";

export function normalizeConnectorAccountId(
	accountId: unknown,
): string | undefined {
	return typeof accountId === "string" && accountId.trim()
		? accountId.trim()
		: undefined;
}

export function connectorRouteKey(source: string, accountId?: string): string {
	return accountId
		? `${source}${CONNECTOR_ACCOUNT_KEY_SEPARATOR}${accountId}`
		: source;
}

export function connectorKeySource(key: string): string {
	return key.split(CONNECTOR_ACCOUNT_KEY_SEPARATOR, 1)[0] ?? key;
}

export function cloneConnectorAccountRef(
	account: ConnectorAccountRef,
	source: string,
): ConnectorAccountRef {
	return {
		...account,
		source: account.source || source,
		accountId: normalizeConnectorAccountId(account.accountId),
		capabilities: account.capabilities
			? account.capabilities.map((capability) => ({
					...capability,
					targetKinds: capability.targetKinds
						? [...capability.targetKinds]
						: undefined,
					scopes: capability.scopes ? [...capability.scopes] : undefined,
					metadata: capability.metadata
						? { ...capability.metadata }
						: undefined,
				}))
			: undefined,
		metadata: account.metadata ? { ...account.metadata } : undefined,
	};
}

export function normalizeConnectorAccountRef(
	source: string,
	account?: ConnectorAccountRef,
	accountId?: string,
): ConnectorAccountRef | undefined {
	const normalizedAccountId =
		normalizeConnectorAccountId(accountId) ??
		normalizeConnectorAccountId(account?.accountId);
	if (!account && !normalizedAccountId) {
		return undefined;
	}
	return cloneConnectorAccountRef(
		{
			...account,
			source: account?.source?.trim() || source,
			accountId: normalizedAccountId,
		},
		source,
	);
}

export function cloneMessageConnector(
	connector: MessageConnector,
): MessageConnector {
	return {
		...connector,
		account: connector.account
			? cloneConnectorAccountRef(connector.account, connector.source)
			: undefined,
		capabilities: [...connector.capabilities],
		supportedTargetKinds: [...connector.supportedTargetKinds],
		contexts: [...connector.contexts],
		metadata: connector.metadata ? { ...connector.metadata } : undefined,
		contentShaping: connector.contentShaping
			? {
					...connector.contentShaping,
					constraints: connector.contentShaping.constraints
						? { ...connector.contentShaping.constraints }
						: undefined,
				}
			: undefined,
	};
}

export function clonePostConnector(connector: PostConnector): PostConnector {
	return {
		...connector,
		account: connector.account
			? cloneConnectorAccountRef(connector.account, connector.source)
			: undefined,
		capabilities: [...connector.capabilities],
		contexts: [...connector.contexts],
		metadata: connector.metadata ? { ...connector.metadata } : undefined,
		contentShaping: connector.contentShaping
			? {
					...connector.contentShaping,
					constraints: connector.contentShaping.constraints
						? { ...connector.contentShaping.constraints }
						: undefined,
				}
			: undefined,
	};
}

export function normalizeMessageConnector(
	source: string,
	metadata: MessageConnectorMetadata = {},
): MessageConnector {
	const accountId =
		normalizeConnectorAccountId(metadata.accountId) ??
		normalizeConnectorAccountId(metadata.account?.accountId);
	const connector: MessageConnector = {
		source,
		accountId,
		account: normalizeConnectorAccountRef(source, metadata.account, accountId),
		label: metadata.label?.trim() || labelFromMessageConnectorSource(source),
		capabilities: metadata.capabilities
			? [...metadata.capabilities]
			: ["send_message"],
		supportedTargetKinds: metadata.supportedTargetKinds
			? [...metadata.supportedTargetKinds]
			: [],
		contexts: metadata.contexts ? [...metadata.contexts] : [],
	};

	if (metadata.accountRouting === "connector" && !accountId)
		connector.accountRouting = metadata.accountRouting;
	if (metadata.description) connector.description = metadata.description;
	if (metadata.metadata) connector.metadata = { ...metadata.metadata };
	if (metadata.resolveTargets)
		connector.resolveTargets = metadata.resolveTargets;
	if (metadata.resolveIdentityClaimTarget)
		connector.resolveIdentityClaimTarget = metadata.resolveIdentityClaimTarget;
	if (metadata.listRecentTargets)
		connector.listRecentTargets = metadata.listRecentTargets;
	if (metadata.listRooms) connector.listRooms = metadata.listRooms;
	if (metadata.getChatContext)
		connector.getChatContext = metadata.getChatContext;
	if (metadata.getUserContext)
		connector.getUserContext = metadata.getUserContext;
	if (metadata.listServers) connector.listServers = metadata.listServers;
	if (metadata.fetchMessages) connector.fetchMessages = metadata.fetchMessages;
	if (metadata.searchMessages)
		connector.searchMessages = metadata.searchMessages;
	if (metadata.reactHandler) connector.reactHandler = metadata.reactHandler;
	if (metadata.editHandler) connector.editHandler = metadata.editHandler;
	if (metadata.deleteHandler) connector.deleteHandler = metadata.deleteHandler;
	if (metadata.pinHandler) connector.pinHandler = metadata.pinHandler;
	if (metadata.joinHandler) connector.joinHandler = metadata.joinHandler;
	if (metadata.leaveHandler) connector.leaveHandler = metadata.leaveHandler;
	if (metadata.getUser) connector.getUser = metadata.getUser;
	if (metadata.typingHandler) connector.typingHandler = metadata.typingHandler;
	if (metadata.stopTypingHandler)
		connector.stopTypingHandler = metadata.stopTypingHandler;
	if (metadata.createThreadHandler)
		connector.createThreadHandler = metadata.createThreadHandler;
	if (metadata.postToThreadHandler)
		connector.postToThreadHandler = metadata.postToThreadHandler;
	if (metadata.contentShaping)
		connector.contentShaping = {
			...metadata.contentShaping,
			constraints: metadata.contentShaping.constraints
				? { ...metadata.contentShaping.constraints }
				: undefined,
		};

	return connector;
}

export function normalizePostConnector(
	source: string,
	metadata: PostConnectorMetadata = {},
): PostConnector {
	const accountId =
		normalizeConnectorAccountId(metadata.accountId) ??
		normalizeConnectorAccountId(metadata.account?.accountId);
	const connector: PostConnector = {
		source,
		accountId,
		account: normalizeConnectorAccountRef(source, metadata.account, accountId),
		label: metadata.label?.trim() || labelFromMessageConnectorSource(source),
		capabilities: metadata.capabilities ? [...metadata.capabilities] : ["post"],
		contexts: metadata.contexts ? [...metadata.contexts] : [],
	};

	if (metadata.accountRouting === "connector" && !accountId)
		connector.accountRouting = metadata.accountRouting;
	if (metadata.description) connector.description = metadata.description;
	if (metadata.metadata) connector.metadata = { ...metadata.metadata };
	if (metadata.postHandler) connector.postHandler = metadata.postHandler;
	if (metadata.fetchFeed) connector.fetchFeed = metadata.fetchFeed;
	if (metadata.searchPosts) connector.searchPosts = metadata.searchPosts;
	if (metadata.contentShaping)
		connector.contentShaping = {
			...metadata.contentShaping,
			constraints: metadata.contentShaping.constraints
				? { ...metadata.contentShaping.constraints }
				: undefined,
		};

	return connector;
}
