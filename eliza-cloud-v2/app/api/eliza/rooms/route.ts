import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKey } from "@/lib/auth";
import {
  getAnonymousUser,
  getOrCreateAnonymousUser,
} from "@/lib/auth-anonymous";
import { roomsService } from "@/lib/services/agents/rooms";
import { agentsService } from "@/lib/services/agents/agents";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { usersService } from "@/lib/services/users";
import { charactersService } from "@/lib/services/characters";

// Default agent ID - used when no character is selected
// This is the ID of the built-in Eliza character
const DEFAULT_AGENT_ID = "b850bc30-45f8-0041-a00a-83df46d8555d";

/**
 * GET /api/eliza/rooms
 * Gets all rooms for the authenticated or anonymous user with last message preview.
 * Returns rooms sorted by most recent activity.
 *
 * Single optimized query - no runtime needed
 * Returns rooms sorted by most recent activity
 *
 * Security: entityId is derived from authenticated user, not client-supplied
 */
export async function GET(request: NextRequest) {
  // Support both authenticated and anonymous users
  let userId: string;

  try {
    const authResult = await requireAuthOrApiKey(request);
    userId = authResult.user.id;
    logger.debug("[Eliza Rooms API GET] Authenticated user:", userId);
  } catch {
    // Fallback to anonymous user
    const anonData = await getAnonymousUser();
    if (!anonData) {
      // No anonymous session - return empty rooms (don't create session for GET)
      return NextResponse.json({
        success: true,
        rooms: [],
      });
    }
    userId = anonData.user.id;
    logger.debug("[Eliza Rooms API GET] Anonymous user:", userId);
  }

  // Parse query parameters
  const { searchParams } = new URL(request.url);
  const includeBuildRooms = searchParams.get("includeBuildRooms") === "true";

  // Single optimized query: rooms + last message for each room
  const rooms = await roomsService.getRoomsForEntity(userId, {
    includeBuildRooms,
  });

  return NextResponse.json({
    success: true,
    rooms,
  });
}

/**
 * POST /api/eliza/rooms
 * Creates a new chat room for the authenticated or anonymous user.
 * Supports both authenticated and anonymous users via session tokens.
 *
 * Minimal room creation - just creates room record in database
 * The runtime will handle entity/participant setup when first message is sent
 * via ensureConnection in message-handler.ts
 *
 * Security: entityId is derived from authenticated user, not client-supplied
 */
