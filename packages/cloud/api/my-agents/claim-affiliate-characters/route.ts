/** Handles ownership claims for affiliate characters discovered through chats or anonymous sessions. */

import { requireUserWithOrg } from "@elizaos/cloud-shared/auth";
import {
  participantsRepository,
  roomsRepository,
  userCharactersRepository,
} from "@elizaos/cloud-shared/db/repositories";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  checkElizaMutatingRequestOrigin,
  hasElizaNonSimpleRequestMarker,
} from "@elizaos/cloud-shared/lib/auth/browser-origin-policy";
import { anonymousSessionsService } from "@elizaos/cloud-shared/lib/services/anonymous-sessions";
import { charactersService } from "@elizaos/cloud-shared/lib/services/characters";
import { usersService } from "@elizaos/cloud-shared/lib/services/users";
import { decodeOptionalRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";

const ANON_SESSION_COOKIE = "eliza-anon-session";

/**
 * POST /api/my-agents/claim-affiliate-characters
 *
 * Claims the authenticated user's own affiliate characters: characters owned
 * by the anonymous session bound to this browser. Chatting with a public
 * character never proves its creator, so room interaction alone claims
 * nothing; the anonymous session is honored ONLY from the HttpOnly cookie,
 * never from the request body, following the migrate-anonymous doctrine.
 * The cookie path is guarded like the other session mutations: exact-host
 * Origin policy plus a non-simple-request marker.
 *
 * Request body: ignored (kept for the page-load call shape).
 */
const app = new Hono<AppEnv>();

const claimAffiliateCharactersBodySchema = z.object({});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

app.post("/", async (c) => {
  try {
    const user = await requireUserWithOrg(c);

    // Cookie-bound mutation: same guards as migrate-anonymous.
    const originCheck = checkElizaMutatingRequestOrigin(
      c.req,
      c.env.NODE_ENV === "production",
    );
    if (!originCheck.ok) {
      logger.warn("[Claim Affiliate Chars] rejected cross-origin POST", {
        detail: originCheck.reason,
      });
      return c.json({ error: "Forbidden", code: "forbidden_origin" }, 403);
    }
    if (!hasElizaNonSimpleRequestMarker(c.req)) {
      return c.json({ error: "Forbidden", code: "csrf_marker_required" }, 403);
    }

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
      // The anonymous session is the caller's only proof of creator
      // identity, and it is honored ONLY from the HttpOnly cookie. A
      // session token in the request body is ignored: a leaked token must
      // not let its holder claim another session's characters.
      const cookieToken = getCookie(c, ANON_SESSION_COOKIE);
      let sessionOwnerId: string | null = null;
      let convertibleSessionId: string | null = null;
      if (cookieToken) {
        const session = await anonymousSessionsService.getByToken(cookieToken);
        if (session && !session.converted_at) {
          const sessionOwner = await usersService.getById(session.user_id);
          if (
            sessionOwner?.is_anonymous &&
            sessionOwner.email?.includes("@anonymous.elizacloud.ai")
          ) {
            sessionOwnerId = sessionOwner.id;
            // Defer conversion until after the claim calls below: converting
            // first would consume the token and turn a temporary
            // ownership-transfer failure into a permanent one.
            convertibleSessionId = session.id;
          }
        }
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

            // Room interaction alone proves nothing about creator
            // identity: only characters owned by the caller's own cookie
            // session are claimable through a room.
            const owner = await usersService.getById(char.user_id);
            if (
              sessionOwnerId !== null &&
              char.user_id === sessionOwnerId &&
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

      // Session-owned characters, from the cookie-resolved session above.
      const sessionOwnedCharacterIds = new Set<string>();

      if (sessionOwnerId !== null) {
        logger.info(
          `[Claim Affiliate Chars] Found affiliate session owner: ${sessionOwnerId}`,
        );

        // Find characters owned by this anonymous user
        const sessionCharacters =
          await userCharactersRepository.listByUser(sessionOwnerId);

        for (const char of sessionCharacters) {
          sessionOwnedCharacterIds.add(char.id);

          // Only add if not already in the list and owned by the session owner
          if (
            char.user_id === sessionOwnerId &&
            !claimableCharacters.some((c) => c.characterId === char.id)
          ) {
            claimableCharacters.push({
              characterId: char.id,
              characterName: char.name,
              ownerId: sessionOwnerId,
              roomId: "", // No room association, but we'll claim via session
            });
            logger.info(
              `[Claim Affiliate Chars] Added character from session: ${char.name}`,
            );
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
