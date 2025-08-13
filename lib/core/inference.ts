import { createOpenAI } from "@ai-sdk/openai";

export class Inference {
  constructor(private readonly model: string) {
    this.model = model;
  }

  public static getModel(model: string) {
    switch (model) {
      case "gpt-5-mini":
        const gpt5Mini = createOpenAI({
          apiKey: process.env.OPENAI_API_KEY,
        });
        return gpt5Mini("gpt-5-mini");
      case "gpt-5-nano":
        const gpt5Nano = createOpenAI({
          apiKey: process.env.OPENAI_API_KEY,
        });
        return gpt5Nano("gpt-5-nano");
      case "gpt-4o-mini":
        const gpt4oMini = createOpenAI({
          apiKey: process.env.OPENAI_API_KEY,
        });
        return gpt4oMini("gpt-4o-mini");
      default:
        throw new Error(`Model ${model} not supported`);
    }
  }
}
