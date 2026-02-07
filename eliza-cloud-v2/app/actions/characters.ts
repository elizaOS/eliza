"use server";

import { requireAuthWithOrg } from "@/lib/auth";
import { logger } from "@/lib/utils/logger";
import { charactersService } from "@/lib/services/characters/characters";
import { discordService } from "@/lib/services/discord";
import { uploadToBlob } from "@/lib/blob";
import type { ElizaCharacter, NewUserCharacter } from "@/lib/types";
import { revalidatePath } from "next/cache";

/**
 * Uploads a character avatar image to blob storage.
 *
 * @param formData - Form data containing the avatar file.
 * @returns Success status with the uploaded URL, or error details.
 */
export async function uploadCharacterAvatar(formData: FormData) {
  try {
    const user = await requireAuthWithOrg();
    const file = formData.get("file") as File;

    if (!file) {
      return { success: false, error: "No file provided" };
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { url } = await uploadToBlob(buffer, {
      filename: file.name,
      contentType: file.type,
      folder: "character-avatars",
      userId: user.id,
    });

    return { success: true, url };
  } catch (error) {
    logger.error("Error uploading character avatar:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to upload avatar",
    };
  }
}

/**
 * Creates a new character for the authenticated user's organization.
 *
 * @param elizaCharacter - The character data to create.
 * @returns The created character in Eliza format.
 * @throws If the user is not authenticated or doesn't have an organization.
 */
export async function createCharacter(elizaCharacter: ElizaCharacter) {
  const user = await requireAuthWithOrg();

  // Normalize isPublic to ensure consistency between is_public column and character_data
  const isPublic =
    typeof elizaCharacter.isPublic === "boolean"
      ? elizaCharacter.isPublic
      : false;

  const newCharacter: NewUserCharacter = {
    organization_id: user.organization_id!!,
    user_id: user.id,
    name: elizaCharacter.name,
    username: elizaCharacter.username ?? null,
    system: elizaCharacter.system ?? null,
    bio: elizaCharacter.bio,
    message_examples: (elizaCharacter.messageExamples ?? []) as Record<
      string,
      unknown
    >[][],
    post_examples: elizaCharacter.postExamples ?? [],
    topics: elizaCharacter.topics ?? [],
    adjectives: elizaCharacter.adjectives ?? [],
    knowledge: elizaCharacter.knowledge ?? [],
    plugins: elizaCharacter.plugins ?? [],
    settings: elizaCharacter.settings ?? {},
    secrets: elizaCharacter.secrets ?? {},
    style: elizaCharacter.style ?? {},
    character_data: (() => {
      // Convert ElizaCharacter to Record format for database storage
      // Ensure isPublic is consistent with the is_public column
      const record: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(elizaCharacter)) {
        record[key] = value;
      }
      record.isPublic = isPublic;
      return record;
    })(),
    avatar_url: elizaCharacter.avatarUrl ?? null,
    is_template: false,
    is_public: isPublic,
    source: "cloud", // Created from main Eliza Cloud dashboard
  };

  const character = await charactersService.create(newCharacter);

  // Log to Discord (fire-and-forget)
  discordService
    .logCharacterCreated({
      characterId: character.id,
      characterName: character.name,
      userName: user.name || user.email || null,
      userId: user.id,
      organizationName: user.organization.name,
      bio: Array.isArray(elizaCharacter.bio)
        ? elizaCharacter.bio.join(" ")
        : elizaCharacter.bio,
      plugins: elizaCharacter.plugins,
    })
    .catch((error) => {
      logger.error("[CharacterCreate] Failed to log to Discord:", error);
    });

  revalidatePath("/dashboard/build");
  return charactersService.toElizaCharacter(character);
}

/**
 * Updates an existing character owned by the authenticated user.
 *
 * @param characterId - The ID of the character to update.
 * @param elizaCharacter - The updated character data.
 * @returns The updated character in Eliza format.
 * @throws If the character is not found or access is denied.
 */
export async function updateCharacter(
  characterId: string,
  elizaCharacter: ElizaCharacter,
) {
  const user = await requireAuthWithOrg();

  const updates: Partial<NewUserCharacter> = {
    name: elizaCharacter.name,
    username: elizaCharacter.username ?? null,
    system: elizaCharacter.system ?? null,
    bio: elizaCharacter.bio,
    message_examples: (elizaCharacter.messageExamples ?? []) as Record<
      string,
      unknown
    >[][],
    post_examples: elizaCharacter.postExamples ?? [],
    topics: elizaCharacter.topics ?? [],
    adjectives: elizaCharacter.adjectives ?? [],
    knowledge: elizaCharacter.knowledge ?? [],
    plugins: elizaCharacter.plugins ?? [],
    settings: elizaCharacter.settings ?? {},
    secrets: elizaCharacter.secrets ?? {},
    style: elizaCharacter.style ?? {},
    character_data: (() => {
      // Convert ElizaCharacter to Record format for database storage
      const record: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(elizaCharacter)) {
        record[key] = value;
      }
      return record;
    })(),
    avatar_url: elizaCharacter.avatarUrl ?? null,
  };

  const character = await charactersService.updateForUser(
    characterId,
    user.id,
    updates,
  );

  if (!character) {
    throw new Error("Character not found or access denied");
  }

  revalidatePath("/dashboard/build");
  return charactersService.toElizaCharacter(character);
}

/**
 * Deletes a character owned by the authenticated user.
 *
 * @param characterId - The ID of the character to delete.
 * @returns Success status.
 * @throws If the character is not found or access is denied.
 */
export async function deleteCharacter(characterId: string) {
  const user = await requireAuthWithOrg();

  const success = await charactersService.deleteForUser(characterId, user.id);

  if (!success) {
    throw new Error("Character not found or access denied");
  }

  revalidatePath("/dashboard/build");
  return { success: true };
}

/**
 * Lists all characters owned by the authenticated user.
 *
 * @returns Array of characters in Eliza format (excludes templates).
 */
export async function listCharacters() {
  const user = await requireAuthWithOrg();

  const characters = await charactersService.listByUser(user.id, {
    includeTemplates: false,
  });

  return characters.map((c) => charactersService.toElizaCharacter(c));
}

/**
 * Gets a specific character owned by the authenticated user.
 *
 * @param characterId - The ID of the character to retrieve.
 * @returns The character in Eliza format.
 * @throws If the character is not found.
 */
export async function getCharacter(characterId: string) {
  const user = await requireAuthWithOrg();

  const character = await charactersService.getByIdForUser(
    characterId,
    user.id,
  );

  if (!character) {
    throw new Error("Character not found");
  }

  return charactersService.toElizaCharacter(character);
}
