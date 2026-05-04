/**
 * Default Avatar Selection from Built-in Avatars
 *
 * Uses a curated set of character avatars instead of external services.
 * All avatars are stored locally in /public/avatars/ and /public/cloud-agent-samples/
 */

/**
 * Cloud agent sample avatars for selection when creating new characters.
 */
export const CLOUD_AGENT_AVATARS = [
  "/cloud-agent-samples/2ab55b3c-25a1-4b5b-b548-045c361819e6.webp",
  "/cloud-agent-samples/2b1a6c3f-bdb8-4e67-b843-87833df422cd.webp",
  "/cloud-agent-samples/2bf035d3-d153-446a-ba15-9f87c4b8676f.webp",
  "/cloud-agent-samples/2d03e431-df85-4749-83f8-b68c43b786df.webp",
  "/cloud-agent-samples/2e41cb7a-811f-4e42-9865-ff95730d655f.webp",
  "/cloud-agent-samples/4a4f1148-a899-4286-bd51-1b0177d93e21.webp",
  "/cloud-agent-samples/4c59f69d-fe4e-4b88-bdac-fa0f5bd38934.webp",
  "/cloud-agent-samples/7ac0ef82-857f-4c71-9d13-d5e85ea64ca5.webp",
  "/cloud-agent-samples/8c9f3acc-47e5-4d2d-b059-286bac99e561.webp",
  "/cloud-agent-samples/08df48b4-3ee1-4593-9f13-fd11b9677378.webp",
  "/cloud-agent-samples/9a916762-6a48-4435-85d2-9fad525dfc5e.webp",
  "/cloud-agent-samples/9eb9d66d-9955-488f-baf2-76f5e50f93c7.webp",
  "/cloud-agent-samples/20beea15-3e44-4eca-a1db-f5c05e9f562d.webp",
  "/cloud-agent-samples/31bfcf9e-70f6-4e19-bced-bda6e24171c0.webp",
  "/cloud-agent-samples/73b9235f-9ff4-42de-a12f-0b018e4ec251.webp",
  "/cloud-agent-samples/74ac181f-00f2-49c1-872d-1b480d481bfc.webp",
  "/cloud-agent-samples/902d3591-d5ab-4b65-9344-2e7738d47ffc.webp",
  "/cloud-agent-samples/7704fd9d-e3e2-43ac-a5fa-9b5e43d373ed.webp",
  "/cloud-agent-samples/8509dafc-2bc8-4eb9-8e7a-38602cd3eb48.webp",
  "/cloud-agent-samples/78638d61-2c9c-410e-a396-cd21be9c0700.webp",
  "/cloud-agent-samples/484341c3-736a-4f15-93ba-fec779a7268e.webp",
  "/cloud-agent-samples/817925f5-ef58-4222-81ab-d98027e66094.webp",
  "/cloud-agent-samples/35697829-87cb-451e-a0cb-0f7a26c9b729.webp",
  "/cloud-agent-samples/a3a3d8bb-4510-44b3-b1c5-00055c25c160.webp",
  "/cloud-agent-samples/a7eba0a6-14bc-4fe5-b5d0-792925c2852c.webp",
  "/cloud-agent-samples/a99ecf03-26f8-4d50-8762-237d419ea1f2.webp",
  "/cloud-agent-samples/a8097634-c950-48ad-8bec-b08a810251b6_1.webp",
  "/cloud-agent-samples/aa6c7257-7962-439c-802d-a592be96b79c.webp",
  "/cloud-agent-samples/abc8888f-0854-4469-8b00-98cc879f87ba.webp",
  "/cloud-agent-samples/aeb157ed-3744-47eb-aa25-3c2e057af199.webp",
  "/cloud-agent-samples/b237d37b-73b2-488a-903d-1e6a06c1ea92.webp",
  "/cloud-agent-samples/b364f77c-599b-4dd9-ba19-e20a94b6bf3f.webp",
  "/cloud-agent-samples/b639a5c9-1cd3-4cbc-a4c5-921ca3c120b5.webp",
  "/cloud-agent-samples/beccf811-b6d9-4409-b936-36a35b9bc417.webp",
  "/cloud-agent-samples/c20b47af-2075-4c1b-8b32-8b756dea2989.webp",
  "/cloud-agent-samples/c63e72cd-6e99-4ce1-b0fe-a363f3121c5f.webp",
  "/cloud-agent-samples/cccf4c27-47fa-42f7-b00d-27ebe6fb42b8.webp",
  "/cloud-agent-samples/ce3e89ac-6376-4b96-b260-e2ac2f16e1dd.webp",
  "/cloud-agent-samples/d30bc02f-d21c-4105-b8be-cd5f44a7cf24.webp",
  "/cloud-agent-samples/d39c4a72-e294-453a-982f-12e6061c2f7e.webp",
  "/cloud-agent-samples/d2681e5d-2a8b-4498-9cf8-323b5c86a809.webp",
  "/cloud-agent-samples/ecf07f41-33d0-48c0-bbfd-e5a484c726b8.webp",
  "/cloud-agent-samples/ef67d566-87c5-4608-9700-032a6c6c8bae.webp",
  "/cloud-agent-samples/efb63574-2949-4b28-9187-ae76b1ce1be8.webp",
  "/cloud-agent-samples/fb36ddbc-b8be-43fb-9da7-71381e410010.webp",
  "/cloud-agent-samples/fee4baa8-6166-4a77-9b41-812a8b489354.webp",
] as const;

