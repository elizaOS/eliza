import { createOpenAI } from "@ai-sdk/openai";
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import {
  type DetokenizeTextParams,
  type GenerateTextParams,
  ModelClass,
  type TokenizeTextParams,
} from "@elizaos/core";
import { generateText as aiGenerateText } from "ai";
import { encodingForModel, type TiktokenModel } from "js-tiktoken";
import { z } from "zod";

async function tokenizeText(model: ModelClass, context: string) {
  const modelName =
    model === ModelClass.TEXT_SMALL
      ? process.env.OPENAI_SMALL_MODEL ??
        process.env.SMALL_MODEL ??
        "gpt-4o-mini"
      : process.env.LARGE_MODEL ?? "gpt-4o";
  const encoding = encodingForModel(modelName as TiktokenModel);
  const tokens = encoding.encode(context);
  return tokens;
}

async function detokenizeText(model: ModelClass, tokens: number[]) {
  const modelName =
    model === ModelClass.TEXT_SMALL
      ? process.env.OPENAI_SMALL_MODEL ??
        process.env.SMALL_MODEL ??
        "gpt-4o-mini"
      : process.env.OPENAI_LARGE_MODEL ?? process.env.LARGE_MODEL ?? "gpt-4o";
  const encoding = encodingForModel(modelName as TiktokenModel);
  return encoding.decode(tokens);
}

const configSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, "OpenAI API key is required"),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_SMALL_MODEL: z.string().optional(),
  OPENAI_LARGE_MODEL: z.string().optional(),
  SMALL_MODEL: z.string().optional(),
  LARGE_MODEL: z.string().optional(),
});

