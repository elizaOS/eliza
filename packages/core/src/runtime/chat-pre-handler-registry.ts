/**
 * Chat pre-handler registry.
 *
 * A per-agent store of {@link ChatPreHandler}s, registered from
 * `Plugin.chatPreHandlers`. `drain` runs them in descending `priority` order
 * and returns the first non-null result, mirroring the per-agent isolation of
 * the shortcut registry.
 */

import type {
	ChatPreHandler,
	ChatPreHandlerContext,
	ChatPreHandlerResult,
} from "../types/chat-pre-handler";

export class ChatPreHandlerRegistry {
	private readonly byId = new Map<string, ChatPreHandler>();

	register(handler: ChatPreHandler): void {
		this.byId.set(handler.id, handler);
	}

	registerMany(handlers: readonly ChatPreHandler[]): void {
		for (const handler of handlers) this.register(handler);
	}

	unregister(id: string): void {
		this.byId.delete(id);
	}

	clear(): void {
		this.byId.clear();
	}

	/** Handlers sorted by descending priority (ties keep insertion order). */
	list(): ChatPreHandler[] {
		return [...this.byId.values()].sort(
			(a, b) => (b.priority ?? 0) - (a.priority ?? 0),
		);
	}

	get size(): number {
		return this.byId.size;
	}

	/** Run handlers by priority; the first non-null result wins. */
	async drain(
		ctx: ChatPreHandlerContext,
	): Promise<ChatPreHandlerResult | null> {
		for (const handler of this.list()) {
			const result = await handler.tryHandle(ctx);
			if (result) return result;
		}
		return null;
	}
}
