// AI Provider utilities to switch between OpenAI and Groq

export interface AIProvider {
  name: "openai" | "groq";
  apiKey: string;
  chatEndpoint: string;
  imageEndpoint?: string;
  visionModel: string;
  chatModel: string;
  imageModel?: string;
}

export function getAIProvider(): AIProvider {
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  // Prefer Groq if available
  if (groqKey) {
    return {
      name: "groq",
      apiKey: groqKey,
      chatEndpoint: "https://api.groq.com/openai/v1/chat/completions",
      visionModel: "openai/gpt-oss-120b",
      chatModel: "openai/gpt-oss-120b",
    };
  }

  if (!openaiKey) {
    throw new Error("No AI API key configured (GROQ_API_KEY or OPENAI_API_KEY)");
  }

  return {
    name: "openai",
    apiKey: openaiKey,
    chatEndpoint: "https://api.openai.com/v1/chat/completions",
    imageEndpoint: "https://api.openai.com/v1/images/generations",
    visionModel: "gpt-5-mini",
    chatModel: "gpt-5-mini",
    imageModel: "dall-e-3",
  };
}

export function hasImageGeneration(): boolean {
  // Image generation is available if Fal or OpenAI key exists
  return !!(process.env.FAL_KEY || process.env.OPENAI_API_KEY);
}

export function getImageProvider(): AIProvider | null {
  // Prefer Fal for image generation (faster, better quality with Flux)
  const falKey = process.env.FAL_KEY;
  if (falKey) {
    return {
      name: "openai", // Using 'openai' as generic name
      apiKey: falKey,
      chatEndpoint: "",
      imageEndpoint: "fal-ai/flux/krea", // Fal model ID
      visionModel: "",
      chatModel: "",
      imageModel: "fal-flux-krea",
    };
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return null;
  }

  return {
    name: "openai",
    apiKey: openaiKey,
    chatEndpoint: "https://api.openai.com/v1/chat/completions",
    imageEndpoint: "https://api.openai.com/v1/images/generations",
    visionModel: "gpt-5-mini",
    chatModel: "gpt-5-mini",
    imageModel: "dall-e-3",
  };
}
