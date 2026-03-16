import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { appsService } from "@/lib/services/apps";
import { charactersService } from "@/lib/services/characters";
import { logger } from "@/lib/utils/logger";

/**
 * GET /api/v1/apps/[id]/characters
 * Gets the characters linked to a specific app.
 * Can be called by authenticated users or via API key.
 *
 * @param request - The Next.js request object.
 * @param params - Route parameters containing the app ID.
 * @returns List of linked characters.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Allow both authenticated users and API key access
    let organizationId: string;

    try {
      const { user, apiKey } = await requireAuthOrApiKeyWithOrg(request);

      // If using API key, verify it belongs to this app
      if (apiKey) {
        const { id } = await params;
        const app = await appsService.getById(id);
        if (!app || app.api_key_id !== apiKey.id) {
          return NextResponse.json(
            { success: false, error: "Invalid API key for this app" },
            { status: 403 },
          );
        }
        organizationId = app.organization_id;
      } else {
        organizationId = user.organization_id;
      }
    } catch {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401 },
      );
    }

    const { id } = await params;

    const app = await appsService.getById(id);

    if (!app) {
      return NextResponse.json(
        { success: false, error: "App not found" },
        { status: 404 },
      );
    }

    // Verify ownership (unless accessed via the app's own API key)
    if (app.organization_id !== organizationId) {
      return NextResponse.json(
        { success: false, error: "Access denied" },
        { status: 403 },
      );
    }

    // Get the linked character IDs
    const linkedCharacterIds = (app.linked_character_ids as string[]) || [];

    if (linkedCharacterIds.length === 0) {
      return NextResponse.json({
        success: true,
        characters: [],
      });
    }

    // Fetch the character details
    const characters = await Promise.all(
      linkedCharacterIds.map(async (characterId) => {
        const character = await charactersService.getById(characterId);
        if (!character) return null;

        return {
          id: character.id,
          name: character.name,
          username: character.username,
          avatar_url: character.settings?.avatar || null,
          bio: character.bio,
          is_public: character.is_public,
        };
      }),
    );

    // Filter out any null characters (deleted)
    const validCharacters = characters.filter(Boolean);

    logger.debug("Fetched app characters", {
      appId: id,
      characterCount: validCharacters.length,
    });

    return NextResponse.json({
      success: true,
      characters: validCharacters,
    });
  } catch (error) {
    logger.error("Failed to get app characters:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get characters",
      },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/v1/apps/[id]/characters
 * Updates the characters linked to a specific app.
 * Requires ownership verification.
 *
 * @param request - Request body with character_ids array.
 * @param params - Route parameters containing the app ID.
 * @returns Updated list of linked characters.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await params;

    const existingApp = await appsService.getById(id);

    if (!existingApp) {
      return NextResponse.json(
        { success: false, error: "App not found" },
        { status: 404 },
      );
    }

    if (existingApp.organization_id !== user.organization_id) {
      return NextResponse.json(
        { success: false, error: "Access denied" },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { character_ids } = body;

    if (!Array.isArray(character_ids)) {
      return NextResponse.json(
        { success: false, error: "character_ids must be an array" },
        { status: 400 },
      );
    }

    if (character_ids.length > 4) {
      return NextResponse.json(
        { success: false, error: "Maximum 4 characters allowed per app" },
        { status: 400 },
      );
    }

    // Verify all characters exist and belong to the user
    for (const characterId of character_ids) {
      const character = await charactersService.getById(characterId);
      if (!character) {
        return NextResponse.json(
          { success: false, error: `Character not found: ${characterId}` },
          { status: 404 },
        );
      }
      // Only allow linking characters owned by the user or public characters
      if (character.user_id !== user.id && !character.is_public) {
        return NextResponse.json(
          {
            success: false,
            error: `Not authorized to link character: ${characterId}`,
          },
          { status: 403 },
        );
      }
    }

    // Update the app with the new character IDs
    await appsService.update(id, {
      linked_character_ids: character_ids,
    });

    logger.info("Updated app characters", {
      appId: id,
      userId: user.id,
      characterCount: character_ids.length,
    });

    return NextResponse.json({
      success: true,
      linked_character_ids: character_ids,
    });
  } catch (error) {
    logger.error("Failed to update app characters:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to update characters",
      },
      { status: 500 },
    );
  }
}
