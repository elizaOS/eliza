/**
 * SEO constants for site-wide metadata configuration.
 */
export const SEO_CONSTANTS = {
  siteName: "Eliza Cloud",
  twitterHandle: "@elizaos",
  defaultTitle: "Eliza Cloud - Managed Hosting for AI Agents",
  defaultDescription:
    "Managed hosting, provisioning, billing, and deployment for AI agents on Eliza Cloud.",
  defaultKeywords: [
    "AI",
    "agents",
    "elizaOS",
    "platform",
    "development",
    "hosting",
    "machine learning",
    "artificial intelligence",
    "LLM",
    "deployment",
  ],
  ogImageDimensions: {
    width: 1200,
    height: 630,
  },
  twitterCardType: "summary_large_image" as const,
  locale: "en_US",
} as const;

/**
 * Route-specific metadata configurations.
 */
export const ROUTE_METADATA = {
  home: {
    title: "Eliza Cloud - Managed Hosting for AI Agents",
    description:
      "Managed hosting, provisioning, billing, and deployment for AI agents on Eliza Cloud.",
    keywords: ["AI platform", "agent development", "elizaOS", "AI hosting", "LLM deployment"],
  },
  dashboard: {
    title: "Dashboard",
    description:
      "Manage your AI agents, instances, credits, and platform resources from the Eliza Cloud dashboard.",
    keywords: ["dashboard", "AI management", "Eliza Cloud dashboard"],
  },
  containers: {
    title: "Containers",
    description:
      "Deploy and manage elizaOS containers on AWS ECS. Monitor health, view logs, and scale your deployments.",
    keywords: ["containers", "deployment", "AWS ECS", "Docker", "elizaOS deploy"],
  },
  eliza: {
    title: "Chat",
    description:
      "Chat with AI agents using the full elizaOS runtime with persistent memory and room-based conversations.",
    keywords: ["Chat", "AI chat", "elizaOS runtime", "AI agent"],
  },
  characterCreator: {
    title: "Character Creator",
    description:
      "Create custom AI characters with our AI-assisted builder. Define personality, knowledge, and behaviors for your agents.",
    keywords: ["character creator", "AI characters", "agent builder", "elizaOS characters"],
  },
  myAgents: {
    title: "My Agents",
    description:
      "Manage and interact with your personal AI agents. View, deploy, and chat with your characters.",
    keywords: ["my agents", "personal agents", "AI characters", "agent management"],
  },
  textGeneration: {
    title: "Text Generation",
    description:
      "Generate text with advanced AI models. Access GPT-4, Claude, Gemini, and more through our API.",
    keywords: ["text generation", "GPT-4", "Claude", "AI writing", "LLM API"],
  },
  imageGeneration: {
    title: "Image Generation",
    description:
      "Create stunning images with Google Gemini 2.5 Flash. High-quality 1024x1024 images with automatic storage.",
    keywords: ["image generation", "AI images", "Gemini", "AI art", "image AI"],
  },
  videoGeneration: {
    title: "Video Generation",
    description:
      "Generate videos with Veo3, Kling v2.1, and MiniMax Hailuo. Create up to 5-minute videos with AI.",
    keywords: ["video generation", "AI video", "Veo3", "Kling", "video AI"],
  },
  voiceCloning: {
    title: "Voice Cloning",
    description:
      "Clone voices with ElevenLabs integration. Create custom voices for your AI agents.",
    keywords: ["voice cloning", "ElevenLabs", "voice AI", "TTS", "voice synthesis"],
  },
  apiExplorer: {
    title: "API Explorer",
    description:
      "Explore and test Eliza Cloud APIs with interactive documentation and a live testing environment.",
    keywords: ["API explorer", "API docs", "REST API", "Eliza Cloud API"],
  },
  billing: {
    title: "Billing & Credits",
    description:
      "Manage your credits, view usage, and purchase credit packs. Transparent pricing for all AI operations.",
    keywords: ["billing", "credits", "pricing", "payment", "Stripe"],
  },
  apiKeys: {
    title: "API Keys",
    description: "Generate and manage API keys for programmatic access to Eliza Cloud.",
    keywords: ["API keys", "authentication", "API access", "tokens"],
  },
  analytics: {
    title: "Analytics",
    description:
      "View usage analytics, track costs, and monitor performance across all your AI operations.",
    keywords: ["analytics", "usage tracking", "metrics", "monitoring"],
  },
  storage: {
    title: "Storage",
    description:
      "Manage your files and generated content. View images, videos, and documents in R2 storage.",
    keywords: ["storage", "files", "R2", "cloud storage"],
  },
  gallery: {
    title: "Gallery",
    description:
      "Browse your generated images and videos. View, download, and share your AI-created content.",
    keywords: ["gallery", "generated images", "AI art", "content library"],
  },
  account: {
    title: "Account Settings",
    description: "Manage your account settings, profile, and preferences on Eliza Cloud.",
    keywords: ["account", "settings", "profile", "preferences"],
  },
} as const;
