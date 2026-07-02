export const APP_CONFIG = {
  name: "Fake Girlfriend",
  description: "Create your AI girlfriend and exchange texts",
  url: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3012",
  maxUnauthenticatedMessages: 5, // 5 messages back and forth = 10 total
  // Default to the real cloud origin (not localhost) so a deployed container
  // without NEXT_PUBLIC_ELIZA_CLOUD_URL set still redirects to a live host
  // instead of dead-ending at localhost:3000 (#9300).
  elizaCloudUrl:
    process.env.NEXT_PUBLIC_ELIZA_CLOUD_URL || "https://elizacloud.ai",
};

export const ROUTES = {
  home: "/",
  cloning: "/cloning",
} as const;

export const STORAGE_KEYS = {
  sessionId: "cyc_session_id",
  characterId: "cyc_character_id",
  characterData: "cyc_character_data",
} as const;
