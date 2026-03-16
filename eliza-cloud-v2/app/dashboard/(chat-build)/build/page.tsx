import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth";
import { BuildPageClient } from "@/components/chat/build-page-client";
import { listCharacters } from "@/app/actions/characters";
import { generatePageMetadata, ROUTE_METADATA } from "@/lib/seo";
import { logger } from "@/lib/utils/logger";

interface PageProps {
  searchParams: Promise<{ characterId?: string }>;
}

// Force dynamic rendering since we use server-side auth (cookies)
export const dynamic = "force-dynamic";

/**
 * Generates metadata for the build page.
 *
 * @returns Metadata object with title and description for the build page.
 */
export async function generateMetadata(): Promise<Metadata> {
  return generatePageMetadata({
    ...ROUTE_METADATA.eliza,
    path: "/dashboard/build",
    noIndex: true,
  });
}

/**
 * Build page for creating and configuring AI agents/characters.
 * Supports both authenticated and anonymous users.
 *
 * ACCESS CONTROL: Build mode only allows editing your own characters.
 * If a characterId is provided that the user doesn't own, it's ignored.
 *
 * @param searchParams - Search parameters, including optional `characterId` for editing an existing character.
 * @returns The rendered build page client component with initial characters and character ID.
 */
export default async function BuildPage({ searchParams }: PageProps) {
  // Check if user is authenticated
  const user = await getCurrentUser();
  const isAnonymous = !user;

  // Load available characters for authenticated users only
  const characters = isAnonymous ? [] : await listCharacters();

  // Get URL params
  const params = await searchParams;
  let initialCharacterId = params.characterId;

  // ACCESS CONTROL: Only allow editing characters the user owns
  // If characterId is provided but user doesn't own it, clear it
  if (initialCharacterId) {
    const isOwnCharacter = characters.some((c) => c.id === initialCharacterId);
    if (!isOwnCharacter) {
      logger.warn(
        `[Build Page] User doesn't own character ${initialCharacterId}, clearing characterId`,
        { userId: user?.id },
      );
      initialCharacterId = undefined;
    }
  }

  return (
    <BuildPageClient
      initialCharacters={characters}
      isAuthenticated={!isAnonymous}
      userId={user?.id || null}
      initialCharacterId={initialCharacterId}
    />
  );
}
