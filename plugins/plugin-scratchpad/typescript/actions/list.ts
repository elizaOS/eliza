import {
  type Action,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import { requireActionSpec } from "../generated/specs/specs";
import { createScratchpadService } from "../services/scratchpadService";

const spec = requireActionSpec("SCRATCHPAD_LIST");

export const scratchpadListAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,

  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => {
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _stateFromTrigger: State | undefined,
    _options: HandlerOptions | undefined,
    callback?: HandlerCallback,
    _responses?: Memory[]
  ) => {
    try {
      const service = createScratchpadService(runtime);
      const entries = await service.list();

      if (entries.length === 0) {
        if (callback) {
          await callback({
            text: "You don't have any scratchpad entries yet. Use SCRATCHPAD_WRITE to create one.",
            actions: ["SCRATCHPAD_LIST_EMPTY"],
            source: message.content.source,
          });
        }
        return { success: true, text: "No entries", entries: [] };
      }

      const listText = entries
        .map((e, i) => {
          const tagsStr = e.tags?.length ? ` [${e.tags.join(", ")}]` : "";
          return `${i + 1}. **${e.title}** (${e.id})${tagsStr}\n   _Modified: ${e.modifiedAt.toLocaleDateString()}_`;
        })
        .join("\n");

      const successMessage = `**Your Scratchpad Entries** (${entries.length} total):\n\n${listText}`;

      if (callback) {
        await callback({
          text: successMessage,
          actions: ["SCRATCHPAD_LIST_SUCCESS"],
          source: message.content.source,
        });
      }

      return { success: true, text: successMessage, entries };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("[ScratchpadList] Error:", errorMsg);
      if (callback) {
        await callback({
          text: `Failed to list scratchpad entries: ${errorMsg}`,
          actions: ["SCRATCHPAD_LIST_FAILED"],
          source: message.content.source,
        });
      }
      return { success: false, text: "Failed to list scratchpad entries" };
    }
  },

  examples: [],
};

export default scratchpadListAction;
