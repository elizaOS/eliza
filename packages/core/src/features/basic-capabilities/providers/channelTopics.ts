/**
 * CHANNEL_TOPICS — turn-scoped provider that surfaces the current channel's
 * topic LRU (maintained by `ChannelTopicsService`) back into Stage-1 routing.
 *
 * Renders `# Current topics in this channel: <comma-list>` when the room has
 * any recorded topics, and a no-op empty result otherwise. Opting into
 * `alwaysInResponseState` puts it into the Stage-1 response state (alongside
 * FACTS / CURRENT_TIME) so shouldRespond / the planner can weigh topic
 * relevance even on the simple direct-reply path.
 *
 * Read-only: the provider never records topics — that happens post-parse in the
 * message handler. It just reflects what the service already holds (hydrating
 * from room metadata on a cold cache after restart).
 */

import { ChannelTopicsService } from "../../../services/channel-topics.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	State,
} from "../../../types/index.ts";

const EMPTY_RESULT = { text: "", values: {}, data: {} } as const;
const UNAVAILABLE_RESULT = {
	text: "# Current topics unavailable",
	values: { channelTopicsUnavailable: true },
	data: { unavailable: true },
} as const;

export const channelTopicsProvider: Provider = {
	name: "CHANNEL_TOPICS",
	description:
		"Recent topic labels for this channel (LRU). Hint for routing/relevance; never gates action selection.",
	dynamic: true,
	position: -4,
	contexts: ["general"],
	contextGate: { anyOf: ["general"] },
	cacheStable: false,
	cacheScope: "turn",
	// Reach Stage-1 response state regardless of selected contexts, like
	// FACTS / CURRENT_TIME, so shouldRespond can weigh topic relevance.
	alwaysInResponseState: true,
	roleGate: { minRole: "USER" },

	get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
		const service = runtime.getService<ChannelTopicsService>(
			ChannelTopicsService.serviceType,
		);
		if (!service) {
			return { ...EMPTY_RESULT };
		}
		const roomId = message.roomId;
		if (!roomId) {
			return { ...EMPTY_RESULT };
		}
		let topics: string[] = [];
		try {
			topics = await service.ensureHydrated(roomId);
		} catch {
			// error-policy:J4 The service reports database failures through the
			// runtime; this explicit state keeps failure distinct from an empty LRU.
			return { ...UNAVAILABLE_RESULT };
		}
		if (topics.length === 0) {
			return { ...EMPTY_RESULT };
		}
		// Most-recent last in the LRU; show most-recent first for readability.
		const ordered = [...topics].reverse();
		const text = `# Current topics in this channel: ${ordered.join(", ")}`;
		return {
			text,
			values: { channelTopics: ordered.join(", ") },
			data: { topics: ordered },
		};
	},
};
