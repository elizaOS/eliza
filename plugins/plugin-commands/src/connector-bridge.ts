/**
 * ConnectorCommandBridge — the one documented contract every communication
 * connector (Discord, Telegram, …) implements to register and dispatch the
 * universal slash-command catalog onto its native command surface (#8790).
 *
 * The catalog (`getConnectorCommands(surface)`) is connector-neutral; each
 * connector still has to (a) map those commands onto its own command registry
 * and (b) run them when invoked. Before this contract, each connector invented
 * its own register/dispatch shape and — critically — neither gated
 * `requiresAuth` / `requiresElevated` commands at the connector boundary. This
 * module pins down a single shape so the two connectors behave consistently and
 * share one auth-gating decision instead of two divergent copies.
 *
 * The bridge is deliberately a thin interface + a few pure helpers, NOT a
 * framework: connectors keep owning their own message pipelines and reply
 * mechanics. What they share is:
 *
 *   1. the three target kinds and how they route (`agent` / `navigate` /
 *      `client`),
 *   2. one auth-gating decision (`gateConnectorCommand`) producing one refusal
 *      message, and
 *   3. one place to read a command's auth requirements
 *      (`resolveConnectorCommandAuth`).
 *
 * Auth model: the connector resolves the *sender's* trust level
 * (`isAuthorized` / `isElevated`) using whatever owner/allowlist mechanism it
 * already has — the canonical-owner / world-role model in `@elizaos/core`
 * (`hasRoleAccess`). The bridge does not invent a new auth model; it only
 * decides whether a given command may run for an already-resolved sender.
 */

import { findCommandByKeyForRuntime } from "./registry";
import type { CommandTarget } from "./types";

/**
 * The sender's resolved trust level on a connector surface. The connector fills
 * this in from its own owner/allowlist resolution before dispatching; the
 * bridge treats missing/false as "fails closed" (unauthorized).
 */
export interface ConnectorSenderAuth {
	isAuthorized: boolean;
	isElevated: boolean;
	/** Optional human label for `/whoami`-style replies. */
	senderName?: string;
}

/** A command's auth requirements, read from its catalog definition. */
export interface ConnectorCommandAuth {
	requiresAuth: boolean;
	requiresElevated: boolean;
}

/** The outcome of gating a command for a sender. */
export type ConnectorGateDecision =
	| { allowed: true }
	| { allowed: false; reply: string };

/**
 * Resolve a command's auth requirements from the active command registry.
 * `name` is the connector command name (`ConnectorCommand.name`), which is the
 * command's `nativeName ?? key`; the registry is keyed by `key`, so the lookup
 * tries the name as a key directly. Unknown commands are treated as requiring
 * no special auth (the catalog only emits real commands, and agent-target
 * commands are auth-gated again inside `runCommand`).
 *
 * The lookup is scoped directly by `agentId` so concurrent connector requests
 * cannot move a shared active-store cursor underneath each other.
 */
export function resolveConnectorCommandAuth(
	agentId: string,
	name: string,
): ConnectorCommandAuth {
	const definition = findCommandByKeyForRuntime(name, agentId);
	return {
		requiresAuth: definition?.requiresAuth ?? false,
		requiresElevated: definition?.requiresElevated ?? false,
	};
}

/**
 * The single auth-gating decision both connectors share. Given a command's
 * requirements and the sender's resolved trust level, decide whether the
 * command may run — and, when it may not, produce the one refusal message
 * every connector emits. Fails closed: an unresolved sender (`isAuthorized:
 * false`) is refused for any auth-gated command.
 */
export function gateConnectorCommand(
	requirements: ConnectorCommandAuth,
	sender: ConnectorSenderAuth,
): ConnectorGateDecision {
	if (requirements.requiresAuth && !sender.isAuthorized) {
		return {
			allowed: false,
			reply:
				"This command requires authorization. Pair your account or ask an owner to run it.",
		};
	}
	if (requirements.requiresElevated && !sender.isElevated) {
		return {
			allowed: false,
			reply: "This command requires elevated permissions.",
		};
	}
	return { allowed: true };
}

/**
 * Convenience: resolve a command's requirements and gate it in one call.
 */
export function gateConnectorCommandByName(
	agentId: string,
	name: string,
	sender: ConnectorSenderAuth,
): ConnectorGateDecision {
	return gateConnectorCommand(
		resolveConnectorCommandAuth(agentId, name),
		sender,
	);
}

/**
 * The contract every connector command bridge implements. `TCommand` is the
 * connector's native command shape (Discord `SlashCommand`, Telegram
 * descriptor, …) and `TContext` is its per-invocation context (a Discord
 * interaction, a Telegraf `Context`, …). Implementations are expected to:
 *
 *   - `registerCommands()`     — project `getConnectorCommands(surface)` onto
 *                                the native command registry (deduping against
 *                                connector built-ins) and return what was
 *                                registered.
 *   - `dispatch(target, ...)`  — run a single command, branching on its target
 *                                kind, after the sender has been gated. The
 *                                bridge's auth helpers (`gateConnectorCommand`)
 *                                are applied before `dispatch` so refused
 *                                commands never reach it.
 *
 * The three target kinds behave consistently across connectors:
 *
 *   - `agent`    → run the command. Gate-safe deterministic commands
 *                  (help/status/models/usage/…) resolve to a local reply via
 *                  `resolveCommand`; option/lifecycle commands route the
 *                  reconstructed command text through the connector's message
 *                  pipeline and surface the agent reply.
 *   - `navigate` → reply with a description of the in-app destination (a deep
 *                  link); the connector cannot open the Eliza app itself.
 *   - `client`   → a local-client behavior with no remote surface; the catalog
 *                  filters these off connector surfaces, so this is defensive.
 */
export interface ConnectorCommandBridge<TCommand, TContext> {
	/** The catalog surface this bridge serves ("discord" | "telegram"). */
	readonly surface: string;

	/**
	 * Project the catalog onto the connector's native command registry and
	 * return the registered native commands. Deduping against connector
	 * built-ins is the implementation's responsibility.
	 */
	registerCommands(): TCommand[];

	/**
	 * Resolve the invoking sender's trust level from the connector's own
	 * owner/allowlist mechanism. Fails closed (unauthorized) when identity
	 * cannot be resolved.
	 */
	resolveSenderAuth(context: TContext): Promise<ConnectorSenderAuth>;

	/**
	 * Run a single command for an already-gated sender, branching on its target
	 * kind. Returns once the reply has been surfaced on the connector.
	 */
	dispatch(
		target: CommandTarget,
		context: TContext,
		sender: ConnectorSenderAuth,
	): Promise<void>;
}
