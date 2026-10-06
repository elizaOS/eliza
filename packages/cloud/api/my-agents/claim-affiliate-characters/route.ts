/** Handles ownership claims for affiliate characters discovered through chats or anonymous sessions. */

import { requireUserWithOrg } from "@elizaos/cloud-shared/auth";
import {
  participantsRepository,
  roomsRepository,
  userCharactersRepository,
} from "@elizaos/cloud-shared/db/repositories";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { anonymousSessionsService } from "@elizaos/cloud-shared/lib/services/anonymous-sessions";
import { charactersService } from "@elizaos/cloud-shared/lib/services/characters";
import { usersService } from "@elizaos/cloud-shared/lib/services/users";
import { decodeOptionalRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

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

const claimAffiliateCharactersBodySchema = z.object({
  sessionToken: z.string().min(1).optional(),
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

app.post("/", async (c) => {
  try {
    const user = await requireUserWithOrg(c);

    logger.info(
      `[Claim Affiliate Chars] Starting claim process for user ${user.id}`,
    );

    try {
      const decodedBody = await decodeOptionalRequestJson(c.req);
      if (!decodedBody.ok) {
        return c.json(
          {
            success: false,
            claimed: [],
            failed: [],
            message: "Invalid JSON body",
          },
          400,
        );
      }
      const parsedBody = claimAffiliateCharactersBodySchema.safeParse(
        decodedBody.value,
      );
      if (!parsedBody.success) {
        return c.json(
          {
            success: false,
            claimed: [],
            failed: [],
            message: "Invalid request data",
          },
          400,
        );
      }
      const { sessionToken } = parsedBody.data;

      // Find affiliate characters user has interacted with via room associations
      // New architecture: entityId = userId, rooms.agentId = characterId
      const claimableCharacters: Array<{
        characterId: string;
        characterName: string;
        ownerId: string;
        roomId: string;
      }> = [];

      // Get all rooms the user participates in
      const userRoomIds = await participantsRepository.findRoomsByEntityId(
        user.id,
      );

      if (userRoomIds.length > 0) {
        // Get the rooms with their agentIds (characterIds)
        const rooms = await roomsRepository.findByIds(userRoomIds);
        const characterIds = [...new Set(rooms.map((r) => r.agentId))].filter(
          isUuid,
        );

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
              (owner.is_anonymous === true ||
                owner.email?.includes("@anonymous.elizacloud.ai"))
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

      // Session claimed through its token, if the session is still retryable
      // and every session-backed claim in this attempt succeeds.
      let convertibleSessionId: string | null = null;
      const sessionOwnedCharacterIds = new Set<string>();

      // Also find characters via session token if provided
      if (sessionToken) {
        logger.info(
          `[Claim Affiliate Chars] Session token provided, looking up session...`,
        );

        const session = await anonymousSessionsService.getByToken(sessionToken);

        if (session && !session.converted_at) {
          const sessionOwner = await usersService.getById(session.user_id);

          if (
            sessionOwner?.is_anonymous &&
            sessionOwner.email?.includes("@anonymous.elizacloud.ai")
          ) {
            logger.info(
              `[Claim Affiliate Chars] Found affiliate session owner: ${sessionOwner.id}`,
            );

            // Find characters owned by this anonymous user
            const sessionCharacters = await userCharactersRepository.listByUser(
              sessionOwner.id,
            );

            for (const char of sessionCharacters) {
              sessionOwnedCharacterIds.add(char.id);

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
                logger.info(
                  `[Claim Affiliate Chars] Added character from session: ${char.name}`,
                );
              }
            }

            // Defer conversion until after the claim calls below: converting
            // first would consume the token and turn a temporary
            // ownership-transfer failure into a permanent one.
            convertibleSessionId = session.id;
          }
        }
      }

      if (claimableCharacters.length === 0) {
        logger.info(
          `[Claim Affiliate Chars] No claimable characters found for user ${user.id}`,
        );
        if (convertibleSessionId) {
          // Nothing was transferable, so conversion cannot strand a failed claim.
          await anonymousSessionsService.markConverted(convertibleSessionId);
          logger.info(
            `[Claim Affiliate Chars] Marked session as converted: ${convertibleSessionId}`,
          );
        }
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
          logger.info(
            `[Claim Affiliate Chars] ✅ Claimed character: ${char.characterName}`,
          );
        } else {
          failedClaims.push({ id: char.characterId, reason: result.message });
          logger.warn(
            `[Claim Affiliate Chars] ❌ Failed to claim ${char.characterName}: ${result.message}`,
          );
        }
      }

      // Convert the session only after every session-backed ownership transfer
      // in this attempt succeeded; a returned or thrown claim failure leaves it
      // unconverted so a retry can rediscover the remaining session characters.
      // Failures on room-discovered characters unrelated to the session do not
      // block conversion.
      const sessionBackedFailure = failedClaims.some((claim) =>
        sessionOwnedCharacterIds.has(claim.id),
      );
      if (convertibleSessionId && !sessionBackedFailure) {
        await anonymousSessionsService.markConverted(convertibleSessionId);
        logger.info(
          `[Claim Affiliate Chars] Marked session as converted: ${convertibleSessionId}`,
        );
      }

      return c.json({
        success: true,
        claimed: claimedCharacters,
        failed: failedClaims,
        // The client must keep its anonymous session token while the session
        // stays unconverted for a retry; it is the only way back to it.
        sessionRetryable: convertibleSessionId !== null && sessionBackedFailure,
        message:
          claimedCharacters.length > 0
            ? `Successfully claimed ${claimedCharacters.length} character(s)`
            : "No characters were claimed",
      });
    } catch (error) {
      logger.error(
        "[Claim Affiliate Chars] Best-effort claim sweep failed:",
        error,
      );
      return c.json({
        success: false,
        claimed: [],
        failed: [],
        message:
          "Affiliate character claim sweep could not complete. The page can continue loading.",
      });
    }
  } catch (error) {
    logger.error("[Claim Affiliate Chars] Error:", error);
    return failureResponse(c, error);
  }
});

export default app;
