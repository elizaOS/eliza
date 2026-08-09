/**
 * The ENTITIES provider: injects the people present in the current room —
 * formatted entity details under a "People in the Room" header plus the sender's
 * resolved name — so the agent knows who it is talking to. Text content comes
 * from the centralized ENTITIES provider spec.
 */
import { formatEntities, getEntityDetails } from "../../../entities.ts";
import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
import type {
	Entity,
	IAgentRuntime,
	Memory,
	Provider,
} from "../../../types/index.ts";
import { addHeader } from "../../../utils.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("ENTITIES");

/**
 * Provider for fetching entities related to the current conversation.
 * @type { Provider }
 */
export const entitiesProvider: Provider = {
	name: spec.name,
	description: spec.description,
	dynamic: spec.dynamic ?? true,
	// "messaging" is deliberately included: on a "tell <name> …" turn the
	// planner needs to SEE who is present in the room to prefer a plain
	// in-room reply over a contact search or DM lookup for someone who is
	// standing right there (the over-routing family, with #17923 semantics).
	contexts: ["contacts", "memory", "messaging"],
	contextGate: { anyOf: ["contacts", "memory", "messaging"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (runtime: IAgentRuntime, message: Memory) => {
		const { roomId, entityId } = message;
		// Get entities details
		const entitiesData = await getEntityDetails({ runtime, roomId });
		// Format entities for display
		const formattedEntities = formatEntities({ entities: entitiesData ?? [] });
		// Find sender name
		const senderName = entitiesData?.find(
			(entity: Entity) => entity.id === entityId,
		)?.names[0];
		// Create formatted text with header
		const entities =
			formattedEntities && formattedEntities.length > 0
				? addHeader("# People in the Room", formattedEntities)
				: "";
		const data = {
			entitiesData,
			senderName,
		};

		const values = {
			entities,
		};

		return {
			data,
			values,
			text: entities,
		};
	},
};