export const openaiPlugin: Plugin = {
  name: "openai",
  description: "OpenAI plugin",
  async init(config: Record<string, string>) {
    try {
      const validatedConfig = await configSchema.parseAsync(config);

      // Set all environment variables at once
      Object.entries(validatedConfig).forEach(([key, value]) => {
        if (value) process.env[key] = value;
      });

      // Verify API key
      const baseURL =
        process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
      const response = await fetch(`${baseURL}/models`, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to validate OpenAI API key: ${response.statusText}`
        );
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid plugin configuration: ${error.errors
            .map((e) => e.message)
            .join(", ")}`
        );
      }
      throw error;
    }
  },
  models: {
    [ModelClass.TEXT_EMBEDDING]: async (runtime: IAgentRuntime, text: string | null) => {
      if (!text) {
        // Return zero vector of appropriate length for model
        return new Array(1536).fill(0);
      }

      const baseURL =
        process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";

      // use fetch to call embedding endpoint
      const response = await fetch(`${baseURL}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: text,
        }),
      });
      if (!response.ok) {
        throw new Error(`Failed to get embedding: ${response.statusText}`);
      }

      const data = await response.json() as { data: [{ embedding: number[] }] };
      return data.data[0].embedding;
    },
    [ModelClass.TEXT_TOKENIZER_ENCODE]: async (
      runtime,
      {
      context,
      modelClass = ModelClass.TEXT_LARGE,
    }: TokenizeTextParams) => {
      return await tokenizeText(modelClass ?? ModelClass.TEXT_LARGE, context);
    },
    [ModelClass.TEXT_TOKENIZER_DECODE]: async (
      runtime,
      {
      tokens,
      modelClass = ModelClass.TEXT_LARGE,
    }: DetokenizeTextParams) => {
      return await detokenizeText(modelClass ?? ModelClass.TEXT_LARGE, tokens);
    },
    [ModelClass.TEXT_SMALL]: async (
      runtime,
      {
      context,
      stopSequences = [],
    }: GenerateTextParams) => {
      const temperature = 0.7;
      const frequency_penalty = 0.7;
      const presence_penalty = 0.7;
      const max_response_length = 8192;

      const baseURL =
        runtime.getSetting("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";

      const openai = createOpenAI({
        apiKey: runtime.getSetting("OPENAI_API_KEY"),
        baseURL,
      });

      const model =
        runtime.getSetting("OPENAI_SMALL_MODEL") ??
        runtime.getSetting("SMALL_MODEL") ??
        "gpt-4o-mini";

      const { text: openaiResponse } = await aiGenerateText({
        model: openai.languageModel(model),
        prompt: context,
        system: runtime.character.system ?? undefined,
        temperature: temperature,
        maxTokens: max_response_length,
        frequencyPenalty: frequency_penalty,
        presencePenalty: presence_penalty,
        stopSequences: stopSequences,
      });

      return openaiResponse;
    },
    [ModelClass.TEXT_LARGE]: async (
      runtime,
      {
      context,
      stopSequences = [],
    }: GenerateTextParams) => {
      const temperature = 0.7;
      const frequency_penalty = 0.7;
      const presence_penalty = 0.7;
      const max_response_length = 8192;

      const baseURL =
        runtime.getSetting("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";

      const openai = createOpenAI({
        apiKey: runtime.getSetting("OPENAI_API_KEY"),
        baseURL,
      });

      const smallModel =
        runtime.getSetting("OPENAI_SMALL_MODEL") ??
        runtime.getSetting("SMALL_MODEL") ??
        "gpt-4o-mini";
      const model =
        runtime.getSetting("OPENAI_LARGE_MODEL") ?? runtime.getSetting("LARGE_MODEL") ?? "gpt-4o";

      const { text: openaiResponse } = await aiGenerateText({
        model: openai.languageModel(model),
        prompt: context,
        system: runtime.character.system ?? undefined,
        temperature: temperature,
        maxTokens: max_response_length,
        frequencyPenalty: frequency_penalty,
        presencePenalty: presence_penalty,
        stopSequences: stopSequences,
      });

      return openaiResponse;
    },
    [ModelClass.IMAGE]: async (runtime, params: {
      prompt: string;
      n?: number;
      size?: string;
    }) => {
      const baseURL =
        runtime.getSetting("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
      const response = await fetch(`${baseURL}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runtime.getSetting("OPENAI_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: params.prompt,
          n: params.n || 1,
          size: params.size || "1024x1024",
        }),
      });
      if (!response.ok) {
        throw new Error(`Failed to generate image: ${response.statusText}`);
      }
      const data = await response.json();
      const typedData = data as { data: { url: string }[] };
      return typedData.data;
    },
    [ModelClass.IMAGE_DESCRIPTION]: async (runtime, imageUrl) => {
      console.log("IMAGE_DESCRIPTION")
      const baseURL =
        runtime.getSetting("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
        console.log("baseURL", baseURL)
      const openai = createOpenAI({
        apiKey: runtime.getSetting("OPENAI_API_KEY"),
        baseURL,
      });
      
      const { text } = await aiGenerateText({
        model: openai.languageModel(
          runtime.getSetting("OPENAI_SMALL_MODEL") ?? "gpt-4o-mini"
        ),
        messages: [
          {
            role: "system",
            content: "Provide a title and brief description of the image. Structure this as XML with the following syntax:\n<title>{{title}}</title>\n<description>{{description}}</description>\nReplacing the handlerbars with the actual text"
          },
          {
            role: "user",
            content: [{
              type: "image" as const,
              image: imageUrl
            }]
          }
        ],
        temperature: 0.7,
        maxTokens: 1024,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stopSequences: [],
      });
      
      const titleMatch = text.match(/<title>(.*?)<\/title>/);
      const descriptionMatch = text.match(/<description>(.*?)<\/description>/);

      if (!titleMatch || !descriptionMatch) {
        throw new Error("Could not parse title or description from response");
      }

      return {
        title: titleMatch[1],
        description: descriptionMatch[1]
      };
    },
    [ModelClass.TRANSCRIPTION]: async (runtime, audioBuffer: Buffer) => {
      console.log("audioBuffer", audioBuffer)
      const baseURL =
        runtime.getSetting("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
      const formData = new FormData();
      formData.append("file", new Blob([audioBuffer], { type: "audio/mp3" }));
      formData.append("model", "whisper-1");
      const response = await fetch(`${baseURL}/audio/transcriptions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runtime.getSetting("OPENAI_API_KEY")}`,
          // Note: Do not set a Content-Type header—letting fetch set it for FormData is best
        },
        body: formData,
      });
      if (!response.ok) {
        throw new Error(`Failed to transcribe audio: ${response.statusText}`);
      }
      const data = await response.json() as { text: string };
      return data.text;
    },
  },
  routes: [
    {
      path: "/helloworld",
      type: "GET",
      handler: async (req: any, res: any) => {
        // send a response
        res.json({
          message: "Hello World"
        });
      }
    }
  ]
};
export default openaiPlugin;
