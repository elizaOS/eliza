/** Owns connector descriptors and account-scoped transport dispatch for one runtime.
 * The send-handler map is shared with existing plugin-lifecycle and host consumers.
 * Hooks receive the original runtime, including through the outbound voice and envelope gates. */
import { guardOutboundEnvelopeText } from "../security/outbound-envelope-guard.js";
import { sanitizeOutboundText } from "../services/message/outbound-sanitize";
import { ensureAgentVoice } from "../services/message/voice-gate";
import type {
	ConnectorPostIdentity,
	Content,
	IAgentRuntime,
	Memory,
	MessageConnector,
	MessageConnectorCreateThreadParams,
	MessageConnectorRegistration,
	PostConnector,
	PostConnectorRegistration,
	SendHandlerFunction,
	SendHandlerResult,
	TargetInfo,
	ThreadHandle,
} from "../types";
import {
	cloneMessageConnector,
	clonePostConnector,
	connectorKeySource,
	connectorRouteKey,
	normalizeConnectorAccountId,
	normalizeMessageConnector,
	normalizePostConnector,
} from "./connector-registration.js";
export class RuntimeConnectorRegistry {
	constructor(
		private readonly runtime: IAgentRuntime,
		private readonly sendHandlers: Map<string, SendHandlerFunction>,
	) {}

	private messageConnectors = new Map<string, MessageConnector>();

	private postConnectors = new Map<string, PostConnector>();

	registerSendHandler(source: string, handler: SendHandlerFunction): void {
		const normalized = typeof source === "string" ? source.trim() : "";
		if (!normalized) {
			throw new Error("Send handler registration requires a source");
		}
		const routeKey = connectorRouteKey(normalized);
		if (this.sendHandlers.has(routeKey)) {
			this.runtime.logger.warn(
				{
					src: "agent",
					agentId: this.runtime.agentId,
					handlerSource: normalized,
				},
				"Send handler already registered, overwriting",
			);
		}
		this.sendHandlers.set(routeKey, handler);
		this.messageConnectors.set(routeKey, normalizeMessageConnector(normalized));
		this.runtime.logger.debug(
			{
				src: "agent",
				agentId: this.runtime.agentId,
				handlerSource: normalized,
			},
			"Send handler registered",
		);
	}

	registerInternalSendHandler(
		source: string,
		handler: SendHandlerFunction,
	): void {
		const normalized = typeof source === "string" ? source.trim() : "";
		if (!normalized) {
			throw new Error("Internal send handler registration requires a source");
		}
		const routeKey = connectorRouteKey(normalized);
		if (this.sendHandlers.has(routeKey)) {
			this.runtime.logger.warn(
				{
					src: "agent",
					agentId: this.runtime.agentId,
					handlerSource: normalized,
				},
				"Internal send handler already registered, overwriting",
			);
		}
		this.sendHandlers.set(routeKey, handler);
		this.runtime.logger.debug(
			{
				src: "agent",
				agentId: this.runtime.agentId,
				handlerSource: normalized,
			},
			"Internal send handler registered",
		);
	}

	registerMessageConnector(registration: MessageConnectorRegistration): void {
		const source =
			typeof registration.source === "string" ? registration.source.trim() : "";
		if (!source) {
			throw new Error("Message connector registration requires a source");
		}
		const accountId =
			normalizeConnectorAccountId(registration.accountId) ??
			normalizeConnectorAccountId(registration.account?.accountId);
		const routeKey = connectorRouteKey(source, accountId);
		if (
			this.messageConnectors.has(routeKey) ||
			this.sendHandlers.has(routeKey)
		) {
			this.runtime.logger.warn(
				{
					src: "agent",
					agentId: this.runtime.agentId,
					handlerSource: source,
					accountId,
				},
				"Message connector already registered, overwriting",
			);
		}

		if (registration.sendHandler) {
			this.sendHandlers.set(routeKey, registration.sendHandler);
			this.runtime.logger.debug(
				{
					src: "agent",
					agentId: this.runtime.agentId,
					handlerSource: source,
					accountId,
				},
				"Send handler registered",
			);
		}
		this.messageConnectors.set(
			routeKey,
			normalizeMessageConnector(source, {
				...registration,
				accountId,
			}),
		);
	}

