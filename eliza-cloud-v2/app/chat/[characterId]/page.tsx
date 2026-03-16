import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { charactersService } from "@/lib/services/characters";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { getCurrentUser } from "@/lib/auth";
import { getAnonymousUser } from "@/lib/auth-anonymous";
import { migrateAnonymousSession } from "@/lib/session";
import { ChatInterface } from "@/components/chat/chat-interface";
import { logger } from "@/lib/utils/logger";
import { resolveCharacterTheme } from "@/lib/config/affiliate-themes";
import type { UserCharacter } from "@/db/schemas";

interface ChatPageProps {
  params: Promise<{
    characterId: string;
  }>;
  searchParams: Promise<{
    source?: string;
    session?: string;
    vibe?: string;
  }>;
}

/**
 * Resolves a character from the URL parameter.
 * Supports both UUID format (direct ID) and @username format.
 *
 * @param characterIdParam - The URL parameter (UUID or @username), already URL-decoded
 * @returns The character if found, or null
 */
async function resolveCharacter(
  characterIdParam: string,
): Promise<UserCharacter | null> {
  // Check if this is a username (starts with @)
  if (characterIdParam.startsWith("@")) {
    const username = characterIdParam.slice(1); // Remove @ prefix
    logger.debug(`[Chat Page] Resolving character by username: @${username}`);

    const character = await charactersService.getByUsername(username);
    if (character) {
      logger.debug(
        `[Chat Page] Resolved @${username} to character ID: ${character.id}`,
      );
    }
    return character || null;
  }

  // Otherwise, treat as UUID
  logger.debug(`[Chat Page] Looking up character by ID: ${characterIdParam}`);
  const character = await charactersService.getById(characterIdParam);
  return character || null;
}

/**
 * Chat page for interacting with a character/agent.
 * Supports both authenticated and anonymous users.
 * Handles affiliate character claiming and session migration.
 *
 * ACCESS CONTROL:
 * - Public characters (is_public=true): Anyone can chat
 * - Private characters (is_public=false): Only owner can chat
 * - Claimable affiliate characters: Anyone can chat (ownership transfers on sign up)
 *
 * PRIVACY:
 * - Character secrets are NEVER exposed to chat users
 * - Only "shared" knowledge items are accessible publicly
 * - Billing is charged to the user who chats (not the character owner)
 *
 * URL PATTERNS:
 * - /chat/{uuid} - Direct character ID lookup
 * - /chat/@{username} - Username-based lookup (e.g., /chat/@my-cool-agent)
 *
 * @param params - Route parameters containing the character ID or @username.
 * @param searchParams - Query parameters for source, session token, and vibe.
 * @returns Chat interface component with appropriate user context.
 */
