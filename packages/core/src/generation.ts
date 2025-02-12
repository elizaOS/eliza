// ================ IMPORTS ================
import { z, type ZodSchema } from "zod";
import { logger } from "./index.ts";
import { parseJSONObjectFromText } from "./parsing.ts";
import {
    type Content,
    type IAgentRuntime,
    ModelClass
} from "./types.ts";

interface GenerateObjectOptions {
  runtime: IAgentRuntime;
  context: string;
  modelClass: ModelClass;
  output?: "object" | "array" | "enum" | "no-schema" | undefined;
  schema?: ZodSchema;
  schemaName?: string;
  schemaDescription?: string;
  mode?: "auto" | "json" | "tool";
  enum?: Array<string>;
  stopSequences?: string[];
}

// ================ COMMON UTILITIES ================
interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  shouldRetry?: (error: any) => boolean;
}

async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 8000,
    shouldRetry = (error: any) =>
      !(error instanceof TypeError || error instanceof SyntaxError),
  } = options;

  let retryCount = 0;
  let retryDelay = initialDelay;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      retryCount++;
      logger.error(
        `Operation failed (attempt ${retryCount}/${maxRetries}):`,
        error
      );

      if (!shouldRetry(error) || retryCount >= maxRetries) {
        throw error;
      }

      retryDelay = Math.min(retryDelay * 2, maxDelay);
      logger.debug(`Retrying in ${retryDelay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
}

/**
 * Trims the provided text context to a specified token limit using a tokenizer model and type.
 *
 * The function dynamically determines the truncation method based on the tokenizer settings
 * provided by the runtime. If no tokenizer settings are defined, it defaults to using the
 * TikToken truncation method with the "gpt-4o" model.
 *
 * @async
 * @function trimTokens
 * @param {string} context - The text to be tokenized and trimmed.
 * @param {number} maxTokens - The maximum number of tokens allowed after truncation.
 * @param {IAgentRuntime} runtime - The runtime interface providing tokenizer settings.
 *
 * @returns {Promise<string>} A promise that resolves to the trimmed text.
 *
 * @throws {Error} Throws an error if the runtime settings are invalid or missing required fields.
 *
 * @example
 * const trimmedText = await trimTokens("This is an example text", 50, runtime);
 * console.log(trimmedText); // Output will be a truncated version of the input text.
 */
export async function trimTokens(
  context: string,
  maxTokens: number,
  runtime: IAgentRuntime
) {
  if (!context) throw new Error("Trim tokens received a null context");
  
  // if context is less than of maxtokens / 5, skip
  if (context.length < (maxTokens / 5)) return context;

  if (maxTokens <= 0) throw new Error("maxTokens must be positive");

  try {
      const tokens = await runtime.useModel(ModelClass.TEXT_TOKENIZER_ENCODE, { context });

      // If already within limits, return unchanged
      if (tokens.length <= maxTokens) {
          return context;
      }

      // Keep the most recent tokens by slicing from the end
      const truncatedTokens = tokens.slice(-maxTokens);

      // Decode back to text - js-tiktoken decode() returns a string directly
      return await runtime.useModel(ModelClass.TEXT_TOKENIZER_DECODE, { tokens: truncatedTokens });
  } catch (error) {
      logger.error("Error in trimTokens:", error);
      // Return truncated string if tokenization fails
      return context.slice(-maxTokens * 4); // Rough estimate of 4 chars per token
  }
}

// ================ TEXT GENERATION FUNCTIONS ================
export async function generateText({
  runtime,
  context,
  modelClass = ModelClass.TEXT_SMALL,
  stopSequences = [],
}: {
  runtime: IAgentRuntime;
  context: string;
  modelClass: ModelClass;
  stopSequences?: string[];
  customSystemPrompt?: string;
}): Promise<string> {
  const text = await runtime.useModel(modelClass, {
    runtime,
    context,
    stopSequences,
  });

  return text;
}

export async function generateTextArray({
  runtime,
  context,
  modelClass = ModelClass.TEXT_SMALL,
  stopSequences,
}: {
  runtime: IAgentRuntime;
  context: string;
  modelClass: ModelClass;
  stopSequences?: string[];
}): Promise<string[]> {
  const result = await withRetry(async () => {
    const result = await generateObject({
      runtime,
      context,
      modelClass,
      schema: z.array(z.string()),
      stopSequences,
    });
    logger.debug("Received response from generateObject:", result);
  });

  return Array.isArray(result) ? result : [];
}

// ================ ENUM GENERATION FUNCTIONS ================
async function generateEnum<T extends string>({
  runtime,
  context,
  modelClass = ModelClass.TEXT_SMALL,
  enumValues,
  functionName,
  stopSequences,
}: {
  runtime: IAgentRuntime;
  context: string;
  modelClass: ModelClass;
  enumValues: Array<T>;
  functionName: string;
  stopSequences?: string[];
}): Promise<any> {
  const enumResult = await withRetry(async () => {
    logger.debug(
      "Attempting to generate enum value with context:",
      context
    );
    const result = await generateObject({
      runtime,
      context,
      modelClass,
      output: "enum",
      enum: enumValues,
      mode: "json",
      stopSequences: stopSequences,
    });

    logger.debug("Received enum response:", result);
    return result;
  });

  return enumResult;
}

export async function generateShouldRespond({
  runtime,
  context,
  modelClass = ModelClass.TEXT_SMALL,
  stopSequences,
}: {
  runtime: IAgentRuntime;
  context: string;
  modelClass: ModelClass;
  stopSequences?: string[];
}): Promise<"RESPOND" | "IGNORE" | "STOP" | null> {
  const RESPONSE_VALUES = ["RESPOND", "IGNORE", "STOP"] as string[];

  const result = await generateEnum({
    runtime,
    context,
    modelClass,
    enumValues: RESPONSE_VALUES,
    functionName: "generateShouldRespond",
    stopSequences,
  });

  return result as "RESPOND" | "IGNORE" | "STOP";
}

export async function generateTrueOrFalse({
  runtime,
  context = "",
  modelClass = ModelClass.TEXT_SMALL,
  stopSequences,
}: {
  runtime: IAgentRuntime;
  context: string;
  modelClass: ModelClass;
  stopSequences?: string[];
}): Promise<boolean> {
  const BOOL_VALUES = ["true", "false"];

  const result = await generateEnum({
    runtime,
    context,
    modelClass,
    enumValues: BOOL_VALUES,
    functionName: "generateTrueOrFalse",
    stopSequences,
  });

  return result === "true";
}

// ================ OBJECT GENERATION FUNCTIONS ================
export const generateObject = async ({
  runtime,
  context,
  modelClass = ModelClass.TEXT_SMALL,
  stopSequences,
}: GenerateObjectOptions): Promise<any> => {
  if (!context) {
    const errorMessage = "generateObject context is empty";
    console.error(errorMessage);
    throw new Error(errorMessage);
  }

  const { object } = await runtime.useModel(modelClass, {
    runtime,
    context,
    modelClass,
    stopSequences,
    object: true,
  });

  logger.debug(`Received Object response from ${modelClass} model.`);
  return object;
};

export async function generateObjectArray({
  runtime,
  context,
  modelClass = ModelClass.TEXT_SMALL,
  schema,
  schemaName,
  schemaDescription,
}: {
  runtime: IAgentRuntime;
  context: string;
  modelClass: ModelClass;
  schema?: ZodSchema;
  schemaName?: string;
  schemaDescription?: string;
}): Promise<z.infer<typeof schema>[]> {
  if (!context) {
    logger.error("generateObjectArray context is empty");
    return [];
  }
  const result = await generateObject({
    runtime,
    context,
    modelClass,
    output: "array",
    schema,
    schemaName,
    schemaDescription,
    mode: "json",
  });
  return schema ? schema.parse(result) : result;
}

export async function generateMessageResponse({
  runtime,
  context,
  modelClass = ModelClass.TEXT_SMALL,
  stopSequences,
}: {
  runtime: IAgentRuntime;
  context: string;
  modelClass: ModelClass;
  stopSequences?: string[];
}): Promise<Content> {
  logger.debug("Context:", context);

  return await withRetry(async () => {
    const text = await runtime.useModel(modelClass, {
    runtime,
      context,
      stop: stopSequences,
    });

    logger.info("Text:", text);

    const parsedContent = parseJSONObjectFromText(text) as Content;
    logger.info("Parsed content:", parsedContent);

    if (!parsedContent) {
      throw new Error("Failed to parse content");
    }

    return parsedContent;
  });
}