	unregisterMessageConnector(source: string, accountId?: string): boolean {
		const normalized = typeof source === "string" ? source.trim() : "";
		if (!normalized) return false;
		const normalizedAccountId = normalizeConnectorAccountId(accountId);
		let removedConnector = false;
		let removedHandler = false;
		if (normalizedAccountId) {
			const routeKey = connectorRouteKey(normalized, normalizedAccountId);
			removedConnector = this.messageConnectors.delete(routeKey);
			removedHandler = this.sendHandlers.delete(routeKey);
		} else {
			for (const [routeKey, connector] of this.messageConnectors) {
				if (connector.source === normalized) {
					removedConnector =
						this.messageConnectors.delete(routeKey) || removedConnector;
				}
			}
			for (const routeKey of Array.from(this.sendHandlers.keys())) {
				if (connectorKeySource(routeKey) === normalized) {
					removedHandler = this.sendHandlers.delete(routeKey) || removedHandler;
				}
			}
		}
		if (removedConnector || removedHandler) {
			this.runtime.logger.debug(
				{
					src: "agent",
					agentId: this.runtime.agentId,
					handlerSource: normalized,
					accountId: normalizedAccountId,
				},
				"Message connector unregistered",
			);
		}
		return removedConnector || removedHandler;
	}

	getMessageConnectors(): MessageConnector[] {
		return Array.from(this.messageConnectors.values())
			.map(cloneMessageConnector)
			.sort(
				(a, b) =>
					a.source.localeCompare(b.source) ||
					(a.accountId ?? "").localeCompare(b.accountId ?? ""),
			);
	}

	registerPostConnector(registration: PostConnectorRegistration): void {
		const source =
			typeof registration.source === "string" ? registration.source.trim() : "";
		if (!source) {
			throw new Error("Post connector registration requires a source");
		}
		const accountId =
			normalizeConnectorAccountId(registration.accountId) ??
			normalizeConnectorAccountId(registration.account?.accountId);
		const routeKey = connectorRouteKey(source, accountId);
		if (this.postConnectors.has(routeKey)) {
			this.runtime.logger.warn(
				{
					src: "agent",
					agentId: this.runtime.agentId,
					handlerSource: source,
					accountId,
				},
				"Post connector already registered, overwriting",
			);
		}
		this.postConnectors.set(
			routeKey,
			normalizePostConnector(source, {
				...registration,
				accountId,
			}),
		);
		this.runtime.logger.debug(
			{
				src: "agent",
				agentId: this.runtime.agentId,
				handlerSource: source,
				accountId,
			},
			"Post connector registered",
		);
	}

	unregisterPostConnector(source: string, accountId?: string): boolean {
		const normalized = typeof source === "string" ? source.trim() : "";
		if (!normalized) return false;
		const normalizedAccountId = normalizeConnectorAccountId(accountId);
		let removed = false;
		if (normalizedAccountId) {
			removed = this.postConnectors.delete(
				connectorRouteKey(normalized, normalizedAccountId),
			);
		} else {
			for (const [routeKey, connector] of this.postConnectors) {
				if (connector.source === normalized) {
					removed = this.postConnectors.delete(routeKey) || removed;
				}
			}
		}
		if (removed) {
			this.runtime.logger.debug(
				{
					src: "agent",
					agentId: this.runtime.agentId,
					handlerSource: normalized,
					accountId: normalizedAccountId,
				},
				"Post connector unregistered",
			);
		}
		return removed;
	}

	getPostConnectors(): PostConnector[] {
		return Array.from(this.postConnectors.values())
			.map(clonePostConnector)
			.sort(
				(a, b) =>
					a.source.localeCompare(b.source) ||
					(a.accountId ?? "").localeCompare(b.accountId ?? ""),
			);
	}