export default async function ChatPage({
  params,
  searchParams,
}: ChatPageProps) {
  const { characterId: characterIdParam } = await params;
  const { source, session: sessionId } = await searchParams;

  // URL-decode for @username check
  const decodedParam = decodeURIComponent(characterIdParam);

  // For @username URLs, redirect to the dashboard chat with resolved character ID
  // This provides the full dashboard experience (sidebar, header, etc.)
  if (decodedParam.startsWith("@")) {
    const username = decodedParam.slice(1);
    const character = await charactersService.getByUsername(username);

    if (!character) {
      logger.warn(`[Chat Page] Character not found by username: @${username}`);
      notFound();
    }

    // ACCESS CONTROL: Apply same checks as UUID path
    // Only cloud-created agents can use the cloud chat page
    if (character.source !== "cloud") {
      logger.warn(
        `[Chat Page] Character @${username} is not a cloud agent (source: ${character.source})`,
      );
      notFound();
    }

    // Check if user has access
    const user = await getCurrentUser();
    const isOwner = user && character.user_id === user.id;
    const isPublic = character.is_public === true;

    // Check if this is a claimable affiliate character
    const claimCheck = await charactersService.isClaimableAffiliateCharacter(
      character.id,
    );
    const isClaimableAffiliate = claimCheck.claimable;

    // Allow access if: character is public, user is owner, or it's a claimable affiliate character
    if (!isPublic && !isOwner && !isClaimableAffiliate) {
      logger.warn(
        `[Chat Page] Access denied to private character: @${username}`,
        {
          userId: user?.id,
          characterOwnerId: character.user_id,
          isPublic: character.is_public,
        },
      );

      // Redirect with error
      if (user) {
        redirect(
          `/dashboard/chat?error=private_character&name=${encodeURIComponent(character.name)}`,
        );
      } else {
        redirect(`/?error=private_character`);
      }
    }

    // Redirect to dashboard chat with the resolved character ID
    logger.debug(
      `[Chat Page] Redirecting @${username} to dashboard chat: ${character.id}`,
    );
    redirect(`/dashboard/chat?characterId=${character.id}`);
  }

  // 1. Resolve character from URL parameter (UUID only at this point)
  const character = await resolveCharacter(decodedParam);

  if (!character) {
    logger.warn(`[Chat Page] Character not found: ${decodedParam}`);
    notFound();
  }

  // Use the resolved character ID for all subsequent operations
  const characterId = character.id;

  // Cloud chat page only works with cloud-created agents (including affiliates)
  // Miniapp agents have their own chat interface
  if (character.source !== "cloud") {
    logger.warn(
      `[Chat Page] Character ${characterId} is not a cloud agent (source: ${character.source})`,
    );
    notFound();
  }

  // 2. ACCESS CONTROL CHECK
  // Get current user to check ownership
  const user = await getCurrentUser();

  // Determine if user has access to this character
  const isOwner = user && character.user_id === user.id;
  const isPublic = character.is_public === true;

  // Initialize claimable affiliate state with defaults to ensure they're defined in all code paths
  // These values are used for both access control (line 139) and character claiming logic (line 312)
  let isClaimableAffiliate = false;
  let claimCheck: { claimable: boolean; ownerId?: string } = {
    claimable: false,
  };

  // Check if this is a claimable affiliate character (anonymous users can still access)
  const claimCheckResult =
    await charactersService.isClaimableAffiliateCharacter(characterId);
  claimCheck = claimCheckResult;
  isClaimableAffiliate = claimCheckResult.claimable;

  // Allow access if: character is public, user is owner, or it's a claimable affiliate character
  if (!isPublic && !isOwner && !isClaimableAffiliate) {
    logger.warn(
      `[Chat Page] Access denied to private character: ${characterId}`,
      {
        userId: user?.id,
        characterOwnerId: character.user_id,
        isPublic: character.is_public,
      },
    );

    // Redirect to dashboard with error message
    // For authenticated users: redirect to their dashboard chat
    // For anonymous users: redirect to home page
    if (user) {
      redirect(
        `/dashboard/chat?error=private_character&name=${encodeURIComponent(character.name)}`,
      );
    } else {
      redirect(`/?error=private_character`);
    }
  }

  logger.debug(`[Chat Page] Access granted to character: ${characterId}`, {
    isPublic,
    isOwner,
    isClaimableAffiliate,
  });

  // 4. DYNAMIC THEME RESOLUTION
  const characterData = character.character_data as
    | Record<string, unknown>
    | undefined;
  const theme = resolveCharacterTheme(source, characterData);

  logger.debug(
    `[Chat Page] Resolved theme: ${theme.id} for character ${characterId}`,
  );

  // 5. DECISION TREE: Jump directly to chat

  // Case A: Anonymous or unauthenticated user - create session if needed and show chat
  if (!user) {
    // First check for URL-based session (for backward compatibility with affiliate links)
    const anonSession = sessionId
      ? await anonymousSessionsService.getByToken(sessionId)
      : null;

    // If URL session is valid, use it
    if (anonSession && anonSession.expires_at >= new Date()) {
      const messagesRemaining =
        anonSession.messages_limit - anonSession.message_count;
      const shouldShowSignupPrompt = anonSession.message_count >= 1; // Show after first message

      logger.info(
        `[Chat Page] Anonymous session from URL: ${sessionId} with theme ${theme.id}`,
        {
          messageCount: anonSession.message_count,
          messagesRemaining,
        },
      );

      return (
        <ChatInterface
          character={character}
          session={{
            id: anonSession.id,
            token: anonSession.session_token,
            userId: anonSession.user_id,
            messageCount: anonSession.message_count,
            messagesLimit: anonSession.messages_limit,
            messagesRemaining,
          }}
          showSignupPrompt={shouldShowSignupPrompt}
          source={source}
          sessionTokenFromUrl={anonSession.session_token}
          theme={theme}
        />
      );
    }

    // Otherwise, use cookie-based session (read-only check)
    const existingSession = await getAnonymousUser();

    if (!existingSession || !existingSession.session) {
      // No session exists - redirect to API route to create one
      // The API route will set the cookie and redirect back here
      const returnUrl = `/chat/${characterId}${source ? `?source=${source}` : ""}`;
      logger.info(
        `[Chat Page] No anonymous session found, redirecting to create one`,
      );
      redirect(
        `/api/auth/create-anonymous-session?returnUrl=${encodeURIComponent(returnUrl)}`,
      );
    }

    const { user: anonUser, session: cookieSession } = existingSession;

    const messagesRemaining =
      cookieSession.messages_limit - cookieSession.message_count;
    const shouldShowSignupPrompt = cookieSession.message_count >= 1; // Show after first message

    logger.info(
      `[Chat Page] Anonymous session from cookie with theme ${theme.id}`,
      {
        userId: anonUser.id,
        messageCount: cookieSession.message_count,
        messagesRemaining,
      },
    );

    return (
      <ChatInterface
        character={character}
        session={{
          id: cookieSession.id,
          token: cookieSession.session_token,
          userId: cookieSession.user_id,
          messageCount: cookieSession.message_count,
          messagesLimit: cookieSession.messages_limit,
          messagesRemaining,
        }}
        showSignupPrompt={shouldShowSignupPrompt}
        source={source}
        sessionTokenFromUrl={cookieSession.session_token}
        theme={theme}
      />
    );
  }

  // Case C: Authenticated user (user is guaranteed to exist here)
  logger.info(
    `[Chat Page] Authenticated user ${user.id} accessing character ${characterId} with theme ${theme.id}`,
  );

  // CRITICAL: If authenticated user has a session token in URL, migrate the anonymous session data
  // This handles the case where user was already authenticated when redirected from affiliate
  if (sessionId && user.privy_user_id) {
    logger.info(
      `[Chat Page] Authenticated user with session token - triggering server-side migration`,
      {
        sessionId,
        userId: user.id,
        privyUserId: user.privy_user_id,
      },
    );

    const anonSession = await anonymousSessionsService.getByToken(sessionId);

    if (anonSession && !anonSession.converted_at) {
      logger.info(
        `[Chat Page] Found unconverted anonymous session, migrating...`,
        {
          sessionId: anonSession.id,
          anonymousUserId: anonSession.user_id,
        },
      );

      await migrateAnonymousSession(anonSession.user_id, user.privy_user_id);

      logger.info(`[Chat Page] Migration completed successfully`);
    } else if (anonSession?.converted_at) {
      logger.info(`[Chat Page] Session already converted`, { sessionId });
    } else {
      logger.warn(`[Chat Page] Session not found for token`, {
        sessionId: sessionId.slice(0, 8) + "...",
      });
    }
  }

  // CLAIM AFFILIATE CHARACTER
  // If this is an affiliate-created character owned by an anonymous user,
  // automatically transfer ownership to the authenticated user
  // Note: We reuse the claimCheck/isClaimableAffiliate from line 137-139 to avoid duplicate database calls
  if (user.organization_id && isClaimableAffiliate) {
    logger.info(
      `[Chat Page] 🎯 Detected claimable affiliate character, initiating transfer...`,
      {
        characterId,
        userId: user.id,
        previousOwnerId: claimCheck.ownerId,
      },
    );

    const claimResult = await charactersService.claimAffiliateCharacter(
      characterId,
      user.id,
      user.organization_id,
    );

    if (claimResult.success) {
      logger.info(
        `[Chat Page] ✅ Successfully claimed affiliate character: ${characterId}`,
      );
      // Reload the character to get updated ownership
      const updatedCharacter = await charactersService.getById(characterId);
      if (updatedCharacter) {
        return (
          <ChatInterface
            character={updatedCharacter}
            user={{
              id: user.id,
              name: user.name || undefined,
              email: user.email || undefined,
            }}
            source={source}
            theme={theme}
          />
        );
      }
    } else {
      logger.warn(
        `[Chat Page] Failed to claim affiliate character: ${claimResult.message}`,
      );
    }
  }

  return (
    <ChatInterface
      character={character}
      user={{
        id: user.id,
        name: user.name || undefined,
        email: user.email || undefined,
      }}
      source={source}
      theme={theme}
    />
  );
}

