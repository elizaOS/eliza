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

interface ReadInput {
  id: string;
  from?: number;
  lines?: number;
}

function isValidReadInput(obj: Record<string, unknown>): boolean {
  return typeof obj.id === "string" && obj.id.length > 0;
}

const EXTRACT_TEMPLATE = `Extract the scratchpad entry ID and optional line range from the user's message.

User message: {{text}}

Available scratchpad entries:
{{entries}}

Respond with XML containing:
- id: The ID of the scratchpad entry to read (required)
- from: Starting line number (optional)
- lines: Number of lines to read (optional)

<response>
<id>entry-id</id>
<from>1</from>
<lines>10</lines>
</response>`;

async function extractReadInfo(
  runtime: IAgentRuntime,
  message: Memory,
  availableEntries: string
): Promise<ReadInput | null> {
  const prompt = EXTRACT_TEMPLATE.replace("{{text}}", message.content.text ?? "").replace(
    "{{entries}}",
    availableEntries
  );

  const result = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
    stopSequences: [],
  });

  logger.debug("[ScratchpadRead] Extract result:", result);

  const parsed = parseKeyValueXml(String(result)) as Record<string, unknown> | null;

  if (!parsed || !isValidReadInput(parsed)) {
    logger.error("[ScratchpadRead] Failed to extract valid read info");
    return null;
  }

  return {
    id: String(parsed.id),
    from: parsed.from ? Number(parsed.from) : undefined,
    lines: parsed.lines ? Number(parsed.lines) : undefined,
  };
}

const spec = requireActionSpec("SCRATCHPAD_READ");

export const scratchpadReadAction: Action = {
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
          text: "There are no scratchpad entries to read. You can create one first.",
          actions: ["SCRATCHPAD_READ_EMPTY"],
          source: message.content.source,
        });
      }
      return { success: false, text: "No entries available" };
    }

    const readInfo = await extractReadInfo(runtime, message, entriesContext);

    if (!readInfo) {
      if (callback) {
        await callback({
          text: `I couldn't determine which note to read. Available entries:\n${entriesContext}`,
          actions: ["SCRATCHPAD_READ_FAILED"],
          source: message.content.source,
        });
      }
      return { success: false, text: "Failed to extract read info" };
    }

    try {
      const entry = await service.read(readInfo.id, {
        from: readInfo.from,
        lines: readInfo.lines,
      });

      const lineInfo =
        readInfo.from !== undefined
          ? ` (lines ${readInfo.from}-${(readInfo.from ?? 1) + (readInfo.lines ?? 10)})`
          : "";

      const successMessage = `**${entry.title}**${lineInfo}\n\n${entry.content}`;

      if (callback) {
        await callback({
          text: successMessage,
          actions: ["SCRATCHPAD_READ_SUCCESS"],
          source: message.content.source,
        });
      }

      return { success: true, text: successMessage, entry };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("[ScratchpadRead] Error:", errorMsg);
      if (callback) {
        await callback({
          text: `Failed to read the note: ${errorMsg}`,
          actions: ["SCRATCHPAD_READ_FAILED"],
          source: message.content.source,
        });
      }
      return { success: false, text: "Failed to read scratchpad entry" };
    }
  },

  examples: [],
};

export default scratchpadReadAction;