	async sendMessageToTarget(
		target: TargetInfo,
		content: Content,
	): SendHandlerResult {
		const source =
			typeof target.source === "string" ? target.source.trim() : "";
		const accountId = normalizeConnectorAccountId(target.accountId);
		const handler =
			this.sendHandlers.get(connectorRouteKey(source, accountId)) ??
			this.sendHandlers.get(connectorRouteKey(source));
		if (!handler) {
			const errorMsg = accountId
				? `No send handler registered for source: ${source} accountId: ${accountId}`
				: `No send handler registered for source: ${source}`;
			this.runtime.logger.error(
				{
					src: "agent",
					agentId: this.runtime.agentId,
					handlerSource: source,
					accountId,
				},
				"Send handler not found",
			);
			throw new Error(errorMsg);
		}
		// Humanness voice gate (#14873): this is the connector-transport chokepoint
		// for every agent-initiated outbound message (scheduled dispatches,
		// escalations, task-agent routing, raw error strings). Rephrase the literal
		// into the agent's own voice unless it is already model-voiced
		// (`content.agentVoiced`); the gate fails open, so a rephrase outage
		// delivers the original text rather than blocking the send.
		const voicedContent = await ensureAgentVoice(this.runtime, content, {
			source,
		});
		// Proactive sends bypass the message-turn callback wrap, so the shared
		// machine-syntax sanitizer (#15888) and the fail-closed envelope guard
		// apply here — after the voice gate, whose rephrase is itself model text.
		const outboundContent =
			typeof voicedContent.text === "string"
				? {
						...voicedContent,
						text: guardOutboundEnvelopeText(
							this.runtime,
							sanitizeOutboundText(voicedContent.text),
							"sendMessageToTarget",
						),
					}
				: voicedContent;
		return handler(this.runtime, target, outboundContent);
	}

	private resolveMessageConnector(target: TargetInfo): {
		connector: MessageConnector;
		source: string;
		accountId: string | undefined;
	} {
		const source =
			typeof target.source === "string" ? target.source.trim() : "";
		const accountId = normalizeConnectorAccountId(target.accountId);
		const connector =
			this.messageConnectors.get(connectorRouteKey(source, accountId)) ??
			this.messageConnectors.get(connectorRouteKey(source));
		if (!connector) {
			throw new Error(
				accountId
					? `No message connector registered for source: ${source} accountId: ${accountId}`
					: `No message connector registered for source: ${source}`,
			);
		}
		return { connector, source, accountId };
	}

	private requireConnectorHook<K extends keyof MessageConnector>(
		target: TargetInfo,
		hook: K,
		capability: string,
	): MessageConnector {
		const { connector, source, accountId } =
			this.resolveMessageConnector(target);
		if (!connector[hook]) {
			const detail = accountId
				? `source: ${source} accountId: ${accountId}`
				: `source: ${source}`;
			throw new Error(`Connector does not support ${capability} (${detail})`);
		}
		return connector;
	}

	async editMessageOnTarget(
		target: TargetInfo,
		messageId: string,
		content: Content,
	): Promise<Memory | undefined> {
		const connector = this.requireConnectorHook(
			target,
			"editHandler",
			"edit_message",
		);
		const handler = connector.editHandler;
		if (!handler) {
			throw new Error("Connector does not support edit_message");
		}
		return (
			(await handler(this.runtime, { target, messageId, content })) ?? undefined
		);
	}

	async sendTypingOnTarget(target: TargetInfo): Promise<void> {
		const connector = this.requireConnectorHook(
			target,
			"typingHandler",
			"typing_indicator",
		);
		await connector.typingHandler?.(this.runtime, { target });
	}

	async stopTypingOnTarget(target: TargetInfo): Promise<void> {
		const connector = this.requireConnectorHook(
			target,
			"stopTypingHandler",
			"typing_indicator",
		);
		await connector.stopTypingHandler?.(this.runtime, { target });
	}

	async createThreadOnTarget(
		target: TargetInfo,
		params: Omit<MessageConnectorCreateThreadParams, "target"> = {},
	): Promise<ThreadHandle> {
		const connector = this.requireConnectorHook(
			target,
			"createThreadHandler",
			"create_thread",
		);
		const handler = connector.createThreadHandler;
		if (!handler) {
			throw new Error("Connector does not support create_thread");
		}
		return handler(this.runtime, { target, ...params });
	}

	async postToThreadOnTarget(
		target: TargetInfo,
		thread: ThreadHandle,
		content: Content,
		identity?: ConnectorPostIdentity,
	): Promise<Memory | undefined> {
		const connector = this.requireConnectorHook(
			target,
			"postToThreadHandler",
			"post_to_thread",
		);
		return connector.postToThreadHandler?.(this.runtime, {
			target,
			thread,
			content,
			identity,
		});
	}

	async addReactionOnTarget(
		target: TargetInfo,
		messageId: string,
		emoji: string,
	): Promise<void> {
		const connector = this.requireConnectorHook(
			target,
			"reactHandler",
			"react_message",
		);
		await connector.reactHandler?.(this.runtime, { target, messageId, emoji });
	}
}
