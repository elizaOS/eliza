import { Hono } from "hono";
import {
  participantsRepository,
  roomsRepository,
  userCharactersRepository,
} from "@/db/repositories";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserWithOrg } from "@/lib/auth/workers-hono-auth";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { charactersService } from "@/lib/services/characters/characters";
import { usersService } from "@/lib/services/users";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * POST /api/my-agents/claim-affiliate-characters
 *
 * Claims all affiliate characters that the authenticated user has interacted with
 * (via chat rooms) but doesn't own yet.
 *
 * This handles the case where an already-authenticated user visited an affiliate link
 * and chatted with the character before visiting the My Agents page.
 *
 * Also supports claiming via session token - if the user had an anonymous session
 * before signing up, we can find and claim characters associated with that session.
 *
 * Request body (optional):
 * {
 *   sessionToken?: string  // Anonymous session token to find associated characters
 * }
 */
const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserWithOrg(c);

    logger.info(`[Claim Affiliate Chars] Starting claim process for user ${user.id}`);

    let sessionToken: string | undefined;
    try {
      const body = (await c.req.json().catch(() => ({}))) as { sessionToken?: string };
      sessionToken = body.sessionToken;
    } catch {
      // No body or invalid JSON - that's okay
    }

    // Find affiliate characters user has interacted with via room associations
    // New architecture: entityId = userId, rooms.agentId = characterId
    const claimableCharacters: Array<{
      characterId: string;
      characterName: string;
      ownerId: string;
      roomId: string;
    }> = [];

    // Get all rooms the user participates in
    const userRoomIds = await participantsRepository.findRoomsByEntityId(user.id);

    if (userRoomIds.length > 0) {
      // Get the rooms with their agentIds (characterIds)
      const rooms = await roomsRepository.findByIds(userRoomIds);
      const characterIds = [...new Set(rooms.map((r) => r.agentId).filter(Boolean))] as string[];

      if (characterIds.length > 0) {
        // Get characters and check their owners
        for (const characterId of characterIds) {
          const char = await userCharactersRepository.findById(characterId);
          if (!char) continue;

          // Skip if user already owns this character
          if (char.user_id === user.id) continue;

          // Check if owner is an anonymous/affiliate user
          const owner = await usersService.getById(char.user_id);
          if (
            owner &&
            (owner.is_anonymous === true || owner.email?.includes("@anonymous.elizacloud.ai"))
          ) {
            const room = rooms.find((r) => r.agentId === char.id);
            claimableCharacters.push({
              characterId: char.id,
              characterName: char.name,
              ownerId: char.user_id,
              roomId: room?.id || "",
            });
          }
        }
      }
    }

    // Also find characters via session token if provided
    if (sessionToken) {
      logger.info(`[Claim Affiliate Chars] Session token provided, looking up session...`);

      const session = await anonymousSessionsService.getByToken(sessionToken);

      if (session && !session.converted_at) {
        const sessionOwner = await usersService.getById(session.user_id);

        if (
          sessionOwner &&
          sessionOwner.is_anonymous &&
          sessionOwner.email?.includes("@anonymous.elizacloud.ai")
        ) {
          logger.info(`[Claim Affiliate Chars] Found affiliate session owner: ${sessionOwner.id}`);

          // Find characters owned by this anonymous user
          const sessionCharacters = await userCharactersRepository.listByUser(sessionOwner.id);

          for (const char of sessionCharacters) {
            // Only add if not already in the list and owned by the session owner
            if (
              char.user_id === sessionOwner.id &&
              !claimableCharacters.some((c) => c.characterId === char.id)
            ) {
              claimableCharacters.push({
                characterId: char.id,
                characterName: char.name,
                ownerId: sessionOwner.id,
                roomId: "", // No room association, but we'll claim via session
              });
              logger.info(`[Claim Affiliate Chars] Added character from session: ${char.name}`);
            }
          }

          // Mark session as converted to prevent future claims
          await anonymousSessionsService.markConverted(session.id);
          logger.info(`[Claim Affiliate Chars] Marked session as converted: ${session.id}`);
        }
      }
    }

    if (claimableCharacters.length === 0) {
      logger.info(`[Claim Affiliate Chars] No claimable characters found for user ${user.id}`);
      return c.json({
        success: true,
        claimed: [],
        message: "No affiliate characters to claim",
      });
    }

    logger.info(
      `[Claim Affiliate Chars] Found ${claimableCharacters.length} claimable characters`,
      {
        characters: claimableCharacters.map((c) => ({
          id: c.characterId,
          name: c.characterName,
        })),
      },
    );

    // Claim each character
    const claimedCharacters: Array<{ id: string; name: string }> = [];
    const failedClaims: Array<{ id: string; reason: string }> = [];

    for (const char of claimableCharacters) {
      const result = await charactersService.claimAffiliateCharacter(
        char.characterId,
        user.id,
        user.organization_id,
      );

      if (result.success) {
        claimedCharacters.push({
          id: char.characterId,
          name: char.characterName,
        });
        logger.info(`[Claim Affiliate Chars] ✅ Claimed character: ${char.characterName}`);
      } else {
        failedClaims.push({ id: char.characterId, reason: result.message });
        logger.warn(
          `[Claim Affiliate Chars] ❌ Failed to claim ${char.characterName}: ${result.message}`,
        );
      }
    }

    return c.json({
      success: true,
      claimed: claimedCharacters,
      failed: failedClaims,
      message:
        claimedCharacters.length > 0
          ? `Successfully claimed ${claimedCharacters.length} character(s)`
          : "No characters were claimed",
    });
  } catch (error) {
    logger.error("[Claim Affiliate Chars] Error:", error);
    return failureResponse(c, error);
  }
});

export default app;
