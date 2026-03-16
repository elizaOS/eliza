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

interface WriteInput {
  title: string;
  content: string;
  tags?: string[];
}

function isValidWriteInput(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.title === "string" &&
    obj.title.length > 0 &&
    typeof obj.content === "string" &&
    obj.content.length > 0
  );
}

const EXTRACT_TEMPLATE = `Extract the following information from the user's message to save to the scratchpad:

User message: {{text}}

Recent conversation:
{{messageHistory}}

Respond with XML containing:
- title: A short, descriptive title for the note (required)
- content: The main content to save (required)
- tags: Comma-separated tags for categorization (optional)

<response>
<title>The note title</title>
<content>The content to save</content>
<tags>tag1, tag2</tags>
</response>`;

async function extractWriteInfo(
  runtime: IAgentRuntime,
  message: Memory,
  _state: State
): Promise<WriteInput | null> {
  const prompt = EXTRACT_TEMPLATE.replace("{{text}}", message.content.text ?? "").replace(
    "{{messageHistory}}",
    ""
  );

  const result = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
    stopSequences: [],
  });

  logger.debug("[ScratchpadWrite] Extract result:", result);

  const parsed = parseKeyValueXml(String(result)) as Record<string, unknown> | null;

  if (!parsed || !isValidWriteInput(parsed)) {
    logger.error("[ScratchpadWrite] Failed to extract valid write info");
    return null;
  }

  const tags = parsed.tags
    ? String(parsed.tags)
        .split(",")
        .map((t: string) => t.trim())
        .filter(Boolean)
    : undefined;

  return {
    title: String(parsed.title),
    content: String(parsed.content),
    tags,
  };
}

const spec = requireActionSpec("SCRATCHPAD_WRITE");

export const scratchpadWriteAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Check for scratchpad-related intent in the message
    const text = (message.content?.text ?? "").toLowerCase();
    const hasSaveIntent =
      text.includes("save") ||
      text.includes("note") ||
      text.includes("remember") ||
      text.includes("write") ||
      text.includes("scratchpad") ||
      text.includes("jot down") ||
      text.includes("store");

    return hasSaveIntent;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    stateFromTrigger: State | undefined,
    _options: HandlerOptions | undefined,
    callback?: HandlerCallback,
    _responses?: Memory[]
  ) => {
    const state = stateFromTrigger ?? (await runtime.composeState(message, []));
    const writeInfo = await extractWriteInfo(runtime, message, state);

    if (!writeInfo) {
      if (callback) {
        await callback({
          text: "I couldn't understand what you want me to save. Please provide a clear title and content for the note.",
          actions: ["SCRATCHPAD_WRITE_FAILED"],
          source: message.content.source,
        });
      }
      return { success: false, text: "Failed to extract write info" };
    }

    try {
      const service = createScratchpadService(runtime);
      const entry = await service.write(writeInfo.title, writeInfo.content, {
        tags: writeInfo.tags,
      });

      const successMessage = `I've saved a note titled "${entry.title}" (ID: ${entry.id}).${
        entry.tags?.length ? ` Tags: ${entry.tags.join(", ")}` : ""
      } You can retrieve it later using the ID or by searching for it.`;

      if (callback) {
        await callback({
          text: successMessage,
          actions: ["SCRATCHPAD_WRITE_SUCCESS"],
          source: message.content.source,
        });
      }

      return { success: true, text: successMessage, entryId: entry.id };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("[ScratchpadWrite] Error:", errorMsg);
      if (callback) {
        await callback({
          text: `Failed to save the note: ${errorMsg}`,
          actions: ["SCRATCHPAD_WRITE_FAILED"],
          source: message.content.source,
        });
      }
      return { success: false, text: "Failed to write to scratchpad" };
    }
  },

  examples: [],
};

export default scratchpadWriteAction;