// Generate metadata for SEO with theme-aware branding
// Only returns full metadata for public, claimable, or owner-viewed characters
// Supports both /chat/{uuid} and /chat/@{username} URL patterns
export async function generateMetadata({
  params,
  searchParams,
}: ChatPageProps): Promise<Metadata> {
  const { characterId: characterIdParam } = await params;
  const { source } = await searchParams;

  // URL-decode the parameter once at the entry point (@ gets encoded to %40)
  const decodedParam = decodeURIComponent(characterIdParam);

  // Resolve character from URL parameter (supports both UUID and @username)
  const character = await resolveCharacter(decodedParam);

  if (!character) {
    return {
      title: "Character Not Found",
      robots: {
        index: false,
        follow: false,
      },
    };
  }

  // Check access - show full metadata if: public, claimable, or owned by current user
  const isPublic = character.is_public === true;
  const claimCheck = await charactersService.isClaimableAffiliateCharacter(
    character.id,
  );
  const isClaimableAffiliate = claimCheck.claimable;

  // Check if current user is the owner (allows owners to see full metadata for their private chars)
  const user = await getCurrentUser();
  const isOwner = user && character.user_id === user.id;

  // For private characters that aren't claimable and not owned by viewer, return generic metadata
  // This prevents leaking character info in page title/meta tags to unauthorized users
  if (!isPublic && !isClaimableAffiliate && !isOwner) {
    return {
      title: "Chat | Eliza Cloud",
      robots: {
        index: false,
        follow: false,
      },
    };
  }

  const characterData = character.character_data as
    | Record<string, unknown>
    | undefined;
  const theme = resolveCharacterTheme(source, characterData);

  const bioText = Array.isArray(character.bio)
    ? character.bio.join(" ")
    : character.bio;

  // For public agents with usernames, use the username URL as canonical
  // This provides better SEO with human-readable URLs
  const canonicalPath = character.username
    ? `/chat/@${character.username}`
    : `/chat/${character.id}`;

  // Build the full canonical URL
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://eliza.gg";

  return {
    title: `Chat with ${character.name} | ${theme.branding.title}`,
    description: bioText.slice(0, 160),
    alternates: {
      canonical: `${baseUrl}${canonicalPath}`,
    },
    openGraph: {
      title: `Chat with ${character.name}`,
      description: bioText.slice(0, 160),
      url: `${baseUrl}${canonicalPath}`,
      type: "profile",
      images: character.avatar_url ? [character.avatar_url] : ["/og-image.png"],
    },
    twitter: {
      card: "summary_large_image",
      title: `Chat with ${character.name}`,
      description: bioText.slice(0, 160),
      images: character.avatar_url ? [character.avatar_url] : ["/og-image.png"],
    },
    // Only index public agents
    robots: isPublic
      ? { index: true, follow: true }
      : { index: false, follow: false },
  };
}
