import { createOpenAI } from "@ai-sdk/openai";

export class Inference {
  constructor(private readonly model: string) {
    this.model = model;
  }

  public static getModel(model: string) {
    switch (model) {
      case "gpt-5-mini":
        const openai = createOpenAI({
          apiKey: process.env.OPENAI_API_KEY,
        });
        return openai("gpt-5-mini");
      default:
        throw new Error(`Model ${model} not supported`);
    }
  }
}
