import {
  type Action,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
} from "@elizaos/core";
import { requireActionSpec } from "../generated/specs/specs";
import { createScratchpadService } from "../services/scratchpadService";

interface DeleteInput {
  id: string;
}

function isValidDeleteInput(obj: Record<string, unknown>): boolean {
  return typeof obj.id === "string" && obj.id.length > 0;
}

const EXTRACT_TEMPLATE = `Extract the scratchpad entry ID to delete from the user's message.

User message: {{text}}

Available scratchpad entries:
{{entries}}

Respond with XML containing:
- id: The ID of the scratchpad entry to delete (required)

<response>
<id>entry-id</id>
</response>`;

async function extractDeleteInfo(
  runtime: IAgentRuntime,
  message: Memory,
  availableEntries: string
): Promise<DeleteInput | null> {
  const prompt = EXTRACT_TEMPLATE.replace("{{text}}", message.content.text ?? "").replace(
    "{{entries}}",
    availableEntries
  );

  const result = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
    stopSequences: [],
  });

  logger.debug("[ScratchpadDelete] Extract result:", result);

  const parsed = parseKeyValueXml(String(result)) as Record<string, unknown> | null;

  if (!parsed || !isValidDeleteInput(parsed)) {
    logger.error("[ScratchpadDelete] Failed to extract valid delete info");
    return null;
  }

  return {
    id: String(parsed.id),
  };
}

const spec = requireActionSpec("SCRATCHPAD_DELETE");

export const scratchpadDeleteAction: Action = {
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
    const service = createScratchpadService(runtime);

    // Get list of available entries for context
    const entries = await service.list();
    const entriesContext = entries.map((e) => `- ${e.id}: "${e.title}"`).join("\n");

    if (entries.length === 0) {
      if (callback) {
        await callback({
          text: "There are no scratchpad entries to delete.",
          actions: ["SCRATCHPAD_DELETE_EMPTY"],
          source: message.content.source,
        });
      }
      return { success: false, text: "No entries available" };
    }

    const deleteInfo = await extractDeleteInfo(runtime, message, entriesContext);

    if (!deleteInfo) {
      if (callback) {
        await callback({
          text: `I couldn't determine which note to delete. Available entries:\n${entriesContext}`,
          actions: ["SCRATCHPAD_DELETE_FAILED"],
          source: message.content.source,
        });
      }
      return { success: false, text: "Failed to extract delete info" };
    }

    try {
      const deleted = await service.delete(deleteInfo.id);

      if (!deleted) {
        if (callback) {
          await callback({
            text: `Scratchpad entry "${deleteInfo.id}" not found.`,
            actions: ["SCRATCHPAD_DELETE_NOT_FOUND"],
            source: message.content.source,
          });
        }
        return { success: false, text: "Entry not found" };
      }

      const successMessage = `Successfully deleted scratchpad entry "${deleteInfo.id}".`;

      if (callback) {
        await callback({
          text: successMessage,
          actions: ["SCRATCHPAD_DELETE_SUCCESS"],
          source: message.content.source,
        });
      }

      return { success: true, text: successMessage };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("[ScratchpadDelete] Error:", errorMsg);
      if (callback) {
        await callback({
          text: `Failed to delete the note: ${errorMsg}`,
          actions: ["SCRATCHPAD_DELETE_FAILED"],
          source: message.content.source,
        });
      }
      return { success: false, text: "Failed to delete scratchpad entry" };
    }
  },

  examples: [],
};

export default scratchpadDeleteAction;
