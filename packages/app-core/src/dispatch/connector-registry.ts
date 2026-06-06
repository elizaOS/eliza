/**
 * ConnectorRegistry — registry of outbound connectors the runtime can dispatch
 * to (Discord, Telegram, SMS, push, in-app, …). Each connector advertises the
 * channels it speaks and the typed dispatch result it returns.
 *
 * STUB — see this directory's README for the tracked migration.
 *
 * TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/connectors ->
 *               packages/app-core/src/dispatch/connector-registry.ts)
 */

/** Result returned by a connector's dispatch call. */
export type DispatchResult =
	| { readonly ok: true; readonly messageId?: string }
	| { readonly ok: false; readonly reason: string };

export interface ConnectorDescriptor {
	readonly id: string;
	/** Channel ids this connector can deliver to. */
	readonly channels: readonly string[];
	/** Free-form metadata — display label, capability flags, etc. */
	readonly metadata?: Record<string, unknown>;
}

export interface ConnectorRegistry {
	register(descriptor: ConnectorDescriptor): void;
	get(id: string): ConnectorDescriptor | undefined;
	list(): readonly ConnectorDescriptor[];
	/** Look up the connector that handles a given channel id, if any. */
	findForChannel(channelId: string): ConnectorDescriptor | undefined;
}

export class StubConnectorRegistry implements ConnectorRegistry {
	register(_descriptor: ConnectorDescriptor): void {
		throw new Error(
			"[StubConnectorRegistry] not implemented — see packages/app-core/src/dispatch/README.md",
		);
	}

	get(_id: string): ConnectorDescriptor | undefined {
		throw new Error(
			"[StubConnectorRegistry] not implemented — see packages/app-core/src/dispatch/README.md",
		);
	}

	list(): readonly ConnectorDescriptor[] {
		throw new Error(
			"[StubConnectorRegistry] not implemented — see packages/app-core/src/dispatch/README.md",
		);
	}

	findForChannel(_channelId: string): ConnectorDescriptor | undefined {
		throw new Error(
			"[StubConnectorRegistry] not implemented — see packages/app-core/src/dispatch/README.md",
		);
	}
}
