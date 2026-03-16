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

interface AppendInput {
  id: string;
  content: string;
}

function isValidAppendInput(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.id === "string" &&
    obj.id.length > 0 &&
    typeof obj.content === "string" &&
    obj.content.length > 0
  );
}

const EXTRACT_TEMPLATE = `Extract the scratchpad entry ID and content to append from the user's message.

User message: {{text}}

Available scratchpad entries:
{{entries}}

Respond with XML containing:
- id: The ID of the scratchpad entry to append to (required)
- content: The new content to append (required)

<response>
<id>entry-id</id>
<content>Content to append</content>
</response>`;

async function extractAppendInfo(
  runtime: IAgentRuntime,
  message: Memory,
  availableEntries: string
): Promise<AppendInput | null> {
  const prompt = EXTRACT_TEMPLATE.replace("{{text}}", message.content.text ?? "").replace(
    "{{entries}}",
    availableEntries
  );

  const result = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
    stopSequences: [],
  });

  logger.debug("[ScratchpadAppend] Extract result:", result);

  const parsed = parseKeyValueXml(String(result)) as Record<string, unknown> | null;

  if (!parsed || !isValidAppendInput(parsed)) {
    logger.error("[ScratchpadAppend] Failed to extract valid append info");
    return null;
  }

  return {
    id: String(parsed.id),
    content: String(parsed.content),
  };
}

const spec = requireActionSpec("SCRATCHPAD_APPEND");

export const scratchpadAppendAction: Action = {
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
          text: "There are no scratchpad entries to append to. Create one first with SCRATCHPAD_WRITE.",
          actions: ["SCRATCHPAD_APPEND_EMPTY"],
          source: message.content.source,
        });
      }
      return { success: false, text: "No entries available" };
    }

    const appendInfo = await extractAppendInfo(runtime, message, entriesContext);

    if (!appendInfo) {
      if (callback) {
        await callback({
          text: `I couldn't determine which note to update or what to add. Available entries:\n${entriesContext}`,
          actions: ["SCRATCHPAD_APPEND_FAILED"],
          source: message.content.source,
        });
      }
      return { success: false, text: "Failed to extract append info" };
    }

    try {
      // Check if entry exists
      const exists = await service.exists(appendInfo.id);
      if (!exists) {
        if (callback) {
          await callback({
            text: `Scratchpad entry "${appendInfo.id}" not found. Available entries:\n${entriesContext}`,
            actions: ["SCRATCHPAD_APPEND_NOT_FOUND"],
            source: message.content.source,
          });
        }
        return { success: false, text: "Entry not found" };
      }

      // Get existing entry to preserve title
      const existingEntry = await service.read(appendInfo.id);

      // Write with append option
      const entry = await service.write(existingEntry.title, appendInfo.content, {
        append: true,
        tags: existingEntry.tags,
      });

      const successMessage = `Successfully appended content to "${entry.title}" (${entry.id}).`;

      if (callback) {
        await callback({
          text: successMessage,
          actions: ["SCRATCHPAD_APPEND_SUCCESS"],
          source: message.content.source,
        });
      }

      return { success: true, text: successMessage, entry };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("[ScratchpadAppend] Error:", errorMsg);
      if (callback) {
        await callback({
          text: `Failed to append to the note: ${errorMsg}`,
          actions: ["SCRATCHPAD_APPEND_FAILED"],
          source: message.content.source,
        });
      }
      return { success: false, text: "Failed to append to scratchpad entry" };
    }
  },

  examples: [],
};

export default scratchpadAppendAction;
