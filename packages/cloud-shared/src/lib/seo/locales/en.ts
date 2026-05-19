/**
 * English (en) SEO copy catalog. Source of truth for shape and copy.
 */

type RouteCopy = { title: string; description: string };

export interface SeoMessages {
  siteName: string;
  defaultTitle: string;
  defaultDescription: string;
  routes: {
    home: RouteCopy;
    dashboard: RouteCopy;
    containers: RouteCopy;
    eliza: RouteCopy;
    characterCreator: RouteCopy;
    myAgents: RouteCopy;
    textGeneration: RouteCopy;
    imageGeneration: RouteCopy;
    videoGeneration: RouteCopy;
    voiceCloning: RouteCopy;
    apiExplorer: RouteCopy;
    billing: RouteCopy;
    apiKeys: RouteCopy;
    analytics: RouteCopy;
    storage: RouteCopy;
    gallery: RouteCopy;
    account: RouteCopy;
  };
}

export const seoMessages: SeoMessages = {
  siteName: "Eliza Cloud",
  defaultTitle: "Eliza Cloud — hosted runtime and dashboard for Eliza agents",
  defaultDescription:
    "Run your agent instantly in the cloud. Chat, deploy, and manage Eliza agents, connect app devices, manage API access and billing, and upgrade to elizaOS for full device control.",
  routes: {
    home: {
      title: "Eliza Cloud — hosted runtime and dashboard for Eliza agents",
      description:
        "Run your agent instantly in the cloud. Chat, deploy, and manage Eliza agents, connect app devices, manage API access and billing, and upgrade to elizaOS for full device control.",
    },
    dashboard: {
      title: "Dashboard",
      description:
        "Manage your AI agents, instances, credits, and platform resources from the Eliza Cloud dashboard.",
    },
    containers: {
      title: "Containers",
      description:
        "Deploy and manage elizaOS containers on AWS ECS. Monitor health, view logs, and scale your deployments.",
    },
    eliza: {
      title: "Chat",
      description:
        "Chat with AI agents using the full elizaOS runtime with persistent memory and room-based conversations.",
    },
    characterCreator: {
      title: "Character Creator",
      description:
        "Create custom AI characters with our AI-assisted builder. Define personality, knowledge, and behaviors for your agents.",
    },
    myAgents: {
      title: "My Agents",
      description:
        "Manage and chat with your personal AI agents. View, deploy, and chat with your characters.",
    },
    textGeneration: {
      title: "Text Generation",
      description:
        "Generate text with advanced AI models. Access GPT-4, Claude, Gemini, and more through our API.",
    },
    imageGeneration: {
      title: "Image Generation",
      description:
        "Create stunning images with Google Gemini 2.5 Flash. High-quality 1024x1024 images with automatic storage.",
    },
    videoGeneration: {
      title: "Video Generation",
      description:
        "Generate videos with Veo3, Kling v2.1, and MiniMax Hailuo. Create up to 5-minute videos with AI.",
    },
    voiceCloning: {
      title: "Voice Cloning",
      description:
        "Clone voices with ElevenLabs integration. Create custom voices for your AI agents.",
    },
    apiExplorer: {
      title: "API Explorer",
      description:
        "Explore and test Eliza Cloud APIs with interactive docs and a live testing environment.",
    },
    billing: {
      title: "Billing & Credits",
      description:
        "Manage your credits, view usage, and buy credit packs. Transparent pricing across every AI operation.",
    },
    apiKeys: {
      title: "API Keys",
      description: "Generate and manage API keys for programmatic access to Eliza Cloud.",
    },
    analytics: {
      title: "Analytics",
      description:
        "View usage analytics, track costs, and monitor performance across all your AI operations.",
    },
    storage: {
      title: "Storage",
      description:
        "Manage your files and generated content. View images, videos, and documents in R2 storage.",
    },
    gallery: {
      title: "Gallery",
      description:
        "Browse your generated images and videos. View, download, and share your AI-created content.",
    },
    account: {
      title: "Account Settings",
      description: "Manage your account settings, profile, and preferences on Eliza Cloud.",
    },
  },
};