export async function POST(request: NextRequest) {
  let body: { characterId?: string; sessionToken?: string; name?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { characterId, sessionToken: bodySessionToken, name: roomName } = body;

  // Also check header for session token (anonymous users)
  const headerSessionToken = request.headers.get("X-Anonymous-Session");
  const providedSessionToken = headerSessionToken || bodySessionToken;

  // Support both authenticated and anonymous users
  let userId: string | undefined;

  try {
    const authResult = await requireAuthOrApiKey(request);
    userId = authResult.user.id;
    logger.info("[Eliza Rooms API POST] Authenticated via Privy:", userId);
  } catch (authError) {
    // Fallback to anonymous user
    logger.info(
      "[Eliza Rooms API POST] Privy auth failed, trying anonymous...",
      authError instanceof Error ? authError.message : "Unknown error",
    );

    // First try the provided session token (from URL/body)
    // This ensures we don't overwrite the session created by /api/affiliate/create-session
    if (providedSessionToken) {
      logger.info(
        "[Eliza Rooms API POST] Checking provided session token:",
        providedSessionToken.slice(0, 8) + "...",
      );
      const session =
        await anonymousSessionsService.getByToken(providedSessionToken);
      if (session) {
        const sessionUser = await usersService.getById(session.user_id);
        if (sessionUser && sessionUser.is_anonymous) {
          userId = sessionUser.id;
          logger.info(
            "[Eliza Rooms API POST] Anonymous auth via provided token:",
            userId,
          );
        }
      }
    }

    // If provided token didn't work, try the cookie
    if (!userId) {
      const anonData = await getAnonymousUser();

      if (anonData) {
        userId = anonData.user.id;
        logger.info(
          "[Eliza Rooms API POST] Anonymous auth via cookie:",
          userId,
        );
      } else {
        // No cookie found - create a new anonymous session
        logger.info(
          "[Eliza Rooms API POST] No session cookie - creating new anonymous session",
        );

        const newAnonData = await getOrCreateAnonymousUser();
        userId = newAnonData.user.id;
        logger.info(
          "[Eliza Rooms API POST] Created new anonymous session:",
          userId,
        );
      }
    }
  }

  if (!userId) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  logger.info(
    "[Eliza Rooms API POST] Creating room for user:",
    userId,
    "| characterId:",
    characterId || "default",
  );

  // Validate characterId if provided
  if (characterId && typeof characterId !== "string") {
    logger.error(
      "[Eliza Rooms API POST] Invalid characterId type:",
      typeof characterId,
    );
    return NextResponse.json(
      { error: "characterId must be a string" },
      { status: 400 },
    );
  }

  // ACCESS CONTROL: Check if user has permission to chat with this character
  // Characters are accessible if: public, owned by user, or claimable affiliate
  if (characterId && characterId !== DEFAULT_AGENT_ID) {
    const character = await charactersService.getById(characterId);

    if (!character) {
      logger.warn("[Eliza Rooms API POST] Character not found:", characterId);
      return NextResponse.json(
        { error: "Character not found" },
        { status: 404 },
      );
    }

    // Check access permissions
    const isOwner = character.user_id === userId;
    const isPublic = character.is_public === true;

    // Check if this is a claimable affiliate character
    const claimCheck =
      await charactersService.isClaimableAffiliateCharacter(characterId);
    const isClaimableAffiliate = claimCheck.claimable;

    if (!isPublic && !isOwner && !isClaimableAffiliate) {
      logger.warn(
        "[Eliza Rooms API POST] Access denied to private character:",
        {
          characterId,
          userId,
          characterOwnerId: character.user_id,
          isPublic: character.is_public,
        },
      );
      return NextResponse.json(
        { error: "Access denied - this character is private" },
        { status: 403 },
      );
    }

    logger.info(
      "[Eliza Rooms API POST] Access granted to character:",
      characterId,
      { isPublic, isOwner, isClaimableAffiliate },
    );
  }

  // Determine the agent ID - use provided characterId or default
  const agentId = characterId || DEFAULT_AGENT_ID;

  // Ensure the agent exists in the database before creating the room
  if (!characterId || characterId === DEFAULT_AGENT_ID) {
    // Ensure default Eliza agent exists in database
    await agentsService.ensureDefaultAgentExists();
  } else {
    // Ensure custom character agent exists in database
    await agentsService.ensureAgentExists(agentId);
  }

  // Create room via service (pure DB operation)
  // NOTE: We only create a minimal room record here
  // The full setup (worldId, serverId, entities, participants) happens
  // when the first message is sent via message-handler.ensureConnection()
  // This keeps room creation fast and lightweight
  const roomId = uuidv4();
  const createdAt = Date.now();

  await roomsService.createRoom({
    id: roomId,
    agentId, // Always set - either characterId or DEFAULT_AGENT_ID
    entityId: userId, // User's ID (from auth) - not used in elizaOS schema but useful for our queries
    source: "web",
    type: "DM",
    name: roomName || "New Chat",
    metadata: {
      createdAt,
      creatorUserId: userId, // Store creator for access control
    },
  });

  logger.info(
    "[Eliza Rooms API POST] ✓ Room created:",
    roomId,
    "| agentId:",
    agentId,
    "| user:",
    userId,
  );

  return NextResponse.json({
    success: true,
    roomId,
    characterId: characterId || null,
    createdAt,
  });
}