/**
 * Available character avatars for random selection when creating new characters.
 * Uses the cloud agent sample avatars for visual identity.
 */
export const CHARACTER_AVATARS = CLOUD_AGENT_AVATARS;

/**
 * The default fallback avatar used when a character has no avatar set.
 * This is the Eliza mascot avatar.
 */
export const DEFAULT_AVATAR = "/avatars/eliza.png";

/**
 * All available avatars including special ones (for UI selection purposes)
 */
export const ALL_AVATARS = [
  ...CHARACTER_AVATARS,
  "/avatars/eliza.png",
  "/avatars/amara.png",
  "/avatars/luna.png",
  "/avatars/prof_ada.png",
  "/avatars/voiceai.png",
  "/avatars/wellnesscoach.png",
  "/avatars/edad.png",
] as const;

export type AvatarStyle = "random" | "eliza";

/**
 * Generate a default avatar URL for a new character.
 * Randomly selects from the curated CHARACTER_AVATARS list.
 *
 * @param name - The character name (used for deterministic selection if needed)
 * @param options - Optional configuration
 * @returns A local avatar URL from /public/avatars/
 */
export function generateDefaultAvatarUrl(
  name?: string,
  _options: { style?: AvatarStyle } = {},
): string {
  // Use the name to create a deterministic but seemingly random selection
  // This ensures the same name always gets the same avatar
  if (name) {
    const hash = simpleHash(name);
    const index = hash % CHARACTER_AVATARS.length;
    return CHARACTER_AVATARS[index];
  }

  // Truly random selection if no name provided
  const randomIndex = Math.floor(Math.random() * CHARACTER_AVATARS.length);
  return CHARACTER_AVATARS[randomIndex];
}

/**
 * Simple hash function for deterministic avatar selection
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Get a fallback avatar URL for characters without an avatar.
 * Returns the Eliza mascot avatar.
 */
export function getFallbackAvatarUrl(): string {
  return DEFAULT_AVATAR;
}

/**
 * Check if a URL is one of our built-in avatars.
 * Used to determine if Next.js Image optimization should be applied.
 */
export function isBuiltInAvatar(url: string | null | undefined): boolean {
  if (!url) return false;
  return (
    url.startsWith("/avatars/") ||
    url.startsWith("/cloud-agent-samples/") ||
    ALL_AVATARS.some((avatar) => url.includes(avatar))
  );
}

/**
 * Get available avatar options for UI selection
 */
export function getAvailableAvatarStyles(): Array<{
  id: string;
  name: string;
  url: string;
}> {
  return CLOUD_AGENT_AVATARS.map((url, index) => {
    const filename = url.split("/").pop()?.replace(".webp", "") ?? `agent-${index}`;
    return {
      id: `cloud-${filename}`,
      name: `Agent ${index + 1}`,
      url,
    };
  });
}

/**
 * Ensure a character has an avatar URL, using the fallback if needed.
 *
 * @param avatarUrl - The character's current avatar URL (may be null/undefined/empty)
 * @param name - Optional character name for deterministic avatar selection
 * @returns A valid avatar URL (either the original or a deterministic/fallback avatar)
 */
export function ensureAvatarUrl(avatarUrl: string | null | undefined, name?: string): string {
  if (avatarUrl && avatarUrl.trim() !== "") {
    return avatarUrl;
  }
  if (name) {
    return generateDefaultAvatarUrl(name);
  }
  return DEFAULT_AVATAR;
}
