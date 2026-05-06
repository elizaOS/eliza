import { elizaLogger, type IAgentRuntime, ModelType, parseToonKeyValue } from "@elizaos/core";

export interface ManagePositionsInput {
  repositionThresholdBps: number;
  intervalSeconds: number;
  slippageToleranceBps: number;
}

function readInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : null;
}

function validateManagePositionsInput(obj: Record<string, unknown>): ManagePositionsInput {
  const repositionThresholdBps = readInteger(obj.repositionThresholdBps);
  const intervalSeconds = readInteger(obj.intervalSeconds);
  const slippageToleranceBps = readInteger(obj.slippageToleranceBps);
  if (
    repositionThresholdBps === null ||
    intervalSeconds === null ||
    slippageToleranceBps === null
  ) {
    throw new Error("Invalid input: Object does not match the ManagePositionsInput type.");
  }
  return { repositionThresholdBps, intervalSeconds, slippageToleranceBps };
}

export async function extractAndValidateConfiguration(
  text: string,
  runtime: IAgentRuntime
): Promise<ManagePositionsInput | null> {
  elizaLogger.log("Extracting and validating configuration from text:", text);

  const prompt = `Given this message: "${text}". Extract the reposition threshold value, time interval, and slippage tolerance.
        The threshold value and the slippage tolerance can be given in percentages or bps. You will always respond with the reposition threshold in bps.
        Very important: Use null for each field that is not present in the message.
        Respond with TOON only using this shape:
        repositionThresholdBps: 120
        intervalSeconds: 300
        slippageToleranceBps: 50
    `;

  const content = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });

  try {
    const configuration = parseToonKeyValue<Record<string, unknown>>(content);
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
      throw new Error("Configuration must be a structured object");
    }
    return validateManagePositionsInput(configuration);
  } catch (error) {
    elizaLogger.warn(
      `Invalid configuration detected: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
