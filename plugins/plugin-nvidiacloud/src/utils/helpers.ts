import { logger } from '@elizaos/core';
import { JSONParseError } from 'ai';

export function getJsonRepairFunction(): (params: {
  text: string;
  error: unknown;
}) => Promise<string | null> {
  return async ({ text, error }: { text: string; error: unknown }) => {
    try {
      if (error instanceof JSONParseError) {
        const cleanedText = text.replace(/```json\n|\n```|```/g, '');
        JSON.parse(cleanedText);
        return cleanedText;
      }
      return null;
    } catch (jsonError: unknown) {
      const message = jsonError instanceof Error ? jsonError.message : String(jsonError);
      logger.warn(`Failed to repair JSON text: ${message}`);
      return null;
    }
  };
}

export async function handleObjectGenerationError(error: unknown): Promise<Record<string, unknown>> {
  if (error instanceof JSONParseError) {
    logger.error(`[generateObject] Failed to parse JSON: ${error.message}`);
    const repairFunction = getJsonRepairFunction();
    const repairedJsonString = await repairFunction({
      text: error.text,
      error,
    });

    if (repairedJsonString) {
      try {
        const repairedObject = JSON.parse(repairedJsonString);
        logger.log('[generateObject] Successfully repaired JSON.');
        return repairedObject;
      } catch (repairParseError: unknown) {
        const message =
          repairParseError instanceof Error ? repairParseError.message : String(repairParseError);
        logger.error(`[generateObject] Failed to parse repaired JSON: ${message}`);
        if (repairParseError instanceof Error) throw repairParseError;
        throw Object.assign(new Error(message), { cause: repairParseError });
      }
    } else {
      logger.error('[generateObject] JSON repair failed.');
      throw error;
    }
  } else {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[generateObject] Unknown error: ${message}`);
    if (error instanceof Error) throw error;
    throw Object.assign(new Error(message), { cause: error });
  }
}
