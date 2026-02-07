import { NextRequest, NextResponse } from "next/server";
import { charactersService } from "@/lib/services/characters";
import { getCurrentUser } from "@/lib/auth";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/characters/[characterId]/public
 * Get public character info for shared links.
 * Returns limited character data (name, avatar, bio) without requiring authentication.
 * Used for displaying character info in shared chat links.
 *
 * ACCESS CONTROL:
 * - Public characters (is_public=true): Returns info to anyone
 * - Private characters: Returns info only to the owner
 * - Claimable affiliate characters: Returns info to anyone
 *
 * PRIVACY:
 * - NEVER exposes secrets
 * - NEVER exposes full knowledge data
 * - Only returns display-safe fields (name, avatar, bio, tags)
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ characterId: string }> },
) {
  const { characterId } = await params;

  try {
    const character = await charactersService.getById(characterId);

    if (!character) {
      logger.warn(`[Public Character API] Character not found: ${characterId}`);
      return NextResponse.json(
        { success: false, error: "Character not found" },
        { status: 404 },
      );
    }

    // Only return cloud-source characters (not miniapp-only characters)
    if (character.source !== "cloud") {
      return NextResponse.json(
        { success: false, error: "Character not available" },
        { status: 404 },
      );
    }

    // ACCESS CONTROL CHECK
    // Check if character is public or if user is the owner
    const user = await getCurrentUser();
    const isOwner = user && character.user_id === user.id;
    const isPublic = character.is_public === true;

    // Check if this is a claimable affiliate character
    const claimCheck =
      await charactersService.isClaimableAffiliateCharacter(characterId);
    const isClaimableAffiliate = claimCheck.claimable;

    // Only return info if: character is public, user is owner, or it's a claimable affiliate
    if (!isPublic && !isOwner && !isClaimableAffiliate) {
      logger.warn(
        `[Public Character API] Access denied to private character: ${characterId}`,
        {
          userId: user?.id,
          characterOwnerId: character.user_id,
          isPublic: character.is_public,
        },
      );
      return NextResponse.json(
        { success: false, error: "Character not available" },
        { status: 404 },
      );
    }

    // Return limited public info only
    // NEVER include secrets, settings, or full knowledge data
    const publicInfo = {
      id: character.id,
      name: character.name,
      username: character.username,
      avatarUrl: character.avatar_url,
      bio: Array.isArray(character.bio) ? character.bio[0] : character.bio,
      // Include category and tags for discovery/display purposes
      category: character.category,
      tags: character.tags,
      // Include public stats
      viewCount: character.view_count,
      interactionCount: character.interaction_count,
      // Include monetization info if enabled
      monetizationEnabled: character.monetization_enabled,
    };

    logger.debug(
      `[Public Character API] Returning public info for: ${characterId}`,
      {
        isPublic,
        isOwner,
        isClaimableAffiliate,
      },
    );

    return NextResponse.json({
      success: true,
      data: publicInfo,
    });
  } catch (error) {
    logger.error(`[Public Character API] Error fetching character:`, error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch character" },
      { status: 500 },
    );
  }
}
